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

// §6.1.2 Draft 操作（M5 → PC）
const VoiceSegmentAppendSchema = z.object({
  cmd: z.literal("voice_segment_append"),
  sid: SidHexSchema,
});
const VoiceSegmentDiscardSchema = z.object({
  cmd: z.literal("voice_segment_discard"),
  sid: SidHexSchema,
});
const VoiceDraftSubmitSchema = z.object({
  cmd: z.literal("voice_draft_submit"),
});
const VoiceDraftDiscardSchema = z.object({
  cmd: z.literal("voice_draft_discard"),
});

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
export type AckMessage = z.infer<typeof AckSchema>;
export type VoiceStart = z.infer<typeof VoiceStartSchema>;
export type VoiceEnd = z.infer<typeof VoiceEndSchema>;
export type VoiceAbort = z.infer<typeof VoiceAbortSchema>;
export type VoiceSegmentAppend = z.infer<typeof VoiceSegmentAppendSchema>;
export type VoiceSegmentDiscard = z.infer<typeof VoiceSegmentDiscardSchema>;
export type VoiceDraftSubmit = z.infer<typeof VoiceDraftSubmitSchema>;
export type VoiceDraftDiscard = z.infer<typeof VoiceDraftDiscardSchema>;

export type ProtocolHandlers = {
  onPermissionDecision: (msg: PermissionDecision) => void;
  onAck?: (msg: AckMessage) => void;
  onVoiceStart?: (msg: VoiceStart) => void;
  onVoiceEnd?: (msg: VoiceEnd) => void;
  onVoiceAbort?: (msg: VoiceAbort) => void;
  onVoiceSegmentAppend?: (msg: VoiceSegmentAppend) => void;
  onVoiceSegmentDiscard?: (msg: VoiceSegmentDiscard) => void;
  onVoiceDraftSubmit?: (msg: VoiceDraftSubmit) => void;
  onVoiceDraftDiscard?: (msg: VoiceDraftDiscard) => void;
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
  const segAppend = VoiceSegmentAppendSchema.safeParse(parsed);
  if (segAppend.success) {
    handlers.onVoiceSegmentAppend?.(segAppend.data);
    return;
  }
  const segDiscard = VoiceSegmentDiscardSchema.safeParse(parsed);
  if (segDiscard.success) {
    handlers.onVoiceSegmentDiscard?.(segDiscard.data);
    return;
  }
  const draftSubmit = VoiceDraftSubmitSchema.safeParse(parsed);
  if (draftSubmit.success) {
    handlers.onVoiceDraftSubmit?.(draftSubmit.data);
    return;
  }
  const draftDiscard = VoiceDraftDiscardSchema.safeParse(parsed);
  if (draftDiscard.success) {
    handlers.onVoiceDraftDiscard?.(draftDiscard.data);
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
