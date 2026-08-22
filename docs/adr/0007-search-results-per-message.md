# ADR 0007: Search results are per message, shown with thread context

- Status: accepted
- Date: 2026-08-22

## Context

The inbox list is one row per conversation (latest message shown). Search ranks
individual messages, and several messages in one thread can match for different reasons.

## Decision

Each result row is the specific message that matched. The row shows the thread's subject,
a "n in thread" tag when the conversation has more than one message, and the matching
snippet from that message. Opening a result lands on that message with the thread history
visible, exactly as opening a thread from the inbox does. Hits are not collapsed by
thread.

## Consequences

- `SearchResultDto` carries `gmail_thread_id` and `thread_count`.
- Two rows can share a subject; the snippet and time disambiguate them.
- Ranking stays per message; no thread-level aggregation logic is needed.
