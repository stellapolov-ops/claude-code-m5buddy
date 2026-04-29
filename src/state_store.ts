// 单例内存 state；保存 active permission prompt + TTL
// v0.3.2 §6.2.2 active TTL = 60s；过期清空 + 推空快照（不发 verdict）

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

let active: ActivePrompt | null = null;
const listeners = new Set<(active: ActivePrompt | null) => void>();

export function getActive(): ActivePrompt | null {
  return active;
}

export function setActive(
  prompt: Omit<ActivePrompt, "created_at" | "deadline">,
): void {
  const now = Date.now();
  // 新 prompt 直接覆盖旧 active（v0.3.2 §6.2.2：新 request 优先于残留）
  if (active && active.request_id !== prompt.request_id) {
    log.warn("active prompt overwritten by newer request", {
      old_id: active.request_id,
      new_id: prompt.request_id,
    });
  }
  active = { ...prompt, created_at: now, deadline: now + ACTIVE_TTL_MS };
  notify();
}

export function clearActive(reason: "decision" | "ttl" | "shutdown"): void {
  if (!active) return;
  log.info("active cleared", { request_id: active.request_id, reason });
  active = null;
  notify();
}

// 返回 true 如果 TTL 触发清空
export function checkTTL(): boolean {
  if (active && Date.now() > active.deadline) {
    log.warn("active TTL expired", {
      request_id: active.request_id,
      age_ms: Date.now() - active.created_at,
    });
    clearActive("ttl");
    return true;
  }
  return false;
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
  for (const fn of listeners) {
    try {
      fn(active);
    } catch (err) {
      log.error("state listener threw", { error: String(err) });
    }
  }
}
