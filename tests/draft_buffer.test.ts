import { afterEach, describe, expect, test } from "bun:test";

import {
  addPending,
  appendSegment,
  discardSegment,
  peekSubmit,
  commitSubmit,
  discardDraft,
  abortSession,
  getDraftChars,
  getSegmentCount,
  getPendingSize,
  tick,
  PREVIEW_TTL_MS,
  DRAFT_IDLE_MS,
  MAX_SEGMENT_COUNT,
  MAX_DRAFT_CHARS,
  joinSegments,
  codePointLen,
  onChange,
  _resetForTest,
  _snapshotForTest,
} from "../src/audio/draft_buffer";

const SID1 = "1111111111111111";
const SID2 = "2222222222222222";

afterEach(() => _resetForTest());

describe("appendSegment happy path", () => {
  test("pending → segment, draft_chars updated", () => {
    addPending(SID1, "你好");
    expect(getPendingSize()).toBe(1);
    expect(getDraftChars()).toBe(0); // pending alone doesn't count

    const r = appendSegment(SID1);
    expect(r).toEqual({ ok: true, draftChars: 2 });
    expect(getSegmentCount()).toBe(1);
    expect(getPendingSize()).toBe(0);
    expect(getDraftChars()).toBe(2);
  });

  test("two segments accumulate", () => {
    addPending(SID1, "第一段");
    appendSegment(SID1);
    addPending(SID2, "第二段");
    appendSegment(SID2);
    expect(getDraftChars()).toBe(6);
    expect(getSegmentCount()).toBe(2);
  });
});

describe("appendSegment error paths", () => {
  test("sid_mismatch when pending doesn't exist", () => {
    const r = appendSegment(SID1);
    expect(r).toEqual({ ok: false, error: "sid_mismatch" });
  });

  test("draft_full when segment count would exceed MAX_SEGMENT_COUNT", () => {
    for (let i = 0; i < MAX_SEGMENT_COUNT; i++) {
      addPending(`${i.toString().padStart(16, "0")}`, "x");
      expect(appendSegment(`${i.toString().padStart(16, "0")}`).ok).toBe(true);
    }
    addPending(SID1, "overflow");
    const r = appendSegment(SID1);
    expect(r).toEqual({ ok: false, error: "draft_full" });
    // §7.2: pending[sid] kept so user can still discard
    expect(getPendingSize()).toBe(1);
  });

  test("draft_full when chars would exceed MAX_DRAFT_CHARS", () => {
    addPending(SID1, "a".repeat(MAX_DRAFT_CHARS - 10));
    appendSegment(SID1);
    addPending(SID2, "b".repeat(20)); // would push over 5000
    const r = appendSegment(SID2);
    expect(r).toEqual({ ok: false, error: "draft_full" });
    expect(getPendingSize()).toBe(1);
  });
});

describe("discardSegment idempotent (§6.1.2.1)", () => {
  test("returns ok even when pending[sid] missing", () => {
    const r = discardSegment(SID1);
    expect(r).toEqual({ draftChars: 0 });
  });

  test("removes pending", () => {
    addPending(SID1, "x");
    discardSegment(SID1);
    expect(getPendingSize()).toBe(0);
  });
});

describe("two-phase submit (peek + commit)", () => {
  test("happy path: peek returns content + commit clears", () => {
    addPending(SID1, "第一段");
    appendSegment(SID1);
    addPending(SID2, "第二段");
    appendSegment(SID2);

    const p = peekSubmit();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.content).toBe("第一段\n第二段");
    expect(p.segmentCount).toBe(2);
    expect(p.draftId).toBeTruthy();

    // Before commit, segments still intact.
    expect(getSegmentCount()).toBe(2);
    expect(getDraftChars()).toBe(6);

    const committed = commitSubmit(p.draftId);
    expect(committed).toBe(true);
    expect(getSegmentCount()).toBe(0);
    expect(getDraftChars()).toBe(0);
  });

  test("simulated MCP failure: segments retained when commit not called", () => {
    addPending(SID1, "重要内容");
    appendSegment(SID1);

    const p = peekSubmit();
    expect(p.ok).toBe(true);
    // Imagine MCP notification throws here — caller never invokes commitSubmit.
    expect(getSegmentCount()).toBe(1);
    expect(getDraftChars()).toBe(4);
  });

  test("commit refuses stale draft_id (race protection)", () => {
    addPending(SID1, "x");
    appendSegment(SID1);
    const p = peekSubmit();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // User discards before commit.
    discardDraft();
    expect(commitSubmit(p.draftId)).toBe(false);
  });

  test("peek empty → draft_empty", () => {
    expect(peekSubmit()).toEqual({ ok: false, error: "draft_empty" });
  });
});

describe("discardDraft idempotent (§6.1.2.1)", () => {
  test("ok:true on empty draft", () => {
    expect(discardDraft()).toEqual({ draftChars: 0 });
  });

  test("clears and rotates draftId", () => {
    addPending(SID1, "x");
    appendSegment(SID1);
    const idBefore = _snapshotForTest().draftId;
    discardDraft();
    const idAfter = _snapshotForTest().draftId;
    expect(idAfter).not.toBe(idBefore);
    expect(getSegmentCount()).toBe(0);
  });
});

describe("abortSession idempotent (§6.1.2.1)", () => {
  test("ok even when sid unknown", () => {
    // returns void; just check no throw
    abortSession("ffffffffffffffff");
  });

  test("drops pending but keeps committed segments", () => {
    addPending(SID1, "已 append");
    appendSegment(SID1);
    addPending(SID2, "pending only");
    abortSession(SID2);
    expect(getPendingSize()).toBe(0);
    expect(getSegmentCount()).toBe(1);
  });
});

describe("tick — TTL", () => {
  test("pending past PREVIEW_TTL_MS dropped", () => {
    addPending(SID1, "x");
    const t0 = _snapshotForTest().lastActivityAt;
    tick(t0 + PREVIEW_TTL_MS + 1);
    expect(getPendingSize()).toBe(0);
  });

  test("pending within TTL kept", () => {
    addPending(SID1, "x");
    const t0 = _snapshotForTest().lastActivityAt;
    tick(t0 + PREVIEW_TTL_MS - 1000);
    expect(getPendingSize()).toBe(1);
  });

  test("idle 30min clears segments", () => {
    addPending(SID1, "残留");
    appendSegment(SID1);
    const t0 = _snapshotForTest().lastActivityAt;
    tick(t0 + DRAFT_IDLE_MS + 1);
    expect(getSegmentCount()).toBe(0);
    expect(getDraftChars()).toBe(0);
  });

  test("idle timer doesn't fire when no segments", () => {
    const t0 = _snapshotForTest().lastActivityAt;
    tick(t0 + DRAFT_IDLE_MS + 1);
    // No segments to clear; no notify expected; just shouldn't throw.
    expect(getSegmentCount()).toBe(0);
  });
});

describe("onChange notifications", () => {
  test("fires on appendSegment, discardDraft, commitSubmit", () => {
    let count = 0;
    onChange(() => count++);
    addPending(SID1, "x");
    expect(count).toBe(0);                    // addPending alone doesn't notify
    appendSegment(SID1);
    expect(count).toBe(1);
    addPending(SID2, "y");
    appendSegment(SID2);
    expect(count).toBe(2);
    discardDraft();
    expect(count).toBe(3);
  });

  test("commitSubmit fires once", () => {
    let count = 0;
    onChange(() => count++);
    addPending(SID1, "x");
    appendSegment(SID1);
    const p = peekSubmit();
    if (!p.ok) throw new Error("setup fail");
    count = 0; // reset
    commitSubmit(p.draftId);
    expect(count).toBe(1);
  });
});

describe("joinSegments rule (§6.4)", () => {
  test("joins with newline", () => {
    expect(joinSegments(["a", "b", "c"])).toBe("a\nb\nc");
  });
  test("trims each", () => {
    expect(joinSegments(["  hi  ", "\nbye\n"])).toBe("hi\nbye");
  });
  test("filters empties", () => {
    expect(joinSegments(["a", "", "  ", "b"])).toBe("a\nb");
  });
});

describe("codePointLen", () => {
  test("CJK each codepoint counted as 1", () => {
    expect(codePointLen("你好世界")).toBe(4);
  });
  test("ASCII", () => {
    expect(codePointLen("hello")).toBe(5);
  });
  test("emoji not split", () => {
    expect(codePointLen("a😀b")).toBe(3);
  });
});
