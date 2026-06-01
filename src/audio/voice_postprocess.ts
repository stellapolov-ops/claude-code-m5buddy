// Coordinator: after voice_end ack, run STT and push voice_preview (success)
// or voice_error (failure) back to M5.
//
// Decoupled from BLE: caller injects `sender` (writeLine in production, a stub
// in tests). The STT runner is also injectable for unit tests so we don't have
// to spawn whisper-cli to exercise the dispatch/truncate logic.
//
// 协议：voice_preview / voice_error BLE messages
// 字段集（铁律 2 / Day 2 决策）：voice_preview = {cmd, sid, text, full_chars}

import { transcribe, type SttOutcome } from "./stt.ts";
import { log } from "../log.ts";

export const MAX_PREVIEW_CODEPOINTS = 200;

export type LineSender = (json: string) => Promise<void>;
export type SttRunner = (wavPath: string, lang: string) => Promise<SttOutcome>;

export async function runSttAndNotify(
  sid: string,
  wavPath: string,
  lang: string,
  sender: LineSender,
  runner: SttRunner = transcribe,
): Promise<void> {
  const result = await runner(wavPath, lang);
  await dispatch(sid, result, sender);
}

async function dispatch(
  sid: string,
  result: SttOutcome,
  sender: LineSender,
): Promise<void> {
  if (!result.ok) {
    const payload: Record<string, unknown> = {
      cmd: "voice_error",
      sid,
      reason: result.error,
    };
    if (result.message) payload.message = result.message;
    const json = JSON.stringify(payload);
    log.warn("voice_error → M5", {
      sid,
      reason: result.error,
      message: result.message,
    });
    await safeSend(json, sender);
    return;
  }

  const fullChars = codePointLength(result.text);
  const truncated = codePointSlice(result.text, MAX_PREVIEW_CODEPOINTS);
  const json = JSON.stringify({
    cmd: "voice_preview",
    sid,
    text: truncated,
    full_chars: fullChars,
  });
  log.info("voice_preview → M5", {
    sid,
    full_chars: fullChars,
    preview_chars: codePointLength(truncated),
    duration_ms: result.durationMs,
    bytes: Buffer.byteLength(json, "utf8"),
  });
  await safeSend(json, sender);
}

async function safeSend(json: string, sender: LineSender): Promise<void> {
  try {
    await sender(json);
  } catch (err) {
    // BLE 断开/写失败 — 不向上抛，让 reconnect 流程自然恢复
    log.warn("voice notify send failed", { error: String(err) });
  }
}

// Slice by Unicode code points so we never split a surrogate pair or a
// multi-byte UTF-8 sequence; for CJK each character is one code point.
export function codePointSlice(text: string, maxCodePoints: number): string {
  const arr = Array.from(text);
  if (arr.length <= maxCodePoints) return text;
  return arr.slice(0, maxCodePoints).join("");
}

export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
