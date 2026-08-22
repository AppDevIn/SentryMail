import { useEffect, useRef, useState } from "react";
import type { AccountDto, Folder, FolderCounts, LabelDto, ModelStatus, SyncProgressEvent } from "../types";
import { setTheme } from "../theme";

interface SidebarProps {
  accounts: AccountDto[];
  selectedAccountId: number | null;
  onSelectAccount: (accountId: number | null) => void;
  onAddAccount: () => void;
  onRemoveAccount: (accountId: number) => void;
  onSync: () => void;
  onCompose: () => void;
  composing: boolean;
  /** Active folder, or null when a label view is open. */
  folder: Folder | null;
  onSelectFolder: (folder: Folder) => void;
  counts: FolderCounts;
  labels: LabelDto[];
  selectedLabelId: string | null;
  onSelectLabel: (gmailLabelId: string | null) => void;
  onSaveLabelSettings: (labelId: number, description: string | null, autoApply: boolean) => Promise<void>;
  modelStatus: ModelStatus;
  busy: boolean;
  /** True while any on-device inference is running (single email or batch). */
  analyzing: boolean;
  progress: { done: number; total: number } | null;
  syncProgress: SyncProgressEvent | null;
  lastSyncedAt: Date | null;
  onOpenSettings: () => void;
}

function syncCopy(p: SyncProgressEvent): string {
  switch (p.phase) {
    case "listing":
      return p.total ? `listing ${p.done} of ~${p.total}` : `listing ${p.done}`;
    case "fetching":
      return p.total ? `downloading ${p.done} of ${p.total}` : `downloading ${p.done}`;
    case "history":
      return `applying ${p.done} change${p.done === 1 ? "" : "s"}`;
    case "backfill":
      return p.total ? `older mail ${p.done} of ${p.total}` : "older mail";
    default:
      return "syncing";
  }
}

function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Whether the page is currently rendering the light palette (theme choice or OS). */
function isLightNow(): boolean {
  const root = document.documentElement;
  if (root.dataset.theme === "light") return true;
  if (root.dataset.theme === "dark") return false;
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

export function Sidebar({
  accounts,
  selectedAccountId,
  onSelectAccount,
  onAddAccount,
  onRemoveAccount,
  onSync,
  onCompose,
  composing,
  folder,
  onSelectFolder,
  counts,
  labels,
  selectedLabelId,
  onSelectLabel,
  onSaveLabelSettings,
  modelStatus,
  busy,
  analyzing,
  progress,
  syncProgress,
  lastSyncedAt,
  onOpenSettings,
}: SidebarProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AccountDto | null>(null);
  const [editingLabel, setEditingLabel] = useState<number | null>(null);
  const [draftDesc, setDraftDesc] = useState("");
  const [draftAuto, setDraftAuto] = useState(false);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [light, setLight] = useState(isLightNow);
  const startEdit = (l: LabelDto) => {
    setEditingLabel(l.id);
    setDraftDesc(l.description ?? "");
    setDraftAuto(l.auto_apply);
    setLabelError(null);
  };
  const saveLabel = async (l: LabelDto) => {
    setSavingLabel(true);
    setLabelError(null);
    try {
      await onSaveLabelSettings(l.id, draftDesc.trim() || null, draftAuto);
      setEditingLabel(null);
    } catch (e) {
      setLabelError(String(e));
    } finally {
      setSavingLabel(false);
    }
  };
  const [, setTick] = useState(0);
  // Re-render once a minute so the synced time stays honest.
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  // Follow theme changes made elsewhere (Settings, OS).
  useEffect(() => {
    const update = () => setLight(isLightNow());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", update);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", update);
    };
  }, []);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Close the account menu on outside click or Escape.
  useEffect(() => {
    if (!switcherOpen) setConfirmRemove(null);
    if (!switcherOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [switcherOpen]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const switcherLabel = selectedAccount
    ? selectedAccount.email_address
    : accounts.length === 0
      ? "No inbox connected"
      : accounts.length === 1
        ? accounts[0].email_address
        : "All inboxes";

  const modelReady = modelStatus.state === "ready";
  const dotPulses = analyzing || modelStatus.state === "loading" || syncProgress !== null;
  const toggleTheme = () => {
    setTheme(light ? "dark" : "light");
    setLight(!light);
  };
  const analysisWord =
    modelStatus.state === "loading"
      ? "analysis starting"
      : modelReady
        ? progress
          ? `analyzing ${progress.done} of ${progress.total}`
          : analyzing
            ? "analyzing"
            : "analysis on"
        : modelStatus.state === "failed"
          ? "analysis unavailable"
          : "analysis off";

  const folders: { key: Folder; name: string; count: number; tone?: "accent" | "danger" | "caution"; title?: string }[] = [
    {
      key: "inbox",
      name: "Inbox",
      count: counts.inbox_unread > 0 ? counts.inbox_unread : counts.inbox_total,
      tone: counts.inbox_unread > 0 ? "accent" : undefined,
      title: `${counts.inbox_unread} unread of ${counts.inbox_total}`,
    },
    { key: "quarantine", name: "Quarantine", count: counts.quarantine, tone: counts.quarantine > 0 ? "danger" : undefined },
    { key: "flagged", name: "Flagged", count: counts.flagged, tone: counts.flagged > 0 ? "caution" : undefined },
    { key: "archive", name: "Archive", count: counts.archive },
  ];

  return (
    <aside className="sidebar">
      <div className={`account-switcher ${switcherOpen ? "open" : ""}`} ref={switcherRef}>
        <button
          type="button"
          className="account-btn"
          onClick={() => setSwitcherOpen((o) => !o)}
          aria-expanded={switcherOpen}
          title={accounts.length > 1 ? "Switch inbox" : "Inbox options"}
        >
          <span className="account-address">{switcherLabel}</span>
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {switcherOpen && (
          <ul className="account-menu sm-fade">
            {accounts.length > 1 && (
              <li>
                <button
                  type="button"
                  className={`menu-item ${selectedAccountId === null ? "active" : ""}`}
                  onClick={() => {
                    onSelectAccount(null);
                    setSwitcherOpen(false);
                  }}
                >
                  All inboxes
                </button>
              </li>
            )}
            {accounts.map((account) => (
              <li key={account.id} className="account-menu-row">
                <button
                  type="button"
                  className={`menu-item mono ${selectedAccountId === account.id ? "active" : ""}`}
                  onClick={() => {
                    onSelectAccount(account.id);
                    setSwitcherOpen(false);
                  }}
                >
                  {account.email_address}
                </button>
                <button
                  type="button"
                  className="link-action account-remove"
                  title="Remove this inbox from this device"
                  disabled={busy}
                  onClick={() => setConfirmRemove(account)}
                >
                  remove
                </button>
              </li>
            ))}
            {confirmRemove && (
              <li className="account-confirm sm-fade">
                <p>
                  Remove <strong>{confirmRemove.email_address}</strong> from this Mac? Its emails and analysis stored here are
                  deleted and the app's Google access is revoked. Nothing in Gmail itself is deleted.
                </p>
                <div className="account-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      const id = confirmRemove.id;
                      setConfirmRemove(null);
                      setSwitcherOpen(false);
                      onRemoveAccount(id);
                    }}
                  >
                    Remove inbox
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmRemove(null)}>
                    Cancel
                  </button>
                </div>
              </li>
            )}
            <li>
              <button
                type="button"
                className="menu-item is-accent"
                disabled={busy}
                onClick={() => {
                  setSwitcherOpen(false);
                  onAddAccount();
                }}
              >
                + Add inbox
              </button>
            </li>
          </ul>
        )}
      </div>

      <div className="mono sync-row">
        <span className="sync-state" title={lastSyncedAt ? `Last synced ${lastSyncedAt.toLocaleString()}` : undefined}>
          {syncProgress ? syncCopy(syncProgress) : lastSyncedAt ? `synced ${clock(lastSyncedAt)}` : accounts.length ? "not synced" : "no inbox"}
        </span>
        <span className="sync-sep" aria-hidden="true">
          /
        </span>
        <button type="button" className="sync-link" disabled={busy || accounts.length === 0 || syncProgress !== null} onClick={onSync}>
          {syncProgress ? "syncing" : busy ? "working" : "sync now"}
        </button>
        <span className="sync-sep" aria-hidden="true">
          /
        </span>
        <button type="button" className="sync-link" onClick={toggleTheme} title={light ? "Switch to dark" : "Switch to light"}>
          {light ? "dark" : "light"}
        </button>
      </div>

      <button type="button" className={`compose-btn ${composing ? "active" : ""}`} disabled={accounts.length === 0} onClick={onCompose}>
        <span className="compose-dot" aria-hidden="true" />
        New message
      </button>

      <nav className="sidebar-scroll">
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.key}>
              <button
                type="button"
                className={`folder ${folder === f.key ? "active" : ""}`}
                onClick={() => onSelectFolder(f.key)}
                title={f.title}
              >
                <span className="folder-name">{f.name}</span>
                {f.count > 0 && <span className={`mono folder-count ${f.tone ? `is-${f.tone}` : ""}`}>{f.count.toLocaleString()}</span>}
              </button>
            </li>
          ))}
        </ul>

        {labels.length > 0 && (
          <>
            <div className="mono section-label">labels</div>
            <ul className="label-list">
              {labels.map((l) => {
                const active = selectedLabelId === l.gmail_label_id;
                const editing = editingLabel === l.id;
                return (
                  <li key={l.id} className={`label-item ${editing ? "editing" : ""}`}>
                    <div className="label-row">
                      <button
                        type="button"
                        className={`folder label-btn ${active ? "active" : ""}`}
                        onClick={() => onSelectLabel(active ? null : l.gmail_label_id)}
                        title={l.description ?? "No description yet - the model can't suggest this label until you add one"}
                      >
                        <span className="label-dot" style={{ background: l.color_bg ?? "var(--accent)" }} />
                        <span className="folder-name">{l.name}</span>
                        {l.auto_apply && (
                          <span className="mono label-flag" title="Applied automatically after analysis">
                            auto
                          </span>
                        )}
                        {l.thread_count > 0 && <span className="mono folder-count">{l.thread_count.toLocaleString()}</span>}
                      </button>
                      <button type="button" className="mono label-edit" onClick={() => (editing ? setEditingLabel(null) : startEdit(l))}>
                        {editing ? "close" : "edit"}
                      </button>
                    </div>
                    {editing && (
                      <div className="label-editor sm-fade">
                        <label className="label-editor-title" htmlFor={`label-desc-${l.id}`}>
                          What belongs under “{l.name}”
                        </label>
                        <textarea
                          id={`label-desc-${l.id}`}
                          rows={3}
                          value={draftDesc}
                          onChange={(e) => setDraftDesc(e.currentTarget.value)}
                          placeholder="e.g. Invoices, payments, bank details - anything about money owed or paid."
                        />
                        <label className="label-auto">
                          <input
                            type="checkbox"
                            checked={draftAuto}
                            disabled={!draftDesc.trim()}
                            onChange={(e) => setDraftAuto(e.currentTarget.checked)}
                          />
                          Apply automatically after analysis
                        </label>
                        {labelError && <p className="inline-error">{labelError}</p>}
                        <div className="label-editor-actions">
                          <button type="button" className="btn btn-accent" disabled={savingLabel} onClick={() => void saveLabel(l)}>
                            {savingLabel ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className="btn" disabled={savingLabel} onClick={() => setEditingLabel(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </nav>

      <div className="sidebar-foot mono">
        <span className={`status-dot ${modelReady ? "on" : ""} ${dotPulses ? "sm-pulse" : ""}`} />
        <span className="foot-text">{analysisWord}</span>
        <button
          type="button"
          className={`foot-settings ${modelReady ? "" : "needs-attention"}`}
          title="Settings: analysis, search, sync"
          onClick={onOpenSettings}
        >
          settings
        </button>
      </div>
    </aside>
  );
}
