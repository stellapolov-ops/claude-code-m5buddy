// BLE RX JSON 行解析（buddy 协议 + Phase 2 voice 扩展）
// 已识别消息类型：
//   - cmd:permission（M5 用户决策）
//   - ack:*（buddy 响应）
//   - cmd:voice_start / voice_end / voice_session_abort（Phase 2 §6.1）

import { z } from "zod";
import { log } from "../log.ts";

const PermissionDecisionSchema = z.object({
  cmd: z.literal("permission"),
  id: z.string(),
  decision: z.enum(["once", "deny"]),
});

const AckSchema = z
  .object({
    ack: z.string(),
    ok: z.boolean(),
  })
  .passthrough();

const SidHexSchema = z.string().regex(/^[0-9a-f]{16}$/);

const VoiceStartSchema = z.object({
  cmd: z.literal("voice_start"),
  sid: SidHexSchema,
  codec: z.string(),
  rate: z.number(),
  ch: z.number(),
});

const VoiceEndSchema = z.object({
  cmd: z.literal("voice_end"),
  sid: SidHexSchema,
  total_chunks: z.number(),
});

const VoiceAbortSchema = z.object({
  cmd: z.literal("voice_session_abort"),
  sid: SidHexSchema,
  reason: z.string().optional(),
});

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
export type AckMessage = z.infer<typeof AckSchema>;
export type VoiceStart = z.infer<typeof VoiceStartSchema>;
export type VoiceEnd = z.infer<typeof VoiceEndSchema>;
export type VoiceAbort = z.infer<typeof VoiceAbortSchema>;

export type ProtocolHandlers = {
  onPermissionDecision: (msg: PermissionDecision) => void;
  onAck?: (msg: AckMessage) => void;
  onVoiceStart?: (msg: VoiceStart) => void;
  onVoiceEnd?: (msg: VoiceEnd) => void;
  onVoiceAbort?: (msg: VoiceAbort) => void;
};

export function handleLine(line: string, handlers: ProtocolHandlers): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    log.warn("BLE RX invalid JSON", { line, error: String(err) });
    return;
  }

  // Voice commands first (cmd-based, schema-strict)
  const voiceStart = VoiceStartSchema.safeParse(parsed);
  if (voiceStart.success) {
    handlers.onVoiceStart?.(voiceStart.data);
    return;
  }
  const voiceEnd = VoiceEndSchema.safeParse(parsed);
  if (voiceEnd.success) {
    handlers.onVoiceEnd?.(voiceEnd.data);
    return;
  }
  const voiceAbort = VoiceAbortSchema.safeParse(parsed);
  if (voiceAbort.success) {
    handlers.onVoiceAbort?.(voiceAbort.data);
    return;
  }

  // buddy permission cmd
  const permResult = PermissionDecisionSchema.safeParse(parsed);
  if (permResult.success) {
    handlers.onPermissionDecision(permResult.data);
    return;
  }

  // generic ack (passthrough)
  const ackResult = AckSchema.safeParse(parsed);
  if (ackResult.success) {
    handlers.onAck?.(ackResult.data);
    return;
  }

  log.debug("BLE RX unknown shape", { line });
}
