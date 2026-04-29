// BLE RX JSON 行解析（buddy 协议）
// 已识别消息类型：cmd:permission（M5 用户决策）、ack:*（buddy 响应）

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

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
export type AckMessage = z.infer<typeof AckSchema>;

export type ProtocolHandlers = {
  onPermissionDecision: (msg: PermissionDecision) => void;
  onAck?: (msg: AckMessage) => void;
};

export function handleLine(line: string, handlers: ProtocolHandlers): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    log.warn("BLE RX invalid JSON", { line, error: String(err) });
    return;
  }

  const permResult = PermissionDecisionSchema.safeParse(parsed);
  if (permResult.success) {
    handlers.onPermissionDecision(permResult.data);
    return;
  }

  const ackResult = AckSchema.safeParse(parsed);
  if (ackResult.success) {
    handlers.onAck?.(ackResult.data);
    return;
  }

  log.debug("BLE RX unknown shape", { line });
}
