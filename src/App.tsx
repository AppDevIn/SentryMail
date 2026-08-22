import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type {
  AccountDto,
  EmailCounts,
  LabelDto,
  EmailDto,
  Folder,
  ListFilter,
  ModelStatus,
  SearchResultDto,
  SyncProgressEvent,
  TriageProgressEvent,
  TriageResult,
} from "./types";
import { effectiveRisk } from "./format";
import { Sidebar } from "./components/Sidebar";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { SettingsPanel } from "./components/SettingsPanel";
import "./App.css";

const PAGE_SIZE = 100;
/** Background sync cadence. Incremental (history API) syncs are cheap, so this can be short. */
const AUTO_SYNC_MS = 5 * 60 * 1000;
/** Search runs this long after the last keystroke (and immediately on Enter). ADR 0006. */
const SEARCH_DEBOUNCE_MS = 200;
/** Most results one search returns. ADR 0006. */
const SEARCH_RESULT_CAP = 50;

function App() {
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [emails, setEmails] = useState<EmailDto[]>([]);
  const [counts, setCounts] = useState<EmailCounts>({ total: 0, unread: 0 });
  const [extraEmails, setExtraEmails] = useState<Record<number, EmailDto>>({});
  const [triageByEmail, setTriageByEmail] = useState<Record<number, TriageResult>>({});
  const [selectedEmailId, setSelectedEmailId] = useState<number | null>(null);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const selectedLabelRef = useRef<string | null>(null);
  selectedLabelRef.current = selectedLabelId;
  const [filter, setFilter] = useState<ListFilter>("all");
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
  const [analysisMs, setAnalysisMs] = useState<Record<number, number>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Record<number, string>>({});
  // Emails we already auto-analyzed on open this session - don't keep retrying a failure.
  const autoAnalyzed = useRef<Set<number>>(new Set());
  // How many rows are currently loaded, so refreshes keep the same depth.
  const loadedRef = useRef(0);
  const scopeWarned = useRef(false);

  const loadTriage = useCallback(async (list: EmailDto[]) => {
    const results = await Promise.all(list.map((e) => api.getTriageResult(e.id)));
    const byId: Record<number, TriageResult> = {};
    list.forEach((e, i) => {
      const result = results[i];
      if (result) byId[e.id] = result;
    });
    setTriageByEmail((prev) => ({ ...prev, ...byId }));
  }, []);

  const refreshCounts = useCallback(async (accountId: number | null) => {
    setCounts(await api.emailCounts(accountId ?? undefined, selectedLabelRef.current));
  }, []);

  const refreshLabels = useCallback(async (accountId: number | null) => {
    setLabels(await api.listLabels(accountId ?? undefined));
  }, []);

  const refreshEmails = useCallback(
    async (accountId: number | null) => {
      const limit = Math.max(PAGE_SIZE, loadedRef.current);
      const list = await api.listEmails(accountId ?? undefined, limit, 0, selectedLabelRef.current);
      loadedRef.current = list.length;
      setEmails(list);
      await Promise.all([loadTriage(list), refreshCounts(accountId)]);
    },
    [loadTriage, refreshCounts],
  );

  const loadOlder = useCallback(async () => {
    setLoadingMore(true);
    try {
      const more = await api.listEmails(selectedAccountId ?? undefined, PAGE_SIZE, loadedRef.current, selectedLabelRef.current);
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
  }, [selectedAccountId, loadTriage]);

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
    loadedRef.current = 0;
    refreshEmails(selectedAccountId).catch((e) => setError(String(e)));
  }, [selectedAccountId, selectedLabelId, refreshEmails]);

  useEffect(() => {
    refreshLabels(selectedAccountId).catch(() => {});
  }, [selectedAccountId, accounts.length, lastSyncedAt, refreshLabels]);

  // While a long sync is fetching, pull new rows in every 25 messages so the inbox fills live.
  useEffect(() => {
    if (syncProgress?.phase === "fetching" && syncProgress.done % 25 === 0) {
      refreshEmails(selectedAccountId).catch(() => {});
    }
  }, [syncProgress, selectedAccountId, refreshEmails]);

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
  // Deliberately not routed through withBusy: that would disable the input mid-keystroke.
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

  // Drop a pending debounce if the list unmounts.
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

  const openEmail = (emailId: number) => {
    setSelectedEmailId(emailId);
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
    const started = performance.now();
    try {
      const result = await api.triageEmail(emailId);
      setTriageByEmail((prev) => ({ ...prev, [emailId]: result }));
      setAnalysisMs((prev) => ({ ...prev, [emailId]: performance.now() - started }));
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
    emails.find((e) => e.id === selectedEmailId) ?? (selectedEmailId ? extraEmails[selectedEmailId] ?? null : null);
  const selectedTriage = selectedEmailId ? triageByEmail[selectedEmailId] ?? null : null;
  const modelReady = modelStatus.state === "ready";

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
  const quarantineCount = emails.filter((e) => effectiveRisk(triageByEmail[e.id]) === "danger").length;
  const folderEmails = folder === "quarantine" ? emails.filter((e) => effectiveRisk(triageByEmail[e.id]) === "danger") : emails;
  const analyzing = analyzingIds.size > 0 || progress !== null;

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

  // Quiet background sync: on launch (once accounts are known) and every AUTO_SYNC_MS.
  // Doesn't take the busy lock, so the UI stays usable; progress shows in the badge.
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
  }, [accounts.length, selectedAccountId, refreshEmails]);

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
      setSelectedEmailId(null);
      clearSearch();
      if (selectedAccountId === accountId) setSelectedAccountId(null);
      else await refreshEmails(selectedAccountId);
    });

  return (
    <div className="app-shell">
      <Sidebar
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onSelectAccount={(id) => {
          setSelectedAccountId(id);
          setSelectedEmailId(null);
          clearSearch();
        }}
        onAddAccount={doAddAccount}
        onRemoveAccount={doRemoveAccount}
        onSync={doSync}
        folder={folder}
        onSelectFolder={(f) => {
          setFolder(f);
          setSelectedLabelId(null);
          setSelectedEmailId(null);
          clearSearch();
        }}
        labels={labels}
        selectedLabelId={selectedLabelId}
        onSelectLabel={(id) => {
          setSelectedLabelId(id);
          setFolder("inbox");
          setSelectedEmailId(null);
          clearSearch();
        }}
        onSaveLabelSettings={async (labelId, description, autoApply) => {
          const updated = await api.setLabelSettings(labelId, description, autoApply);
          setLabels((prev) => prev.map((l) => (l.id === labelId ? updated : l)));
        }}
        counts={{ inboxTotal: counts.total, inboxUnread: counts.unread, quarantine: quarantineCount }}
        modelStatus={modelStatus}
        embedModelStatus={embedModelStatus}
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

      <main className="content">
        {error && (
          <div className="error-banner sm-fade" role="alert">
            <span className="mono error-label">ERROR</span>
            <span className="error-text">{error}</span>
            <button type="button" className="btn btn-mini mono" onClick={() => setError(null)}>
              DISMISS
            </button>
          </div>
        )}
        {notice && (
          <div className="notice-banner sm-fade" role="status">
            <span className="mono notice-label">NOTICE</span>
            <span className="error-text">{notice}</span>
            <button type="button" className="btn btn-mini mono" onClick={() => setNotice(null)}>
              DISMISS
            </button>
          </div>
        )}

        {selectedEmail ? (
          <EmailDetail
            key={selectedEmail.id}
            email={selectedEmail}
            userEmail={accountEmails[selectedEmail.account_id] ?? null}
            triage={selectedTriage}
            analyzing={analyzingIds.has(selectedEmail.id)}
            analysisMs={analysisMs[selectedEmail.id] ?? null}
            analysisError={analysisErrors[selectedEmail.id] ?? null}
            modelReady={modelReady}
            onOpenSettings={() => setSettingsOpen(true)}
            onAnalyze={analyze}
            onBack={() => setSelectedEmailId(null)}
            onToggleRead={setRead}
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
            }}
            onSaveDraft={async (emailId, body, replyAll) => {
              await api.createGmailDraft(emailId, body, replyAll);
            }}
            onDraftWithAi={(emailId, instructions, previousDraft) => api.draftReply(emailId, instructions, previousDraft)}
          />
        ) : (
          <EmailList
            title={selectedLabel ? selectedLabel.name : folder === "quarantine" ? "Quarantine" : "Inbox"}
            labelsById={labelsById}
            emails={folderEmails}
            total={folder === "quarantine" ? quarantineCount : counts.total}
            unreadCount={folder === "quarantine" ? folderEmails.filter((e) => !e.is_read).length : counts.unread}
            hasMore={folder === "inbox" && emails.length < counts.total}
            loadingMore={loadingMore}
            onLoadMore={loadOlder}
            accountEmails={accountEmails}
            triageByEmail={triageByEmail}
            filter={filter}
            onFilter={setFilter}
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
      </main>
    </div>
  );
}

export default App;
