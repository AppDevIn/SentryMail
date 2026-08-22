import { useEffect, useRef, useState } from "react";
import type { EmailDto, LabelDto, ListFilter, SearchResultDto, TriageResult } from "../types";
import { PriorityDot, RiskPill } from "./Badge";
import { RISK_NOTES, addressingFor, effectiveRisk, formatListTime, parseSender, previewLine, splitQuotedHistory } from "../format";

interface SearchState {
  enabled: boolean;
  query: string;
  results: SearchResultDto[] | null;
  onSearch: (query: string) => void;
  onClear: () => void;
}

// Module-level so the scroll offset survives this component unmounting while a thread is open.
let savedScrollTop = 0;

interface EmailListProps {
  title: string;
  labelsById: Record<string, LabelDto>;
  emails: EmailDto[];
  /** Total rows in this folder (may exceed what's loaded) and how many are unread. */
  total: number;
  unreadCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** account id -> account email address, to mark rows where the user is only CC'd. */
  accountEmails: Record<number, string>;
  triageByEmail: Record<number, TriageResult>;
  filter: ListFilter;
  onFilter: (filter: ListFilter) => void;
  onOpen: (emailId: number) => void;
  search: SearchState;
  busy: boolean;
  hasAccounts: boolean;
  onAddAccount: () => void;
  onSync: () => void;
}

function matchesFilter(filter: ListFilter, email: EmailDto, triage: TriageResult | undefined): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return email.thread_unread > 0;
  if (!triage) return false;
  if (filter === "needs_action") return triage.type === "action_needed" && !triage.done;
  const r = effectiveRisk(triage);
  return r === "danger" || r === "caution";
}

export function EmailList({
  title,
  labelsById,
  emails,
  total,
  unreadCount,
  hasMore,
  loadingMore,
  onLoadMore,
  accountEmails,
  triageByEmail,
  filter,
  onFilter,
  onOpen,
  search,
  busy,
  hasAccounts,
  onAddAccount,
  onSync,
}: EmailListProps) {
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the list's scroll offset when coming back from a thread. The offset is captured
  // synchronously in `open` (not via scroll events, which don't fire in hidden documents).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = savedScrollTop;
  }, []);

  const open = (emailId: number) => {
    savedScrollTop = scrollRef.current?.scrollTop ?? 0;
    onOpen(emailId);
  };

  const flagged = emails.filter((e) => {
    const t = triageByEmail[e.id];
    const r = effectiveRisk(t);
    return r === "danger" || r === "caution";
  }).length;
  const visible = emails.filter((e) => matchesFilter(filter, e, triageByEmail[e.id]));
  const searching = search.results !== null;

  return (
    <section className="inbox">
      <header className="inbox-header">
        <div className="inbox-title-row">
          <h1>{title}</h1>
          <span className="mono inbox-meta">
            {total} {total === 1 ? "THREAD" : "THREADS"}
            {unreadCount > 0 && <> · <span className="is-accent">{unreadCount} UNREAD</span></>}
            {flagged > 0 && <> · {flagged} FLAGGED</>}
          </span>
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) search.onSearch(query.trim());
            }}
          >
            <input
              type="search"
              className="mono"
              placeholder={search.enabled ? "SEARCH BY MEANING…" : "SEARCH MODEL NOT LOADED"}
              value={query}
              disabled={!search.enabled || busy}
              onChange={(e) => setQuery(e.currentTarget.value)}
              aria-label="Search inbox by meaning"
            />
          </form>
        </div>
        <div className="chip-row" role="tablist" aria-label="Filter">
          {(
            [
              ["all", "ALL"],
              ["unread", "UNREAD"],
              ["needs_action", "NEEDS ACTION"],
              ["flagged", "FLAGGED"],
            ] as [ListFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`chip mono ${filter === value ? "active" : ""}`}
              onClick={() => onFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {searching ? (
        <div className="search-banner">
          <span className="mono">
            {search.results!.length} {search.results!.length === 1 ? "RESULT" : "RESULTS"} FOR “{search.query}”
          </span>
          <button
            type="button"
            className="btn btn-mini mono"
            onClick={() => {
              setQuery("");
              search.onClear();
            }}
          >
            CLEAR
          </button>
        </div>
      ) : null}

      <div className="inbox-scroll" ref={scrollRef}>
        {!hasAccounts && (
          <div className="empty-state sm-fade">
            <p className="empty-title">No inbox connected</p>
            <p className="empty-copy">
              Connect a Gmail account to start. Sync uses Google's API with read + compose scopes;
              every analysis afterwards runs on this device.
            </p>
            <button type="button" className="btn btn-accent" disabled={busy} onClick={onAddAccount}>
              + Add inbox
            </button>
          </div>
        )}

        {hasAccounts && emails.length === 0 && !searching && (
          <div className="empty-state sm-fade">
            <p className="empty-title">Nothing here yet</p>
            <p className="empty-copy">
              {title === "Quarantine"
                ? "Emails the on-device model rates DANGER will show up here."
                : "Sync to pull your inbox in."}
            </p>
            {title !== "Quarantine" && (
              <button type="button" className="btn btn-accent" disabled={busy} onClick={onSync}>
                Sync inbox
              </button>
            )}
          </div>
        )}

        {searching && (
          <ul className="row-list">
            {search.results!.length === 0 && (
              <li className="empty-state">
                <p className="empty-copy">No matching emails.</p>
              </li>
            )}
            {search.results!.map((r) => {
              const triage = triageByEmail[r.email_id];
              const sender = parseSender(r.sender);
              return (
                <li key={r.email_id}>
                  <button type="button" className="row" data-risk={effectiveRisk(triage) ?? "none"} onClick={() => open(r.email_id)}>
                    <span className="row-rail" aria-hidden="true" />
                    <PriorityDot priority={triage?.priority ?? null} />
                    <span className="row-main">
                      <span className="row-top">
                        <span className="row-sender">{sender.name}</span>
                        <span className="mono row-time">{formatListTime(r.received_at)}</span>
                      </span>
                      <span className="row-subject">{r.subject || "(no subject)"}</span>
                      <span className="row-ai">
                        <span className="row-summary">{r.snippet}</span>
                      </span>
                      <span className="row-flags">
                        <span className="mono row-note">SIMILARITY {r.score.toFixed(2)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!searching && emails.length > 0 && (
          <ul className="row-list">
            {visible.length === 0 && (
              <li className="empty-state">
                <p className="empty-copy">
                  {filter === "unread"
                    ? "All caught up - nothing unread in the loaded messages."
                    : filter === "needs_action"
                      ? "Nothing analyzed as needing action."
                      : "Nothing flagged. Emails rated CAUTION or DANGER appear here."}
                </p>
              </li>
            )}
            {visible.map((email) => {
              const triage = triageByEmail[email.id];
              const sender = parseSender(email.sender);
              const risk = effectiveRisk(triage);
              const note = risk ? RISK_NOTES[risk] : null;
              const addressing = addressingFor(email, accountEmails[email.account_id] ?? null);
              return (
                <li key={email.id}>
                  <button
                    type="button"
                    className={`row ${email.thread_unread > 0 ? "row-unread" : ""}`}
                    data-risk={risk ?? "none"}
                    onClick={() => open(email.id)}
                  >
                    <span className="row-rail" aria-hidden="true" />
                    <PriorityDot priority={triage?.priority ?? null} />
                    <span className="row-main">
                      <span className="row-top">
                        {email.thread_unread > 0 && <span className="unread-dot" title="Unread" aria-label="unread" />}
                        <span className="row-sender">{sender.name}</span>
                        {email.thread_count > 1 && (
                          <span className="mono row-thread-count" title={`${email.thread_count} messages in this conversation`}>
                            {email.thread_count}
                          </span>
                        )}
                        {triage?.done && <span className="mono row-cc row-done">DONE</span>}
                        {addressing === "cc" && <span className="mono row-cc">CC</span>}
                        {addressing === "none" && <span className="mono row-cc">VIA LIST</span>}
                        <span className="mono row-time">{formatListTime(email.received_at)}</span>
                      </span>
                      <span className="row-subject">
                        {email.label_ids
                          .map((id) => labelsById[id])
                          .filter((l): l is LabelDto => !!l)
                          .slice(0, 3)
                          .map((l) => (
                            <span key={l.id} className="label-chip" style={{ background: l.color_bg ?? undefined, color: l.color_fg ?? undefined }}>
                              {l.name}
                            </span>
                          ))}
                        {email.subject || "(no subject)"}
                      </span>
                      <span className="row-ai">
                        {triage && triage.triage_status === "ok" ? (
                          <span className="row-summary">{triage.summary}</span>
                        ) : (
                          <span className="row-summary row-summary-pending">
                            {previewLine(splitQuotedHistory(email.body_text || "").newest, 160) || "(no text)"}
                          </span>
                        )}
                      </span>
                      {risk && note && (
                        <span className="row-flags">
                          <RiskPill risk={risk} />
                          <span className="mono row-note">{note}</span>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {hasMore ? (
              <li className="load-older">
                <button type="button" className="btn btn-ghost mono" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? "LOADING…" : `LOAD OLDER · SHOWING ${emails.length} OF ${total}`}
                </button>
              </li>
            ) : (
              <li className="mono inbox-end">END OF {title.toUpperCase()}</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
