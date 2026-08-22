import { Fragment, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ApiFolder, EmailDto, LabelDto, ListFilter, ListSort, Priority, SearchResultDto, TriageResult } from "../types";
import { RiskPill } from "./Badge";
import { RISK_NOTES, addressingFor, effectiveRisk, formatListTime, parseSender, previewLine, splitQuotedHistory } from "../format";

interface SearchState {
  /** Embedding model is loaded, so results may include "related" (meaning) hits. */
  semanticEnabled: boolean;
  /** Current text in the search box. */
  input: string;
  /** The query the current `results` were computed for (shown in the banner). */
  query: string;
  results: SearchResultDto[] | null;
  /** A search is pending (debounce) or in flight. */
  loading: boolean;
  onInput: (text: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}

// Snippet highlight markers from the backend (plain text, never HTML). See SearchResultDto.
const MARK_START = "\uE000";
const MARK_END = "\uE001";

/** Turns a marker-delimited snippet into text with <mark> spans, without ever using innerHTML. */
function renderSnippet(snippet: string): ReactNode[] {
  const text = snippet.replace(/\s+/g, " ").trim();
  const pieces = text.split(MARK_START);
  const nodes: ReactNode[] = [pieces[0].split(MARK_END).join("")];
  for (let i = 1; i < pieces.length; i++) {
    const end = pieces[i].indexOf(MARK_END);
    if (end === -1) {
      nodes.push(pieces[i]); // unterminated marker: show as plain text
      continue;
    }
    nodes.push(<mark key={i}>{pieces[i].slice(0, end)}</mark>);
    nodes.push(pieces[i].slice(end + 1).split(MARK_END).join(""));
  }
  return nodes;
}

interface EmailListProps {
  title: string;
  folder: ApiFolder;
  labelsById: Record<string, LabelDto>;
  emails: EmailDto[];
  /** Total rows in this view (may exceed what's loaded) and how many are unread. */
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
  selectedEmailId: number | null;
  sort: ListSort;
  onSort: (sort: ListSort) => void;
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

const FILTERS: [ListFilter, string][] = [
  ["all", "All"],
  ["unread", "Unread"],
  ["needs_action", "Needs action"],
  ["flagged", "Flagged"],
];

// Lower rank sorts first. Unanalyzed rows sink below every analyzed tier.
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
// Group headers shown between tiers while sorted by priority, indexed by rank.
const TIER_LABELS = ["HIGH PRIORITY", "MEDIUM PRIORITY", "LOW PRIORITY", "NOT ANALYZED"];

function priorityRank(triage: TriageResult | undefined): number {
  return triage && triage.triage_status === "ok" ? PRIORITY_RANK[triage.priority] : 3;
}

/** Orders loaded rows; "newest" keeps the backend order, "priority" groups by triage tier, newest first within a tier. */
function sortEmails(sort: ListSort, list: EmailDto[], triageByEmail: Record<number, TriageResult>): EmailDto[] {
  if (sort === "newest") return list;
  return [...list].sort((a, b) => {
    const byRank = priorityRank(triageByEmail[a.id]) - priorityRank(triageByEmail[b.id]);
    if (byRank !== 0) return byRank;
    return b.received_at.localeCompare(a.received_at) || b.id - a.id;
  });
}

export function EmailList({
  title,
  folder,
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
  selectedEmailId,
  sort,
  onSort,
  onOpen,
  search,
  busy,
  hasAccounts,
  onAddAccount,
  onSync,
}: EmailListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);

  // Keep the selected row in view when it changes from outside (e.g. archive moved to the next).
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedEmailId]);

  const visible = sortEmails(
    sort,
    emails.filter((e) => matchesFilter(filter, e, triageByEmail[e.id])),
    triageByEmail,
  );
  const searching = search.results !== null;
  // Flagged / Quarantine folders already contain only risky mail; the filter tab is redundant there.
  const filters = folder === "flagged" || folder === "quarantine" ? FILTERS.filter(([v]) => v !== "flagged") : FILTERS;

  const emptyCopy =
    folder === "quarantine"
      ? "Emails the on-device model rates danger show up here."
      : folder === "flagged"
        ? "Emails rated caution or danger, and any you flag yourself, show up here."
        : folder === "archive"
          ? "Archived conversations show up here."
          : "Sync to pull your inbox in.";

  return (
    <section className="list-pane">
      <header className="list-header">
        <div className="list-title-row">
          <h1>{title}</h1>
          <span className="mono list-meta">
            {total.toLocaleString()} {total === 1 ? "thread" : "threads"}
            {unreadCount > 0 && (
              <>
                {" · "}
                <span className="is-accent">{unreadCount.toLocaleString()} unread</span>
              </>
            )}
          </span>
        </div>
        <form
          className="search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            search.onSubmit();
          }}
        >
          <input
            type="search"
            placeholder="Search"
            value={search.input}
            onChange={(e) => search.onInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                search.onClear();
                e.currentTarget.blur();
              }
            }}
            aria-label={`Search ${title}`}
            autoComplete="off"
            spellCheck={false}
          />
          {search.loading ? (
            <span className="mono search-hint sm-pulse" aria-live="polite">
              searching
            </span>
          ) : search.semanticEnabled ? (
            <span className="mono search-hint is-accent" title="Search model loaded: results also include emails related by meaning">
              meaning
            </span>
          ) : null}
        </form>
        <div className="tab-row" role="tablist" aria-label="Filter">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`tab ${filter === value ? "active" : ""}`}
              onClick={() => onFilter(value)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`sort-toggle mono ${sort === "priority" ? "active" : ""}`}
            aria-pressed={sort === "priority"}
            title={sort === "priority" ? "Sorted by priority. Click for newest first." : "Sorted newest first. Click to sort by priority."}
            onClick={() => onSort(sort === "priority" ? "newest" : "priority")}
          >
            <span className="sort-label">SORT</span>
            <span className="sort-value">{sort === "priority" ? "PRIORITY" : "NEWEST"}</span>
            <span className="sort-glyph" aria-hidden="true">
              ⇅
            </span>
          </button>
        </div>
        {sort === "priority" && !searching && emails.length > 0 && !visible.some((e) => priorityRank(triageByEmail[e.id]) < 3) && (
          <p className="mono sort-hint">PRIORITY NEEDS ANALYZED THREADS · NONE IN THE LOADED MESSAGES YET</p>
        )}
      </header>

      {searching ? (
        <div className="search-banner">
          <span className="mono search-banner-text">
            {search.results!.length} {search.results!.length === 1 ? "result" : "results"} for “{search.query}” in {title}
          </span>
          <button type="button" className="link-action" onClick={search.onClear}>
            Clear
          </button>
        </div>
      ) : null}

      <div className="list-scroll" ref={scrollRef}>
        {!hasAccounts && (
          <div className="empty-state sm-fade">
            <p className="empty-title">No inbox connected</p>
            <p className="empty-copy">
              Connect a Gmail account to start. Sync uses Google's API; every analysis afterwards runs on this device.
            </p>
            <button type="button" className="btn btn-accent" disabled={busy} onClick={onAddAccount}>
              Add inbox
            </button>
          </div>
        )}

        {hasAccounts && emails.length === 0 && !searching && (
          <div className="empty-state sm-fade">
            <p className="empty-title">Nothing here</p>
            <p className="empty-copy">{emptyCopy}</p>
            {folder === "inbox" && (
              <button type="button" className="btn btn-accent" disabled={busy} onClick={onSync}>
                Sync inbox
              </button>
            )}
          </div>
        )}

        {searching && (
          <ul className="row-list">
            {search.results!.length === 0 && (
              <li className="empty-state sm-fade">
                <p className="empty-title">No results for “{search.query}”</p>
                <p className="empty-copy">
                  {search.semanticEnabled
                    ? "Nothing matched by keyword or meaning in this view."
                    : "Try a different word, or check another folder or label."}
                </p>
              </li>
            )}
            {search.results!.map((r) => {
              const triage = triageByEmail[r.email_id];
              const sender = parseSender(r.sender);
              const risk = effectiveRisk(triage);
              const flagged = risk === "danger" || risk === "caution";
              const exact = r.matched.includes("keyword");
              const selected = r.email_id === selectedEmailId;
              return (
                <li key={r.email_id} ref={selected ? selectedRef : undefined}>
                  <button
                    type="button"
                    className={`row ${selected ? "row-selected" : ""}`}
                    data-risk={flagged ? risk : "none"}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onOpen(r.email_id)}
                  >
                    <span className="row-rail" aria-hidden="true" />
                    <span className="row-top">
                      <span className="row-sender">{sender.name}</span>
                      {r.thread_count > 1 && <span className="mono row-tag">{r.thread_count}</span>}
                      <span className={`mono row-tag ${exact ? "is-accent" : "row-tag-dashed"}`} title={exact ? "Contains the words you typed" : "Related by meaning"}>
                        {exact ? "exact" : "related"}
                      </span>
                      <span className="mono row-time">{formatListTime(r.received_at)}</span>
                    </span>
                    <span className="row-subject">{r.subject || "(no subject)"}</span>
                    <span className="row-preview">{renderSnippet(r.snippet)}</span>
                    {flagged && (
                      <span className="row-flags">
                        <RiskPill risk={risk!} />
                        <span className="mono row-note">{RISK_NOTES[risk!]}</span>
                      </span>
                    )}
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
                      : "Nothing flagged. Emails rated caution or danger appear here."}
                </p>
              </li>
            )}
            {visible.map((email) => {
              const triage = triageByEmail[email.id];
              const sender = parseSender(email.sender);
              const risk = effectiveRisk(triage);
              const flagged = risk === "danger" || risk === "caution";
              const addressing = addressingFor(email, accountEmails[email.account_id] ?? null);
              const selected = email.id === selectedEmailId;
              const unread = email.thread_unread > 0;
              return (
                <li key={email.id} ref={selected ? selectedRef : undefined}>
                  <button
                    type="button"
                    className={`row ${unread ? "row-unread" : ""} ${selected ? "row-selected" : ""}`}
                    data-risk={flagged ? risk : "none"}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onOpen(email.id)}
                  >
                    <span className="row-rail" aria-hidden="true" />
                    <span className="row-top">
                      {unread && <span className="unread-dot" title="Unread" aria-label="unread" />}
                      <span className="row-sender">{sender.name}</span>
                      {email.thread_count > 1 && (
                        <span className="mono row-tag" title={`${email.thread_count} messages in this conversation`}>
                          {email.thread_count}
                        </span>
                      )}
                      {triage?.priority === "high" && !triage.done && <span className="mono row-tag is-urgent">high</span>}
                      {triage?.done && <span className="mono row-tag is-accent">done</span>}
                      {addressing === "cc" && <span className="mono row-tag">cc</span>}
                      {addressing === "none" && <span className="mono row-tag">via list</span>}
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
                    <span className={`row-preview ${triage && triage.triage_status === "ok" ? "" : "row-preview-raw"}`}>
                      {triage && triage.triage_status === "ok"
                        ? triage.summary
                        : previewLine(splitQuotedHistory(email.body_text || "").newest, 160) || "(no text)"}
                    </span>
                    {flagged && (
                      <span className="row-flags">
                        <RiskPill risk={risk!} />
                        <span className="mono row-note">{RISK_NOTES[risk!]}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {hasMore ? (
              <li className="load-older">
                <button type="button" className="link-action" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? "Loading…" : `Load older · showing ${emails.length} of ${total.toLocaleString()}`}
                </button>
              </li>
            ) : (
              <li className="mono list-end">end of {title.toLowerCase()}</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
