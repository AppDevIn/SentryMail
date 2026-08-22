import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { effectiveRisk, parseSender } from "./format";
import type {
  AccountDto,
  ApiFolder,
  AttachmentDto,
  EmailCounts,
  EmailDto,
  Folder,
  FolderCounts,
  LabelDto,
  ListFilter,
  ListSort,
  ModelStatus,
  SearchResultDto,
  SyncProgressEvent,
  TriageProgressEvent,
  TriageResult,
  MeetingDto,
  MeetingScanProgressEvent,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { Compose } from "./components/Compose";
import { SettingsPanel } from "./components/SettingsPanel";
import { CalendarMonth } from "./components/CalendarMonth";
import { AttachmentPreview } from "./components/AttachmentPreview";
import { VoiceDock } from "./components/VoiceControls";
import { VOICE_HELP, commandFromModelIntent, describeInboxForSpeech, speak, stopSpeaking, type ReadPart, type VoiceCommand } from "./voice";
import "./App.css";

const PAGE_SIZE = 100;
/** Background sync cadence. Incremental (history API) syncs are cheap, so this can be short. */
const AUTO_SYNC_MS = 5 * 60 * 1000;
/** Search runs this long after the last keystroke (and immediately on Enter). ADR 0006. */
const SEARCH_DEBOUNCE_MS = 200;
/** Most results one search returns. ADR 0006. */
const SEARCH_RESULT_CAP = 50;
/** Below this width the three panes collapse to list-or-reading (ADR 0008). */
const NARROW_MAX_PX = 1100;

const EMPTY_FOLDER_COUNTS: FolderCounts = { inbox_total: 0, inbox_unread: 0, quarantine: 0, flagged: 0, archive: 0 };

/** What the reading pane shows. */
type Pane = { kind: "empty" } | { kind: "thread"; emailId: number } | { kind: "compose" };

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_MAX_PX);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_MAX_PX - 1}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

function App() {
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [emails, setEmails] = useState<EmailDto[]>([]);
  const [counts, setCounts] = useState<EmailCounts>({ total: 0, unread: 0 });
  const [folderCounts, setFolderCounts] = useState<FolderCounts>(EMPTY_FOLDER_COUNTS);
  const [extraEmails, setExtraEmails] = useState<Record<number, EmailDto>>({});
  const [triageByEmail, setTriageByEmail] = useState<Record<number, TriageResult>>({});
  const [pane, setPane] = useState<Pane>({ kind: "empty" });
  // The attachment preview covers the reading pane. It lives here, not in EmailDetail, because
  // the pane belongs to App while the click that opens it starts three levels down.
  const [preview, setPreview] = useState<{ emailId: number; attachment: AttachmentDto } | null>(null);
  const [folder, setFolder] = useState<Folder>("inbox");
  const folderRef = useRef<Folder>("inbox");
  folderRef.current = folder;
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const selectedLabelRef = useRef<string | null>(null);
  selectedLabelRef.current = selectedLabelId;
  const [filter, setFilter] = useState<ListFilter>("all");
  const [sort, setSort] = useState<ListSort>("newest");
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: "not_configured" });
  const [embedModelStatus, setEmbedModelStatus] = useState<ModelStatus>({ state: "not_configured" });
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Search: `searchInput` is the box text; `searchQuery` is the query the current results are for.
  // `searchResults === null` means "not searching"; `[]` means "searched, no hits".
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultDto[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  // Last request wins: every new search bumps this and stale responses are dropped.
  const searchReq = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const syncingRef = useRef(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const [analysisErrors, setAnalysisErrors] = useState<Record<number, string>>({});
  const [meetings, setMeetings] = useState<MeetingDto[]>([]);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [scanningMeetings, setScanningMeetings] = useState(false);
  // Read inside autoSync, which is bound to an interval and must not re-arm on every change.
  const modelReadyRef = useRef(false);
  const calendarMonthRef = useRef<Date>(new Date());
  const scanningRef = useRef(false);
  const [meetingScanProgress, setMeetingScanProgress] = useState<
    { done: number; total: number; found: number } | null
  >(null);
  // Emails we already auto-analyzed on open this session - don't keep retrying a failure.
  const autoAnalyzed = useRef<Set<number>>(new Set());
  // How many rows are currently loaded, so refreshes keep the same depth.
  const loadedRef = useRef(0);
  const scopeWarned = useRef(false);
  const narrow = useNarrow();
  // Spoken commands aimed at the open email are delivered as counters the detail view reacts to.
  const [readAloudSignal, setReadAloudSignal] = useState(0);
  const [readAloudPart, setReadAloudPart] = useState<ReadPart>("body");
  const [replySignal, setReplySignal] = useState(0);
  const [replyInstructions, setReplyInstructions] = useState<string | null>(null);

  /**
   * The folder value the API expects for the current view: label views ignore archiving
   * (ADR 0010), and `calendar` is a meetings view rather than a mail folder, so mail requests
   * made while it is open stay on the inbox.
   */
  const toApiFolder = (f: Folder): ApiFolder => (f === "calendar" ? "inbox" : f);
  const apiFolder = useCallback((): ApiFolder => (selectedLabelRef.current ? "all" : toApiFolder(folderRef.current)), []);

  const loadTriage = useCallback(async (list: EmailDto[]) => {
    const results = await Promise.all(list.map((e) => api.getTriageResult(e.id)));
    const byId: Record<number, TriageResult> = {};
    list.forEach((e, i) => {
      const result = results[i];
      if (result) byId[e.id] = result;
    });
    setTriageByEmail((prev) => ({ ...prev, ...byId }));
  }, []);

  const refreshCounts = useCallback(
    async (accountId: number | null) => {
      const [view, folders] = await Promise.all([
        api.emailCounts(accountId ?? undefined, selectedLabelRef.current, apiFolder()),
        api.folderCounts(accountId ?? undefined),
      ]);
      setCounts(view);
      setFolderCounts(folders);
    },
    [apiFolder],
  );

  const refreshLabels = useCallback(async (accountId: number | null) => {
    setLabels(await api.listLabels(accountId ?? undefined));
  }, []);

  const refreshEmails = useCallback(
    async (accountId: number | null) => {
      const limit = Math.max(PAGE_SIZE, loadedRef.current);
      const list = await api.listEmails(accountId ?? undefined, limit, 0, selectedLabelRef.current, apiFolder());
      loadedRef.current = list.length;
      setEmails(list);
      await Promise.all([loadTriage(list), refreshCounts(accountId)]);
    },
    [apiFolder, loadTriage, refreshCounts],
  );

  const loadOlder = useCallback(async () => {
    setLoadingMore(true);
    try {
      const more = await api.listEmails(selectedAccountId ?? undefined, PAGE_SIZE, loadedRef.current, selectedLabelRef.current, apiFolder());
      setEmails((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const merged = [...prev, ...more.filter((e) => !seen.has(e.id))];
        loadedRef.current = merged.length;
        return merged;
      });
      await loadTriage(more);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [selectedAccountId, apiFolder, loadTriage]);

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    api.modelStatus().then(setModelStatus).catch((e) => setError(String(e)));
    api.embeddingModelStatus().then(setEmbedModelStatus).catch((e) => setError(String(e)));

    const unlistenStatus = listen<ModelStatus>("triage-model-status", (e) => setModelStatus(e.payload));
    const unlistenEmbedStatus = listen<ModelStatus>("embed-model-status", (e) => setEmbedModelStatus(e.payload));
    const unlistenProgress = listen<TriageProgressEvent>("triage-progress", (e) => {
      const p = e.payload;
      if (p.result) setTriageByEmail((prev) => ({ ...prev, [p.email_id]: p.result! }));
      setProgress(p.done >= p.total ? null : { done: p.done, total: p.total });
    });
    const unlistenSync = listen<SyncProgressEvent>("sync-progress", (e) => {
      setSyncProgress(e.payload.phase === "done" ? null : e.payload);
    });

    return () => {
      unlistenStatus.then((f) => f());
      unlistenEmbedStatus.then((f) => f());
      unlistenProgress.then((f) => f());
      unlistenSync.then((f) => f());
    };
  }, []);

  useEffect(() => {
    // The calendar is a meetings view and renders no mail, so reloading the message list for it
    // is pure waste - and not cheap waste: refreshEmails re-fetches a page of mail and then
    // issues one getTriageResult IPC call *per email* (see loadTriage), each taking the DB
    // mutex. That is ~100 round trips to populate a list the calendar never shows, which is
    // what made opening the tab lag far more than the rest of the app.
    if (folder === "calendar" && !selectedLabelId) {
      // Counts still refresh so the sidebar badges stay live while the calendar is open.
      refreshCounts(selectedAccountId).catch(() => {});
      return;
    }
    loadedRef.current = 0;
    refreshEmails(selectedAccountId).catch((e) => setError(String(e)));
  }, [selectedAccountId, selectedLabelId, folder, refreshEmails, refreshCounts]);

  useEffect(() => {
    refreshLabels(selectedAccountId).catch(() => {});
  }, [selectedAccountId, accounts.length, lastSyncedAt, refreshLabels]);

  // While a long sync is downloading, pull new rows in as they land so the inbox fills live:
  // right after the first handful, then every 25 messages. The backend reports in steps of 5.
  useEffect(() => {
    if (!syncProgress) return;
    if (syncProgress.phase !== "fetching" && syncProgress.phase !== "backfill") return;
    if (syncProgress.done === 5 || syncProgress.done % 25 === 0) {
      refreshEmails(selectedAccountId).catch(() => {});
    }
  }, [syncProgress, selectedAccountId, refreshEmails]);

  const selectedEmailId = pane.kind === "thread" ? pane.emailId : null;
  // Navigating to another message (or closing the pane) drops the preview, so you can never
  // return from it into a conversation you have already left.
  useEffect(() => {
    setPreview(null);
  }, [selectedEmailId]);

  // Search results can reference emails outside the loaded window; fetch on demand.
  useEffect(() => {
    if (selectedEmailId && !emails.some((e) => e.id === selectedEmailId) && !extraEmails[selectedEmailId]) {
      api.getEmail(selectedEmailId).then((e) => {
        if (e) setExtraEmails((prev) => ({ ...prev, [e.id]: e }));
      });
      api.getTriageResult(selectedEmailId).then((t) => {
        if (t) setTriageByEmail((prev) => ({ ...prev, [selectedEmailId]: t }));
      });
    }
  }, [selectedEmailId, emails, extraEmails]);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // --- Search (ADR 0004/0006): scoped to the current view, debounced as you type, last request wins.
  const cancelPendingSearch = useCallback(() => {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    searchReq.current += 1;
  }, []);

  /** Back to the normal list: empties the box and drops any in-flight or pending request. */
  const clearSearch = useCallback(() => {
    cancelPendingSearch();
    setSearchInput("");
    setSearchQuery("");
    setSearchResults(null);
    setSearchLoading(false);
  }, [cancelPendingSearch]);

  const runSearch = useCallback(
    async (text: string) => {
      const query = text.trim();
      if (!query) {
        cancelPendingSearch();
        setSearchQuery("");
        setSearchResults(null);
        setSearchLoading(false);
        return;
      }
      const id = ++searchReq.current;
      setSearchLoading(true);
      try {
        const results = await api.search(
          query,
          { accountId: selectedAccountId ?? undefined, labelId: selectedLabelId, dangerOnly: folder === "quarantine" },
          SEARCH_RESULT_CAP,
        );
        if (id !== searchReq.current) return; // a newer search superseded this one
        setSearchResults(results);
        setSearchQuery(query);
      } catch (e) {
        if (id === searchReq.current) setError(String(e));
      } finally {
        if (id === searchReq.current) setSearchLoading(false);
      }
    },
    [cancelPendingSearch, selectedAccountId, selectedLabelId, folder],
  );

  const onSearchInput = useCallback(
    (text: string) => {
      setSearchInput(text);
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
      if (!text.trim()) {
        runSearch("");
        return;
      }
      setSearchLoading(true);
      searchTimer.current = window.setTimeout(() => {
        searchTimer.current = null;
        runSearch(text);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  const onSearchSubmit = useCallback(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
    runSearch(searchInput);
  }, [runSearch, searchInput]);

  useEffect(() => () => cancelPendingSearch(), [cancelPendingSearch]);

  const setRead = useCallback(
    (emailId: number, isRead: boolean) => {
      // Read state is per conversation; patch the whole thread locally.
      const patch = (e: EmailDto, threadId: string | null) =>
        e.id === emailId || (threadId !== null && e.gmail_thread_id === threadId)
          ? { ...e, is_read: isRead, thread_unread: isRead ? 0 : Math.max(1, e.thread_unread) }
          : e;
      setEmails((prev) => {
        const target = prev.find((e) => e.id === emailId);
        return prev.map((e) => patch(e, target?.gmail_thread_id ?? null));
      });
      setExtraEmails((prev) => (prev[emailId] ? { ...prev, [emailId]: patch(prev[emailId], null) } : prev));
      api
        .setRead(emailId, isRead)
        .then((r) => {
          refreshCounts(selectedAccountId).catch(() => {});
          if (r.warning && !scopeWarned.current) {
            scopeWarned.current = true; // once per session is enough
            setNotice(r.warning);
          }
        })
        .catch((e) => setError(String(e)));
    },
    [refreshCounts, selectedAccountId],
  );

  // The visible month as a half-open [from, to) range of local wall-clock ISO strings.
  // Meetings are stored as the email stated them (no timezone), so this compares as text
  // rather than going through Date, which would shift them by the browser's offset.
  const monthRange = useCallback((m: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const from = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-01T00:00`;
    const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    const to = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-01T00:00`;
    return { from, to };
  }, []);

  const refreshMeetings = useCallback(
    async (m: Date, accountId: number | null) => {
      const { from, to } = monthRange(m);
      setMeetings(await api.listMeetings(from, to, accountId ?? undefined));
    },
    [monthRange],
  );

  useEffect(() => {
    void refreshMeetings(calendarMonth, selectedAccountId).catch((e) => setError(String(e)));
  }, [calendarMonth, selectedAccountId, refreshMeetings]);

  useEffect(() => {
    const unlisten = listen<MeetingScanProgressEvent>("meeting-scan-progress", (event) => {
      const { done, total, found, stopped_early, error: scanError } = event.payload;
      setMeetingScanProgress({ done, total, found });
      if (scanError) setError(scanError);
      if (done >= total || stopped_early) setMeetingScanProgress(null);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Each thread costs one on-device inference (tens of seconds), so a full-inbox scan runs
  // for hours. Stop after a handful: every scanned thread is recorded, so pressing Scan
  // again resumes with the threads not yet looked at rather than repeating work.
  const MEETING_SCAN_BATCH = 5;
  // Also bound how many threads a manual scan loads. stop_after ends the loop early, but
  // without this the query would still pull every unscanned thread's message bodies into
  // memory before the first inference even starts.
  const MEETING_SCAN_MAX_THREADS = 40;

  const doScanMeetings = () =>
    withBusy(async () => {
      setScanningMeetings(true);
      try {
        const found = await api.scanMeetings(
          selectedAccountId ?? undefined,
          MEETING_SCAN_BATCH,
          MEETING_SCAN_MAX_THREADS,
        );
        await refreshMeetings(calendarMonth, selectedAccountId);
        setNotice(
          found === 0
            ? "No meetings found in the threads scanned so far. Press Scan mail again to keep looking further back."
            : `Found ${found} meeting${found === 1 ? "" : "s"}. Press Scan mail again to keep looking further back.`,
        );
      } finally {
        setScanningMeetings(false);
        setMeetingScanProgress(null);
      }
    });

  const openEmail = (emailId: number) => {
    setPane({ kind: "thread", emailId });
    const e = emails.find((x) => x.id === emailId) ?? extraEmails[emailId];
    if (e && (e.thread_unread > 0 || !e.is_read)) setRead(emailId, true);
  };

  const analyze = useCallback(async (emailId: number) => {
    setAnalyzingIds((prev) => new Set(prev).add(emailId));
    setAnalysisErrors((prev) => {
      const next = { ...prev };
      delete next[emailId];
      return next;
    });
    try {
      const result = await api.triageEmail(emailId);
      setTriageByEmail((prev) => ({ ...prev, [emailId]: result }));
    } catch (e) {
      setAnalysisErrors((prev) => ({ ...prev, [emailId]: String(e) }));
    } finally {
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(emailId);
        return next;
      });
    }
  }, []);

  const selectedEmail =
    (selectedEmailId && emails.find((e) => e.id === selectedEmailId)) || (selectedEmailId ? extraEmails[selectedEmailId] ?? null : null);
  const selectedTriage = selectedEmailId ? triageByEmail[selectedEmailId] ?? null : null;
  const modelReady = modelStatus.state === "ready";
  // Mirror into refs: autoSync is bound to a 5-minute interval and closes over its deps, so it
  // would otherwise keep reading whatever these were when the timer was armed.
  useEffect(() => {
    modelReadyRef.current = modelReady;
  }, [modelReady]);
  useEffect(() => {
    calendarMonthRef.current = calendarMonth;
  }, [calendarMonth]);

  // Opening a thread runs analysis (once per email per session) when the model is ready.
  useEffect(() => {
    if (!selectedEmail || selectedTriage || !modelReady) return;
    if (autoAnalyzed.current.has(selectedEmail.id)) return;
    autoAnalyzed.current.add(selectedEmail.id);
    analyze(selectedEmail.id);
  }, [selectedEmail, selectedTriage, modelReady, analyze]);

  const accountEmails: Record<number, string> = Object.fromEntries(accounts.map((a) => [a.id, a.email_address]));
  const labelsById: Record<string, LabelDto> = Object.fromEntries(labels.map((l) => [l.gmail_label_id, l]));
  const selectedLabel = selectedLabelId ? labelsById[selectedLabelId] ?? null : null;
  const patchEmailLabels = (emailId: number, labelIds: string[]) => {
    setEmails((prev) => prev.map((e) => (e.id === emailId ? { ...e, label_ids: labelIds } : e)));
    setExtraEmails((prev) => (prev[emailId] ? { ...prev, [emailId]: { ...prev[emailId], label_ids: labelIds } } : prev));
  };
  const analyzing = analyzingIds.size > 0 || progress !== null;
  // Badge counts only meetings still ahead of us; a month full of past ones isn't a to-do.
  const nowIso = (() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const upcomingMeetingCount = meetings.filter((m) => m.starts_at >= nowIso).length;

  const viewTitle = selectedLabel
    ? selectedLabel.name
    : folder === "quarantine"
      ? "Quarantine"
      : folder === "flagged"
        ? "Flagged"
        : folder === "archive"
          ? "Archive"
          : "Inbox";

  /** Removes a thread from the loaded list and moves the reading pane to its neighbour. */
  const dropThreadFromList = (emailId: number) => {
    const idx = emails.findIndex((e) => e.id === emailId);
    const threadId = emails[idx]?.gmail_thread_id ?? null;
    const remaining = emails.filter((e) => e.id !== emailId && (threadId === null || e.gmail_thread_id !== threadId));
    setEmails(remaining);
    loadedRef.current = remaining.length;
    if (pane.kind === "thread" && pane.emailId === emailId) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setPane(next && !narrow ? { kind: "thread", emailId: next.id } : { kind: "empty" });
      if (next && !narrow && next.thread_unread > 0) setRead(next.id, true);
    }
  };

  const archiveThread = async (emailId: number, archived: boolean) => {
    const res = await api.archiveThread(emailId, archived);
    // The thread leaves the current view unless this is a label view (labels ignore archiving).
    if (!selectedLabelId) dropThreadFromList(emailId);
    refreshCounts(selectedAccountId).catch(() => {});
    if (res.warning && !scopeWarned.current) {
      scopeWarned.current = true;
      setNotice(res.warning);
    }
  };

  const doSync = () =>
    withBusy(async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const summary = await api.syncNow(selectedAccountId ?? undefined);
        await refreshEmails(selectedAccountId);
        setLastSyncedAt(new Date());
        if (summary.errors.length) setError(summary.errors.join("\n"));
      } finally {
        syncingRef.current = false;
      }
    });

  // How many threads the background pass will scan per sync tick. Each one costs a full
  // on-device inference (tens of seconds on CPU), so this is deliberately small: the aim is to
  // keep up with new mail and drain the backlog gradually, not to race through the inbox.
  const AUTO_SCAN_THREADS_PER_TICK = 3;

  // Quiet background sync: on launch (once accounts are known) and every AUTO_SYNC_MS.
  const autoSync = useCallback(async () => {
    if (syncingRef.current || accounts.length === 0) return;
    syncingRef.current = true;
    try {
      const summary = await api.syncNow(selectedAccountId ?? undefined);
      await refreshEmails(selectedAccountId);
      setLastSyncedAt(new Date());
      if (summary.errors.length) setError(summary.errors.join("\n"));
    } catch (e) {
      setError(String(e));
    } finally {
      syncingRef.current = false;
    }

    // Meetings ride along with the sync the user already has running, so the calendar fills in
    // on its own. Only possible once the model is loaded; silently skipped otherwise, since a
    // background task must not nag. Failures stay quiet for the same reason - the explicit
    // "Scan mail" button is where errors belong.
    if (!modelReadyRef.current || scanningRef.current) return;
    scanningRef.current = true;
    try {
      const found = await api.scanMeetings(
        selectedAccountId ?? undefined,
        undefined,
        AUTO_SCAN_THREADS_PER_TICK,
      );
      if (found > 0) await refreshMeetings(calendarMonthRef.current, selectedAccountId);
    } catch {
      // ignored on purpose - see above
    } finally {
      scanningRef.current = false;
    }
  }, [accounts.length, selectedAccountId, refreshEmails, refreshMeetings]);

  useEffect(() => {
    if (accounts.length === 0) return;
    const initial = window.setTimeout(autoSync, 1500);
    const interval = window.setInterval(autoSync, AUTO_SYNC_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
    // Re-arm only when the set of accounts changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length]);

  const doAddAccount = () =>
    withBusy(async () => {
      await api.addAccount();
      setAccounts(await api.listAccounts());
    });
  const doRemoveAccount = (accountId: number) =>
    withBusy(async () => {
      await api.removeAccount(accountId);
      setAccounts(await api.listAccounts());
      setPane({ kind: "empty" });
      clearSearch();
      if (selectedAccountId === accountId) setSelectedAccountId(null);
      else await refreshEmails(selectedAccountId);
    });

  const closePane = () => setPane({ kind: "empty" });
  const showList = !narrow || pane.kind === "empty";
  const showPane = !narrow || pane.kind !== "empty";

  // What "open number two" counts through: search hits when searching, else the loaded list.
  const visibleIds: number[] = searchResults ? searchResults.map((r) => r.email_id) : emails.map((e) => e.id);

  /** Runs one spoken command. Returns a short note for the toast, or null when it doesn't apply right now. */
  const runVoiceCommand = (cmd: VoiceCommand): string | null | void => {
    switch (cmd.kind) {
      case "help":
        speak(VOICE_HELP);
        return VOICE_HELP;
      case "stop":
        stopSpeaking();
        return;
      case "back":
        stopSpeaking();
        if (pane.kind !== "empty") {
          closePane();
          return;
        }
        // Nothing open: "inbox"/"back" means the plain inbox list.
        setFolder("inbox");
        setSelectedLabelId(null);
        clearSearch();
        return "Showing the inbox";
      case "settings":
        setSettingsOpen(true);
        return;
      case "read":
        if (selectedEmail) {
          setReadAloudPart(cmd.part ?? "body");
          setReadAloudSignal((n) => n + 1);
          return cmd.part === "summary" ? "Here's the summary" : cmd.part === "details" ? "Here are the details" : "Reading this email";
        }
        speak(describeInboxForSpeech(viewTitle, emails, counts.unread));
        return `Reading ${viewTitle}`;
      case "reply":
        if (!selectedEmail) return null;
        if (effectiveRisk(selectedTriage) === "danger") return "Reply is disabled for a dangerous email.";
        setReplyInstructions(cmd.instructions ?? null);
        setReplySignal((n) => n + 1);
        if (cmd.instructions) return modelReady ? `Drafting a reply that says: "${cmd.instructions}"` : `Opening a reply - turn on Analysis in Settings to have it drafted from "${cmd.instructions}"`;
        return;
      case "mark_read":
        if (!selectedEmail) return null;
        setRead(selectedEmail.id, cmd.read);
        return;
      case "done":
        if (!selectedEmail || selectedTriage?.triage_status !== "ok") return null;
        api
          .setDone(selectedEmail.id, cmd.done)
          .then(() => setTriageByEmail((prev) => (prev[selectedEmail.id] ? { ...prev, [selectedEmail.id]: { ...prev[selectedEmail.id], done: cmd.done } } : prev)))
          .catch((e) => setError(String(e)));
        return;
      case "search":
        stopSpeaking();
        closePane();
        setSearchInput(cmd.query);
        void runSearch(cmd.query);
        return;
      case "clear_search":
        clearSearch();
        return;
      case "sync":
        void doSync();
        return;
      case "folder":
        setFolder(cmd.folder);
        setSelectedLabelId(null);
        closePane();
        clearSearch();
        return;
      case "open": {
        if (visibleIds.length === 0) return `${viewTitle} is empty.`;
        const idx = cmd.index < 0 ? visibleIds.length - 1 : cmd.index;
        if (idx >= visibleIds.length) return `There are only ${visibleIds.length} emails in the list.`;
        stopSpeaking();
        openEmail(visibleIds[idx]);
        if (cmd.thenRead) {
          setReadAloudPart("body");
          window.setTimeout(() => setReadAloudSignal((n) => n + 1), 400); // after the detail view mounts
        }
        return;
      }
      case "open_match": {
        // Best visible match on sender name/address or subject: all query words present beats some.
        const words = cmd.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        if (words.length === 0) return null;
        const candidates: EmailDto[] = searchResults
          ? searchResults.map((r) => emails.find((e) => e.id === r.email_id) ?? extraEmails[r.email_id]).filter((e): e is EmailDto => !!e)
          : emails;
        let best: { id: number; score: number } | null = null;
        for (const e of candidates) {
          const sender = parseSender(e.sender);
          const hay = `${sender.name} ${sender.address ?? ""} ${e.subject ?? ""}`.toLowerCase();
          const score = words.filter((w) => hay.includes(w)).length;
          if (score > 0 && (!best || score > best.score)) best = { id: e.id, score };
        }
        if (!best) {
          // Not on screen: fall back to a search for it.
          closePane();
          setSearchInput(cmd.query);
          void runSearch(cmd.query);
          return `Nothing on screen matches "${cmd.query}" - searching instead`;
        }
        stopSpeaking();
        openEmail(best.id);
        if (cmd.thenRead) {
          setReadAloudPart("body");
          window.setTimeout(() => setReadAloudSignal((n) => n + 1), 400);
        }
        return;
      }
      case "next":
      case "prev": {
        if (!selectedEmailId) return null;
        const at = visibleIds.indexOf(selectedEmailId);
        if (at < 0) return null;
        const to = cmd.kind === "next" ? at + 1 : at - 1;
        if (to < 0) return "This is the newest email.";
        if (to >= visibleIds.length) return "This is the last email in the list.";
        stopSpeaking();
        openEmail(visibleIds[to]);
        return;
      }
    }
  };

  return (
    <div className={`app-shell ${narrow ? "is-narrow" : ""}`}>
      <Sidebar
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onSelectAccount={(id) => {
          setSelectedAccountId(id);
          setPane({ kind: "empty" });
          clearSearch();
        }}
        onAddAccount={doAddAccount}
        onRemoveAccount={doRemoveAccount}
        onSync={doSync}
        onCompose={() => setPane({ kind: "compose" })}
        composing={pane.kind === "compose"}
        folder={selectedLabelId ? null : folder}
        onSelectFolder={(f) => {
          setFolder(f);
          setSelectedLabelId(null);
          setPane({ kind: "empty" });
          clearSearch();
        }}
        labels={labels}
        selectedLabelId={selectedLabelId}
        onSelectLabel={(id) => {
          setSelectedLabelId(id);
          setPane({ kind: "empty" });
          clearSearch();
        }}
        onSaveLabelSettings={async (labelId, description, autoApply) => {
          const updated = await api.setLabelSettings(labelId, description, autoApply);
          setLabels((prev) => prev.map((l) => (l.id === labelId ? { ...updated, thread_count: l.thread_count } : l)));
        }}
        counts={folderCounts}
        upcomingMeetings={upcomingMeetingCount}
        modelStatus={modelStatus}
        busy={busy}
        analyzing={analyzing}
        progress={progress}
        syncProgress={syncProgress}
        lastSyncedAt={lastSyncedAt}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        modelStatus={modelStatus}
        embedModelStatus={embedModelStatus}
        busy={busy}
        lastSyncedAt={lastSyncedAt}
        onLoadModel={() => withBusy(async () => api.loadModel())}
        onTriageAll={() =>
          withBusy(async () => {
            await api.triageAllUntriaged(selectedAccountId ?? undefined);
            setProgress(null);
          })
        }
        onLoadEmbeddingModel={() => withBusy(async () => api.loadEmbeddingModel())}
        onEmbedPending={() =>
          withBusy(async () => {
            await api.embedPending(selectedAccountId ?? undefined);
          })
        }
      />

      {folder === "calendar" && !selectedLabelId ? (
        <CalendarMonth
          meetings={meetings}
          month={calendarMonth}
          onChangeMonth={setCalendarMonth}
          onOpenSource={(emailId) => {
            setFolder("inbox");
            openEmail(emailId);
          }}
          onJoin={(url) => {
            void api.openExternal(url).catch((e) => setError(String(e)));
          }}
          onDismiss={(meetingId) => {
            void (async () => {
              try {
                await api.dismissMeeting(meetingId);
                setMeetings((prev) => prev.filter((m) => m.id !== meetingId));
              } catch (e) {
                setError(String(e));
              }
            })();
          }}
          scanning={scanningMeetings}
          scanProgress={meetingScanProgress}
          onScan={doScanMeetings}
          modelReady={modelReady}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <>
        {showList && (
          <EmailList
            title={viewTitle}
            folder={selectedLabelId ? "all" : toApiFolder(folder)}
            labelsById={labelsById}
            emails={emails}
            total={counts.total}
            unreadCount={counts.unread}
            hasMore={emails.length < counts.total}
            loadingMore={loadingMore}
            onLoadMore={loadOlder}
            accountEmails={accountEmails}
            triageByEmail={triageByEmail}
            filter={filter}
            onFilter={setFilter}
            selectedEmailId={selectedEmailId}
            sort={sort}
            onSort={setSort}
            onOpen={openEmail}
            search={{
              semanticEnabled: embedModelStatus.state === "ready",
              input: searchInput,
              query: searchQuery,
              results: searchResults,
              loading: searchLoading,
              onInput: onSearchInput,
              onSubmit: onSearchSubmit,
              onClear: clearSearch,
            }}
            busy={busy}
            hasAccounts={accounts.length > 0}
            onAddAccount={doAddAccount}
            onSync={doSync}
          />
        )}

        {showPane && (
          <main className="reading-pane">
            {error && (
              <div className="banner banner-error sm-fade" role="alert">
                <span className="mono banner-label">error</span>
                <span className="banner-text">{error}</span>
                <button type="button" className="link-action" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {notice && (
              <div className="banner banner-notice sm-fade" role="status">
                <span className="mono banner-label">notice</span>
                <span className="banner-text">{notice}</span>
                <button type="button" className="link-action" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {preview && selectedEmail && (
              <AttachmentPreview
                key={`${preview.emailId}:${preview.attachment.attachment_id}`}
                emailId={preview.emailId}
                attachment={preview.attachment}
                emailSubject={selectedEmail.subject}
                allowExternalOpen={effectiveRisk(selectedTriage) !== "danger"}
                onBack={() => setPreview(null)}
              />
            )}
            <div className={preview ? "pane is-hidden" : "pane"}>
            {pane.kind === "compose" ? (
              <Compose
                accounts={accounts}
                defaultAccountId={selectedAccountId ?? (accounts.length === 1 ? accounts[0].id : null)}
                narrow={narrow}
                modelReady={modelReady}
                onOpenSettings={() => setSettingsOpen(true)}
                onClose={closePane}
                onSend={async (accountId, to, cc, subject, body) => {
                  await api.sendMessage(accountId, to, cc, subject, body);
                }}
                onDraftWithAi={(accountId, to, cc, subject, instructions, previousBody) =>
                  api.draftMessage(accountId, to, cc, subject, instructions, previousBody)
                }
              />
            ) : selectedEmail ? (
              <EmailDetail
                key={selectedEmail.id}
                email={selectedEmail}
                userEmail={accountEmails[selectedEmail.account_id] ?? null}
                triage={selectedTriage}
                analyzing={analyzingIds.has(selectedEmail.id)}
                analysisError={analysisErrors[selectedEmail.id] ?? null}
                modelReady={modelReady}
                narrow={narrow}
                archived={folder === "archive" && !selectedLabelId ? true : !selectedEmail.label_ids.includes("INBOX") && selectedEmail.label_ids.length > 0}
                onOpenSettings={() => setSettingsOpen(true)}
                onAnalyze={analyze}
                onClose={closePane}
                onToggleRead={setRead}
                onArchive={archiveThread}
                labels={labels}
                onApplyLabels={async (emailId, add, remove) => {
                  const res = await api.applyLabels(emailId, add, remove);
                  patchEmailLabels(emailId, res.label_ids);
                  if (res.warning && !scopeWarned.current) {
                    scopeWarned.current = true;
                    setNotice(res.warning);
                  }
                }}
                onSuggestLabels={(emailId) => api.suggestLabels(emailId)}
                onSetDone={async (emailId, done) => {
                  await api.setDone(emailId, done);
                  setTriageByEmail((prev) => (prev[emailId] ? { ...prev, [emailId]: { ...prev[emailId], done } } : prev));
                }}
                onSetUserRisk={async (emailId, risk) => {
                  const updated = await api.setUserRisk(emailId, risk);
                  setTriageByEmail((prev) => ({ ...prev, [emailId]: updated }));
                  refreshCounts(selectedAccountId).catch(() => {});
                }}
                onSendReply={async (emailId, body, replyAll) => {
                  await api.createGmailDraft(emailId, body, replyAll, true);
                }}
                onDraftWithAi={(emailId, instructions, previousDraft) => api.draftReply(emailId, instructions, previousDraft)}
                onPreviewAttachment={(attachment) => setPreview({ emailId: selectedEmail.id, attachment })}
                suspended={preview !== null}
                readAloudSignal={readAloudSignal}
                readAloudPart={readAloudPart}
                replySignal={replySignal}
                replyInstructions={replyInstructions}
              />
            ) : (
              <div className="pane-empty sm-fade">
                {selectedEmailId ? (
                  <p className="mono pane-empty-text">Loading…</p>
                ) : (
                  <>
                    <p className="pane-empty-title">Nothing open</p>
                    <p className="pane-empty-text">Pick a conversation on the left, or start a new message.</p>
                  </>
                )}
              </div>
            )}
            </div>
          </main>
        )}
        </>
      )}
      <VoiceDock
        onCommand={runVoiceCommand}
        interpret={
          modelReady
            ? (transcript) => api.interpretVoiceCommand(transcript, selectedEmail !== null).then(commandFromModelIntent)
            : null
        }
      />
    </div>
  );
}

export default App;
