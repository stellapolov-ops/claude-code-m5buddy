// Permission Relay 模块
// - 接收 CLI 的 notifications/claude/channel/permission_request
// - 把 active prompt 写入 state store（带 60s TTL）
// - 接收 buddy 的 cmd:permission decision，校验 id，映射 once/deny → allow/deny verdict
//
// v0.3.2 §5.1.2 / §5.1.3 / §6.2.1 / §11.2

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { setActive, clearActive, getActive } from "./state_store.ts";
import { log } from "./log.ts";
import type { PermissionDecision } from "./ble/protocol.ts";
import { formatHint } from "./hint_formatter.ts";

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export function registerPermissionRelay(server: Server): void {
  server.setNotificationHandler(
    PermissionRequestSchema,
    async ({ params }) => {
      // 把 raw input_preview JSON 格式化为 M5 LCD 友好 hint（≤42 字符，无 JSON 标点噪音）
      const lcdHint = formatHint(params.tool_name, params.input_preview);

      log.info("permission_request received", {
        request_id: params.request_id,
        tool_name: params.tool_name,
        lcd_hint: lcdHint,
        raw_preview: params.input_preview.slice(0, 100),
      });

      setActive({
        request_id: params.request_id,
        tool_name: params.tool_name,
        description: params.description,
        input_preview: lcdHint,
      });
    },
  );
  log.info("permission_relay registered");
}

// **铁律 1 单点定义**：buddy decision → channel verdict
// 仅有 once → allow / deny → deny；无 always 第三态（v0.3.2 §11.2）
export function mapBuddyDecisionToVerdict(
  decision: "once" | "deny",
): "allow" | "deny" {
  switch (decision) {
    case "once":
      return "allow";
    case "deny":
      return "deny";
  }
}

export async function handleBuddyDecision(
  server: Server,
  msg: PermissionDecision,
): Promise<void> {
  const active = getActive();
  if (!active) {
    log.warn("buddy decision arrived but no active prompt; dropping", {
      received_id: msg.id,
      decision: msg.decision,
    });
    return;
  }
  if (msg.id !== active.request_id) {
    // v0.3.2 §6.2.3：终端先决策 → channel server 仍持有旧 active，M5 此时按键产生 stale 决策
    log.warn(
      "buddy decision id mismatch; dropping (terminal may have already responded)",
      {
        received_id: msg.id,
        active_id: active.request_id,
      },
    );
    return;
  }

  const behavior = mapBuddyDecisionToVerdict(msg.decision);
  log.info("dispatching channel verdict", {
    request_id: msg.id,
    decision: msg.decision,
    behavior,
  });

  try {
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: msg.id,
        behavior,
      },
    });
    log.info("verdict dispatched", {
      request_id: msg.id,
      note: "may be silently dropped by Claude Code if terminal already responded",
    });
  } catch (err) {
    // v0.3.2 §9.3：失败抛异常给上层；这里 catch 仅为了保证 finally 清 active
    log.error("verdict dispatch failed", {
      request_id: msg.id,
      error: String(err),
    });
  } finally {
    // 无论成功失败，清空 active：
    // - 成功：active 使命完成
    // - 失败：避免泄漏；用户感知一致性优先；TTL 是兜底但更迟
    clearActive("decision");
  }
}
