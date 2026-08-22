import { useMemo, useState } from "react";
import type { MeetingDto } from "../types";

interface CalendarMonthProps {
  meetings: MeetingDto[];
  /** Month currently shown; the parent owns it so it can refetch on change. */
  month: Date;
  onChangeMonth: (next: Date) => void;
  onOpenSource: (emailId: number) => void;
  onJoin: (url: string) => void;
  onDismiss: (meetingId: number) => void;
  scanning: boolean;
  scanProgress: { done: number; total: number } | null;
  onScan: () => void;
  modelReady: boolean;
  onOpenSettings: () => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Monday-first offset for the 1st of the month (JS getDay() is Sunday-first). */
function leadingBlanks(first: Date): number {
  return (first.getDay() + 6) % 7;
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** "2026-08-22T15:30" -> "15:30". Parsed by hand: these are local wall-clock times with no
 *  zone, and `new Date(...)` would re-interpret them against the browser's timezone. */
function timeOf(startsAt: string): string {
  const t = startsAt.split("T")[1] ?? "";
  return t.slice(0, 5);
}

function dayOf(startsAt: string): number {
  const day = startsAt.split("T")[0]?.split("-")[2];
  return day ? Number(day) : NaN;
}

function CameraIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" fill="currentColor" />
      <path d="M15 11l6-3.5v9L15 13z" fill="currentColor" />
    </svg>
  );
}

export function CalendarMonth({
  meetings,
  month,
  onChangeMonth,
  onOpenSource,
  onJoin,
  onDismiss,
  scanning,
  scanProgress,
  onScan,
  modelReady,
  onOpenSettings,
}: CalendarMonthProps) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // The open day belongs to the month it was opened in; carrying it across navigation would
  // leave the same day number spuriously expanded in the new month.
  const changeMonth = (next: Date) => {
    setSelectedDay(null);
    onChangeMonth(next);
  };

  const byDay = useMemo(() => {
    const map = new Map<number, MeetingDto[]>();
    for (const m of meetings) {
      const day = dayOf(m.starts_at);
      if (Number.isNaN(day)) continue;
      const list = map.get(day) ?? [];
      list.push(m);
      map.set(day, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return map;
  }, [meetings]);

  const first = startOfMonth(month);
  const blanks = leadingBlanks(first);
  const total = daysInMonth(month);
  const today = new Date();
  const monthLabel = month.toLocaleString(undefined, { month: "long", year: "numeric" });

  const cells: (number | null)[] = [
    ...Array<null>(blanks).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const confirmedCount = meetings.filter((m) => m.kind === "confirmed").length;

  return (
    <section className="calendar">
      <header className="calendar-head">
        <div className="calendar-title">
          <h2>{monthLabel}</h2>
          <span className="mono calendar-sub">
            {meetings.length === 0
              ? "No meetings this month"
              : `${meetings.length} MEETING${meetings.length === 1 ? "" : "S"} · ${confirmedCount} WITH LINKS`}
          </span>
        </div>
        <div className="calendar-actions">
          <button
            type="button"
            className="btn btn-mini mono"
            onClick={() => changeMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            ‹ Prev
          </button>
          <button
            type="button"
            className="btn btn-mini mono"
            onClick={() => changeMonth(startOfMonth(new Date()))}
          >
            Today
          </button>
          <button
            type="button"
            className="btn btn-mini mono"
            onClick={() => changeMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            Next ›
          </button>
          <button
            type="button"
            className="btn btn-accent btn-mini mono"
            disabled={scanning || !modelReady}
            onClick={modelReady ? onScan : onOpenSettings}
            title={modelReady ? "Read your mail for meetings" : "The on-device model isn't loaded"}
          >
            {scanning
              ? scanProgress
                ? `Scanning ${scanProgress.done}/${scanProgress.total}…`
                : "Scanning…"
              : "Scan mail"}
          </button>
        </div>
      </header>

      {!modelReady && (
        <p className="calendar-hint">
          Meetings are found by the on-device model.{" "}
          <button type="button" className="linkish" onClick={onOpenSettings}>
            Turn on analysis
          </button>{" "}
          to scan your mail.
        </p>
      )}

      <div className="calendar-grid" role="grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="mono calendar-weekday" role="columnheader">
            {w}
          </div>
        ))}

        {cells.map((day, i) => {
          if (day === null) return <div key={`blank-${i}`} className="calendar-cell is-blank" />;
          const dayMeetings = byDay.get(day) ?? [];
          const cellDate = new Date(month.getFullYear(), month.getMonth(), day);
          const isToday = isSameDay(cellDate, today);
          const isPast = cellDate < today && !isToday;
          const expanded = selectedDay === day;
          return (
            <div
              key={day}
              role="gridcell"
              className={`calendar-cell ${isToday ? "is-today" : ""} ${isPast ? "is-past" : ""} ${
                expanded ? "is-expanded" : ""
              }`}
              onClick={() => setSelectedDay(expanded ? null : day)}
            >
              <button
                type="button"
                className="mono calendar-daynum"
                aria-expanded={expanded}
                aria-label={`${day} ${monthLabel}, ${dayMeetings.length} meeting${
                  dayMeetings.length === 1 ? "" : "s"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedDay(expanded ? null : day);
                }}
              >
                {day}
              </button>
              <ul className="calendar-events">
                {dayMeetings.map((m) => (
                  <li key={m.id} className={`calendar-event is-${m.kind}`}>
                    <button
                      type="button"
                      className="calendar-event-btn"
                      title={`${m.title} · ${timeOf(m.starts_at)}${
                        m.kind === "possible" ? " · not confirmed" : ""
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (m.source_email_id !== null) onOpenSource(m.source_email_id);
                      }}
                    >
                      {m.join_url && (
                        <span className="calendar-event-icon" title="Has a meeting link">
                          <CameraIcon />
                        </span>
                      )}
                      <span className="mono calendar-event-time">{timeOf(m.starts_at)}</span>
                      <span className="calendar-event-title">{m.title}</span>
                    </button>
                    {expanded && (
                      <span className="calendar-event-tools">
                        {m.join_url && (
                          <button
                            type="button"
                            className="mono calendar-event-join"
                            onClick={(e) => {
                              e.stopPropagation();
                              onJoin(m.join_url as string);
                            }}
                          >
                            JOIN
                          </button>
                        )}
                        <button
                          type="button"
                          className="mono calendar-event-dismiss"
                          title="Hide this meeting for good"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismiss(m.id);
                          }}
                        >
                          DISMISS
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <footer className="calendar-legend mono">
        <span className="calendar-legend-item">
          <span className="calendar-swatch is-confirmed" /> Confirmed · has link
        </span>
        <span className="calendar-legend-item">
          <span className="calendar-swatch is-possible" /> Possible · both sides agreed
        </span>
        <span className="calendar-legend-note">
          Times are read from the email text and may be wrong - open the email to check.
        </span>
      </footer>
    </section>
  );
}
