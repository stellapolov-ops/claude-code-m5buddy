// 心跳调度器：10s keepalive + 状态变更触发即时推送 + 5s TTL 扫描
// v0.3.2 §5.2.1 心跳触发条件

import { writeLine } from "./central.ts";
import { getActive, onChange, checkTTL } from "../state_store.ts";
import {
  getDraftChars,
  onChange as onDraftChange,
  tick as draftBufferTick,
  abortSession as abortDraftSession,
} from "../audio/draft_buffer.ts";
import { tickInactivity as voiceSessionTickInactivity } from "../audio/voice_session.ts";
import { serializeSnapshot } from "./snapshot.ts";
import { log } from "../log.ts";

const KEEPALIVE_MS = 10_000;
const TTL_SCAN_MS = 5_000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let ttlTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeDraft: (() => void) | null = null;

async function pushSnapshotNow(): Promise<void> {
  const active = getActive();
  const draftChars = getDraftChars();
  const json = serializeSnapshot({
    active: active
      ? {
          request_id: active.request_id,
          tool_name: active.tool_name,
          input_preview: active.input_preview,
        }
      : null,
    draftChars,
  });
  try {
    await writeLine(json);
    log.debug("heartbeat pushed", { has_prompt: !!active, draft_chars: draftChars });
  } catch (err) {
    // BLE 写失败不抛（v0.3.2 §9.3：失败由调用方决定）；这里 BLE 是保活路径，warn 即可
    log.warn("heartbeat push failed", { error: String(err) });
  }
}

export function startHeartbeat(): void {
  if (keepaliveTimer) {
    log.warn("startHeartbeat called when already running; ignoring");
    return;
  }
  log.info("heartbeat scheduler started", {
    keepalive_ms: KEEPALIVE_MS,
    ttl_scan_ms: TTL_SCAN_MS,
  });

  unsubscribe = onChange(() => {
    void pushSnapshotNow();
  });
  unsubscribeDraft = onDraftChange(() => {
    void pushSnapshotNow();
  });

  keepaliveTimer = setInterval(() => {
    void pushSnapshotNow();
  }, KEEPALIVE_MS);

  ttlTimer = setInterval(() => {
    const now = Date.now();
    // checkTTL 内部清空 active 时会触发 onChange → 自动推空快照
    checkTTL();
    // Draft buffer TTL: 30s pending preview + 30min idle whole-draft.
    draftBufferTick(now);
    // §7.6.1 stage 1: 60s inactivity drop on stuck recording sessions.
    // Drop matching DraftBuffer.pending too so user can still start fresh.
    for (const sid of voiceSessionTickInactivity(now)) {
      abortDraftSession(sid);
    }
  }, TTL_SCAN_MS);

  void pushSnapshotNow();
}

export function stopHeartbeat(): void {
  const wasRunning = keepaliveTimer !== null;
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (ttlTimer) {
    clearInterval(ttlTimer);
    ttlTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeDraft) {
    unsubscribeDraft();
    unsubscribeDraft = null;
  }
  if (wasRunning) {
    log.info("heartbeat scheduler stopped");
  }
}
