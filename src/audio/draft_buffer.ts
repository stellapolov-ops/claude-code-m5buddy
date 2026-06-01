// Draft Buffer — accumulates user voice segments across multiple recordings.
//
// Flow:
//   voice_preview success  → addPending(sid, text)        (text awaits A/B decision)
//   voice_segment_append   → pending[sid] → segments[]    (kPreview short-A)
//   voice_segment_discard  → drop pending[sid]            (kPreview short-B; idempotent)
//   voice_draft_submit     → join + emit content + clear  (kDraftIdle short-A)
//   voice_draft_discard    → clear segments               (menu; idempotent)
//   voice_session_abort    → drop pending[sid]            (idempotent)
//
// Timeouts (§7.6.1):
//   PREVIEW_TTL_MS    30s — pending[sid] drops if user never decides
//   DRAFT_IDLE_MS     30min — whole-draft idle, segments cleared
//
// Capacity (§7.2):
//   MAX_SEGMENT_COUNT 20
//   MAX_DRAFT_CHARS   5000
//
// Module-level state — there is at most one Draft Buffer per server.

import { randomUUID } from "node:crypto";
import { log } from "../log.ts";

export const PREVIEW_TTL_MS = 30_000;
export const DRAFT_IDLE_MS = 30 * 60 * 1000;
export const MAX_SEGMENT_COUNT = 20;
export const MAX_DRAFT_CHARS = 5000;

interface PendingEntry {
  text: string;
  addedAt: number;
}

let pending = new Map<string, PendingEntry>();
let segments: string[] = [];
let draftId = randomUUID();
let lastActivityAt = Date.now();

type Listener = () => void;
const listeners = new Set<Listener>();

export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { log.warn("draft_buffer listener threw", { error: String(err) }); }
  }
}

function touch(): void { lastActivityAt = Date.now(); }

export function codePointLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function totalChars(): number {
  let n = 0;
  for (const s of segments) n += codePointLen(s);
  return n;
}

export function addPending(sid: string, text: string): void {
  pending.set(sid, { text, addedAt: Date.now() });
  touch();
  // Pending alone doesn't change draft_chars; no notify.
}

export type AppendResult =
  | { ok: true; draftChars: number }
  | { ok: false; error: "sid_mismatch" | "draft_full" };

export function appendSegment(sid: string): AppendResult {
  const p = pending.get(sid);
  if (!p) return { ok: false, error: "sid_mismatch" };
  const prospectiveSegments = segments.length + 1;
  const prospectiveChars = totalChars() + codePointLen(p.text);
  if (prospectiveSegments > MAX_SEGMENT_COUNT || prospectiveChars > MAX_DRAFT_CHARS) {
    // §7.2: pending[sid] is kept so user can still discard; do not delete.
    return { ok: false, error: "draft_full" };
  }
  segments.push(p.text);
  pending.delete(sid);
  touch();
  const total = totalChars();
  log.info("draft segment appended", { sid, segment_count: segments.length, draft_chars: total });
  notify();
  return { ok: true, draftChars: total };
}

// §6.1.2.1 idempotent — ok:true even when pending[sid] doesn't exist.
export function discardSegment(sid: string): { draftChars: number } {
  const existed = pending.delete(sid);
  if (existed) log.info("draft segment discarded", { sid });
  touch();
  return { draftChars: totalChars() };
}

export type SubmitPreview =
  | { ok: true; content: string; draftId: string; segmentCount: number }
  | { ok: false; error: "draft_empty" };

// Two-phase submit (§6.1.2 review P2-4): peek the content + meta without
// mutating state; caller awaits any async dispatch (e.g. MCP notification),
// then calls commitSubmit() iff dispatch succeeded. On dispatch failure
// segments/draft_id stay intact so user can retry.
export function peekSubmit(): SubmitPreview {
  if (segments.length === 0) return { ok: false, error: "draft_empty" };
  return {
    ok: true,
    content: joinSegments(segments),
    draftId,
    segmentCount: segments.length,
  };
}

export function commitSubmit(expectedDraftId: string): boolean {
  if (draftId !== expectedDraftId) {
    // Race: user discarded / submitted concurrently in between peek and commit.
    log.warn("commitSubmit draft_id mismatch — refusing", {
      expected: expectedDraftId,
      actual: draftId,
    });
    return false;
  }
  log.info("draft committed", {
    draft_id: draftId,
    segment_count: segments.length,
  });
  segments = [];
  draftId = randomUUID();
  touch();
  notify();
  return true;
}

// §6.4 joining rule: trim each, drop empties, join with newline.
export function joinSegments(segs: string[]): string {
  return segs.map((s) => s.trim()).filter(Boolean).join("\n");
}

// §6.1.2.1 idempotent.
export function discardDraft(): { draftChars: number } {
  const had = segments.length > 0;
  if (had) {
    segments = [];
    draftId = randomUUID();
    log.info("draft discarded by user");
    touch();
    notify();
  }
  return { draftChars: 0 };
}

// §6.1.2.1 idempotent.
export function abortSession(sid: string): void {
  pending.delete(sid);
  touch();
}

export function getDraftChars(): number { return totalChars(); }
export function getDraftId(): string { return draftId; }
export function getSegmentCount(): number { return segments.length; }
export function getPendingSize(): number { return pending.size; }

// Periodic tick — drains expired pending + applies idle timeout.
// Caller picks the cadence (server.ts wires it to ~5s).
export function tick(now: number = Date.now()): void {
  let changed = false;

  for (const [sid, p] of pending) {
    if (now - p.addedAt > PREVIEW_TTL_MS) {
      pending.delete(sid);
      log.info("draft pending expired", { sid, ttl_ms: PREVIEW_TTL_MS });
      // No state change for snapshot (pending doesn't affect draft_chars).
    }
  }

  if (segments.length > 0 && now - lastActivityAt > DRAFT_IDLE_MS) {
    log.info("draft idle timeout — clearing", {
      idle_ms: now - lastActivityAt,
      threshold_ms: DRAFT_IDLE_MS,
      segment_count: segments.length,
    });
    segments = [];
    draftId = randomUUID();
    lastActivityAt = now;
    changed = true;
  }

  if (changed) notify();
}

// Test-only helpers.
export function _resetForTest(): void {
  pending.clear();
  segments = [];
  draftId = randomUUID();
  lastActivityAt = Date.now();
  listeners.clear();
}

export function _snapshotForTest() {
  return {
    pendingSids: Array.from(pending.keys()),
    segments: [...segments],
    draftId,
    draftChars: totalChars(),
    lastActivityAt,
  };
}
