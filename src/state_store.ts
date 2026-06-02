// 单例内存 state；FIFO queue of pending permission prompts + 每 entry 独立 TTL
// v0.3.3 §6.2.2 active TTL = 60s；过期清空 + 推空快照（不发 verdict）
// v0.3.3 Bug C 修复：burst 多 prompt 不再覆盖，按 FIFO 排队让 M5 逐个 verdict

import { log } from "./log.ts";

export type ActivePrompt = {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  created_at: number;
  deadline: number;
};

const ACTIVE_TTL_MS = 60_000;

let queue: ActivePrompt[] = [];
let lastNotifiedHeadId: string | null = null;
const listeners = new Set<(active: ActivePrompt | null) => void>();

export function getActive(): ActivePrompt | null {
  return queue[0] ?? null;
}

export function enqueue(
  prompt: Omit<ActivePrompt, "created_at" | "deadline">,
): void {
  const now = Date.now();
  const entry: ActivePrompt = {
    ...prompt,
    created_at: now,
    deadline: now + ACTIVE_TTL_MS,
  };
  // 同 request_id 幂等：CLI 重发同 id 时刷新 TTL 而非重复入队
  const existing = queue.findIndex((p) => p.request_id === entry.request_id);
  if (existing >= 0) {
    queue[existing] = entry;
    log.debug("prompt re-enqueued (TTL refreshed)", { request_id: entry.request_id });
  } else {
    queue.push(entry);
    log.debug("prompt enqueued", {
      request_id: entry.request_id,
      queue_depth: queue.length,
    });
  }
  notify();
}

// 兼容旧调用方
export const setActive = enqueue;

export function removeById(
  request_id: string,
  reason: "decision" | "ttl" | "shutdown",
): boolean {
  const idx = queue.findIndex((p) => p.request_id === request_id);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  log.info("prompt removed", { request_id, reason, queue_depth: queue.length });
  notify();
  return true;
}

// 清整个队列（仅 shutdown 用）
export function clearAll(reason: "shutdown"): void {
  if (queue.length === 0) return;
  log.info("queue cleared", { count: queue.length, reason });
  queue = [];
  notify();
}

// 兼容旧 API：清队首（按 reason 含义）
export function clearActive(reason: "decision" | "ttl" | "shutdown"): void {
  const head = queue[0];
  if (!head) return;
  removeById(head.request_id, reason);
}

// 扫描整个队列移除过期 entry；返回是否有任何 entry 被清掉
export function checkTTL(): boolean {
  const now = Date.now();
  const before = queue.length;
  const survivors: ActivePrompt[] = [];
  for (const p of queue) {
    if (now > p.deadline) {
      log.warn("prompt TTL expired", {
        request_id: p.request_id,
        age_ms: now - p.created_at,
      });
    } else {
      survivors.push(p);
    }
  }
  if (survivors.length === before) return false;
  queue = survivors;
  notify();
  return true;
}

export function queueDepth(): number {
  return queue.length;
}

export function hasId(request_id: string): boolean {
  return queue.some((p) => p.request_id === request_id);
}

export function onChange(
  fn: (active: ActivePrompt | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  const head = queue[0] ?? null;
  const headId = head?.request_id ?? null;
  // 只在队首变化时推送，避免 head 不变时重复 BLE write（与 Bug A/B 缓解一致）
  if (headId === lastNotifiedHeadId) return;
  lastNotifiedHeadId = headId;
  for (const fn of listeners) {
    try {
      fn(head);
    } catch (err) {
      log.error("state listener threw", { error: String(err) });
    }
  }
}
