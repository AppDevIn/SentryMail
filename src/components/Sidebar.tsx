import { useEffect, useRef, useState } from "react";
import type { AccountDto, Folder, LabelDto, ModelStatus, SyncProgressEvent } from "../types";
import { LockIcon } from "./LockIcon";

interface SidebarProps {
  accounts: AccountDto[];
  selectedAccountId: number | null;
  onSelectAccount: (accountId: number | null) => void;
  onAddAccount: () => void;
  onRemoveAccount: (accountId: number) => void;
  onSync: () => void;
  folder: Folder;
  onSelectFolder: (folder: Folder) => void;
  counts: { inboxTotal: number; inboxUnread: number; quarantine: number };
  labels: LabelDto[];
  selectedLabelId: string | null;
  onSelectLabel: (gmailLabelId: string | null) => void;
  onSaveLabelSettings: (labelId: number, description: string | null, autoApply: boolean) => Promise<void>;
  modelStatus: ModelStatus;
  embedModelStatus: ModelStatus;
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
      return p.total ? `Syncing: listing inbox ${p.done} of ~${p.total}…` : `Syncing: listing inbox (${p.done})…`;
    case "fetching":
      return p.total ? `Syncing: downloading ${p.done} of ${p.total}…` : `Syncing: downloading ${p.done}…`;
    case "history":
      return `Syncing: applying ${p.done} change${p.done === 1 ? "" : "s"} since last sync…`;
    case "backfill":
      return p.total ? `Fetching older mail: ${p.done} of ${p.total} in this batch…` : "Fetching older mail…";
    default:
      return "Syncing…";
  }
}

function relativeTime(d: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 1) return "JUST NOW";
  if (mins === 1) return "1 MIN AGO";
  if (mins < 60) return `${mins} MIN AGO`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? "1 HOUR AGO" : `${hrs} HOURS AGO`;
}


export function Sidebar({
  accounts,
  selectedAccountId,
  onSelectAccount,
  onAddAccount,
  onRemoveAccount,
  onSync,
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
  // Re-render once a minute so "SYNCED N MIN AGO" stays honest.
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 60_000);
    return () => window.clearInterval(t);
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
  const avatarLetter = (selectedAccount?.email_address ?? accounts[0]?.email_address ?? "?")
    .charAt(0)
    .toUpperCase();

  const modelReady = modelStatus.state === "ready";
  const dotPulses = analyzing || modelStatus.state === "loading" || syncProgress !== null;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <LockIcon size={14} />
        </span>
        <span className="brand-text">
          <span className="brand-name">Sentry Mail</span>
          <span className="mono brand-sub">PRIVATE INBOX</span>
        </span>
      </div>

      <div className={`account-switcher ${switcherOpen ? "open" : ""}`} ref={switcherRef}>
        <button
          type="button"
          className="account-switcher-btn"
          onClick={() => setSwitcherOpen((o) => !o)}
          aria-expanded={switcherOpen}
        >
          <span className="avatar mono">{avatarLetter}</span>
          <span className="mono account-address">{switcherLabel}</span>
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
                  className={selectedAccountId === null ? "active" : ""}
                  onClick={() => {
                    onSelectAccount(null);
                    setSwitcherOpen(false);
                  }}
                >
                  <span className="mono">All inboxes</span>
                </button>
              </li>
            )}
            {accounts.map((account) => (
              <li key={account.id} className="account-menu-row">
                <button
                  type="button"
                  className={selectedAccountId === account.id ? "active" : ""}
                  onClick={() => {
                    onSelectAccount(account.id);
                    setSwitcherOpen(false);
                  }}
                >
                  <span className="avatar mono">{account.email_address.charAt(0).toUpperCase()}</span>
                  <span className="mono">{account.email_address}</span>
                </button>
                <button
                  type="button"
                  className="mono account-remove"
                  title="Remove this inbox from this device"
                  disabled={busy}
                  onClick={() => setConfirmRemove(account)}
                >
                  REMOVE
                </button>
              </li>
            ))}
            {confirmRemove && (
              <li className="account-confirm sm-fade">
                <p>
                  Remove <strong>{confirmRemove.email_address}</strong> from this Mac? Its emails and
                  analysis stored here are deleted and the app's Google access is revoked. Nothing in
                  Gmail itself is deleted.
                </p>
                <div className="account-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-mini mono is-danger"
                    disabled={busy}
                    onClick={() => {
                      const id = confirmRemove.id;
                      setConfirmRemove(null);
                      setSwitcherOpen(false);
                      onRemoveAccount(id);
                    }}
                  >
                    REMOVE INBOX
                  </button>
                  <button type="button" className="btn btn-mini mono" onClick={() => setConfirmRemove(null)}>
                    CANCEL
                  </button>
                </div>
              </li>
            )}
            <li>
              <button
                type="button"
                className="add-inbox"
                disabled={busy}
                onClick={() => {
                  setSwitcherOpen(false);
                  onAddAccount();
                }}
              >
                <span className="mono">+ ADD INBOX</span>
              </button>
            </li>
          </ul>
        )}
      </div>

      <button
        type="button"
        className="btn btn-accent btn-block"
        disabled={busy || accounts.length === 0}
        onClick={onSync}
      >
        <span className="btn-glyph" aria-hidden="true">
          ↻
        </span>
        {busy ? "Working…" : "Sync inbox"}
      </button>
      {accounts.length > 0 && (
        <div className="mono sync-status">
          {syncProgress ? "SYNCING…" : lastSyncedAt ? `SYNCED ${relativeTime(lastSyncedAt)}` : "NOT SYNCED YET"} · AUTO 5 MIN
        </div>
      )}

      <nav className="sidebar-scroll">
        <ul className="folder-list">
          <li>
            <button
              type="button"
              className={`folder ${folder === "inbox" ? "active" : ""}`}
              onClick={() => onSelectFolder("inbox")}
            >
              <span>Inbox</span>
              {counts.inboxUnread > 0 ? (
                <span className="mono folder-count folder-count-unread" title={`${counts.inboxUnread} unread of ${counts.inboxTotal}`}>
                  {counts.inboxUnread}
                </span>
              ) : (
                counts.inboxTotal > 0 && (
                  <span className="mono folder-count" title="all read">
                    {counts.inboxTotal}
                  </span>
                )
              )}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`folder ${folder === "quarantine" ? "active" : ""}`}
              onClick={() => onSelectFolder("quarantine")}
            >
              <span>Quarantine</span>
              {counts.quarantine > 0 && (
                <span className="mono folder-count folder-count-danger">{counts.quarantine}</span>
              )}
            </button>
          </li>
        </ul>

        {labels.length > 0 && (
          <>
            <div className="mono section-label">LABELS</div>
            <ul className="label-list">
              {labels.map((l) => {
                const active = selectedLabelId === l.gmail_label_id;
                const editing = editingLabel === l.id;
                return (
                  <li key={l.id} className={`label-item ${editing ? "editing" : ""}`}>
                    <div className="label-row">
                      <button
                        type="button"
                        className={`label-btn ${active ? "active" : ""}`}
                        onClick={() => onSelectLabel(active ? null : l.gmail_label_id)}
                        title={l.description ?? "No description yet - the AI can't label with this until you add one"}
                      >
                        <span className="label-dot" style={{ background: l.color_bg ?? "var(--neutral-dot)" }} />
                        <span className="label-name">{l.name}</span>
                        {l.auto_apply && <span className="mono label-flag" title="Applied automatically after analysis">AUTO</span>}
                        {!l.description && <span className="mono label-flag label-flag-muted">NO DESC</span>}
                      </button>
                      <button type="button" className="mono label-edit" onClick={() => (editing ? setEditingLabel(null) : startEdit(l))}>
                        {editing ? "CLOSE" : "EDIT"}
                      </button>
                    </div>
                    {editing && (
                      <div className="label-editor sm-fade">
                        <label className="mono label-editor-title" htmlFor={`label-desc-${l.id}`}>
                          WHAT BELONGS UNDER “{l.name.toUpperCase()}”
                        </label>
                        <textarea
                          id={`label-desc-${l.id}`}
                          rows={3}
                          value={draftDesc}
                          onChange={(e) => setDraftDesc(e.currentTarget.value)}
                          placeholder="e.g. Invoices, payments, bank details - anything about money owed or paid."
                        />
                        <label className="mono label-auto">
                          <input type="checkbox" checked={draftAuto} disabled={!draftDesc.trim()} onChange={(e) => setDraftAuto(e.currentTarget.checked)} />
                          AUTO-APPLY AFTER ANALYSIS
                        </label>
                        {labelError && <p className="inline-error">{labelError}</p>}
                        <div className="label-editor-actions">
                          <button type="button" className="btn btn-mini mono" disabled={savingLabel} onClick={() => void saveLabel(l)}>
                            {savingLabel ? "SAVING…" : "SAVE"}
                          </button>
                          <button type="button" className="btn btn-mini mono" disabled={savingLabel} onClick={() => setEditingLabel(null)}>
                            CANCEL
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

      <div className="sidebar-foot">
        <span className={`status-dot ${modelReady ? "on" : ""} ${dotPulses ? "sm-pulse" : ""}`} />
        <span className="foot-text">
          {syncProgress
            ? syncCopy(syncProgress)
            : progress
              ? `Analyzing ${progress.done} of ${progress.total}…`
              : modelStatus.state === "loading"
                ? "Starting analysis…"
                : modelReady
                  ? analyzing
                    ? "Analyzing…"
                    : "Private · on-device"
                  : modelStatus.state === "failed"
                    ? "Analysis unavailable"
                    : "Analysis off"}
        </span>
        <button
          type="button"
          className={`mono foot-settings ${modelReady ? "" : "needs-attention"}`}
          title="Settings: analysis, search, sync"
          onClick={onOpenSettings}
        >
          SETTINGS
        </button>
      </div>
    </aside>
  );
}
