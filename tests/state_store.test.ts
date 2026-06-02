// state_store FIFO queue 行为测试（v0.3.3 Bug C 修复）
// 覆盖：enqueue / head / removeById / TTL / 同 id 幂等 / onChange 仅在 head 变化时触发

import { beforeEach, describe, expect, test } from "bun:test";
import {
  enqueue,
  removeById,
  getActive,
  hasId,
  queueDepth,
  checkTTL,
  clearAll,
  onChange,
} from "../src/state_store.ts";

function makePrompt(id: string, tool = "Bash"): {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
} {
  return {
    request_id: id,
    tool_name: tool,
    description: `desc for ${id}`,
    input_preview: `hint for ${id}`,
  };
}

beforeEach(() => {
  // 重置全模块单例 state；不重置 listeners（每次 test 自己解绑）
  clearAll("shutdown");
});

describe("FIFO queue basics", () => {
  test("empty queue: head is null, depth 0", () => {
    expect(getActive()).toBeNull();
    expect(queueDepth()).toBe(0);
    expect(hasId("anything")).toBe(false);
  });

  test("enqueue n prompts: head is first in, depth grows", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    enqueue(makePrompt("C"));
    expect(queueDepth()).toBe(3);
    expect(getActive()?.request_id).toBe("A");
    expect(hasId("B")).toBe(true);
  });

  test("removeById head: next promotes", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    expect(removeById("A", "decision")).toBe(true);
    expect(getActive()?.request_id).toBe("B");
    expect(queueDepth()).toBe(1);
  });

  test("removeById middle: head unchanged", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    enqueue(makePrompt("C"));
    expect(removeById("B", "decision")).toBe(true);
    expect(getActive()?.request_id).toBe("A");
    expect(queueDepth()).toBe(2);
    expect(hasId("B")).toBe(false);
  });

  test("removeById missing: returns false, queue intact", () => {
    enqueue(makePrompt("A"));
    expect(removeById("ZZZ", "decision")).toBe(false);
    expect(queueDepth()).toBe(1);
    expect(getActive()?.request_id).toBe("A");
  });
});

describe("Same-id re-enqueue (idempotent)", () => {
  test("re-enqueue same id: depth unchanged, position preserved", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    enqueue(makePrompt("A")); // re-enqueue head
    expect(queueDepth()).toBe(2);
    expect(getActive()?.request_id).toBe("A");
  });

  test("re-enqueue refreshes deadline (TTL)", async () => {
    enqueue(makePrompt("A"));
    const first = getActive();
    expect(first).not.toBeNull();
    const firstDeadline = first!.deadline;
    // wait 5ms, re-enqueue
    await new Promise((r) => setTimeout(r, 5));
    enqueue(makePrompt("A"));
    const refreshed = getActive();
    expect(refreshed!.deadline).toBeGreaterThan(firstDeadline);
  });
});

describe("TTL expiry", () => {
  test("checkTTL removes only expired entries, keeps fresh ones", async () => {
    // 入队 A，等 TTL 过去（modify TTL is internal so we use real time + short waits)
    // 直接用 monkey-patch deadline 模拟过期
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    const head = getActive()!;
    head.deadline = Date.now() - 1000; // 强制 A 过期
    const cleaned = checkTTL();
    expect(cleaned).toBe(true);
    expect(queueDepth()).toBe(1);
    expect(getActive()?.request_id).toBe("B");
  });

  test("checkTTL returns false when nothing expires", () => {
    enqueue(makePrompt("A"));
    expect(checkTTL()).toBe(false);
    expect(queueDepth()).toBe(1);
  });
});

describe("onChange notification (only on head change)", () => {
  test("enqueue first prompt: head changes from null → A, fires", () => {
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    enqueue(makePrompt("A"));
    expect(calls).toEqual(["A"]);
    unsub();
  });

  test("burst enqueue: only first triggers (head stays A)", () => {
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    enqueue(makePrompt("C"));
    enqueue(makePrompt("D"));
    enqueue(makePrompt("E"));
    expect(calls).toEqual(["A"]); // critical: 5 burst → 1 BLE write (Bug B 缓解)
    unsub();
  });

  test("verdict pop: head A → B fires once", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    removeById("A", "decision");
    expect(calls).toEqual(["B"]);
    unsub();
  });

  test("removeById middle (non-head): does NOT fire", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    enqueue(makePrompt("C"));
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    removeById("B", "decision"); // 中间，head 不变
    expect(calls).toEqual([]);
    unsub();
  });

  test("re-enqueue same head: does NOT fire", () => {
    enqueue(makePrompt("A"));
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    enqueue(makePrompt("A"));
    expect(calls).toEqual([]);
    unsub();
  });

  test("empty out queue: head → null fires", () => {
    enqueue(makePrompt("A"));
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    removeById("A", "decision");
    expect(calls).toEqual([null]);
    unsub();
  });
});

describe("clearAll", () => {
  test("clearAll empties queue and fires once if non-empty", () => {
    enqueue(makePrompt("A"));
    enqueue(makePrompt("B"));
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    clearAll("shutdown");
    expect(queueDepth()).toBe(0);
    expect(calls).toEqual([null]);
    unsub();
  });

  test("clearAll on empty: no-op", () => {
    let calls: Array<string | null> = [];
    const unsub = onChange((p) => calls.push(p?.request_id ?? null));
    clearAll("shutdown");
    expect(calls).toEqual([]);
    unsub();
  });
});
