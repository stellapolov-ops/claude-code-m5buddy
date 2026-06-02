// Permission Relay 模块
// - 接收 CLI 的 notifications/claude/channel/permission_request
// - 把 active prompt 写入 state store（带 60s TTL）
// - 接收 buddy 的 cmd:permission decision，校验 id，映射 once/deny → allow/deny verdict
//
// v0.3.2 §5.1.2 / §5.1.3 / §6.2.1 / §11.2

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { enqueue, removeById, hasId } from "./state_store.ts";
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

      // v0.3.3 Bug C fix: enqueue (not overwrite). burst prompts 按 FIFO 排队，
      // M5 verdict 一个 → removeById → 下一个 prompt 自动 promote 到 head → snapshot 推下一个
      enqueue({
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
  // v0.3.3 Bug C fix: verdict 针对 msg.id 精确移除，不再依赖 head==id 匹配。
  // 这样队列里其他 pending prompt 不受影响，user 可以按 A 继续 verdict 下一个。
  // 但 msg.id 必须在队列里：M5 LCD 可能基于 stale snapshot 显示已被 terminal pop 的 prompt，
  // 此时按键产生的 decision 必须 drop，不能 dispatch verdict 误处理。
  if (!hasId(msg.id)) {
    log.warn(
      "buddy decision id not in queue; dropping (terminal may have already responded)",
      {
        received_id: msg.id,
        decision: msg.decision,
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
    log.error("verdict dispatch failed", {
      request_id: msg.id,
      error: String(err),
    });
  } finally {
    // 精确移除该 id：成功则使命完成；失败则避免 stale prompt 卡在队列。
    // 若 msg.id 不在队列（user 按键时 head 已被 terminal 抢先），removeById 返回 false 即可，不影响其他 entry。
    const removed = removeById(msg.id, "decision");
    if (!removed) {
      log.warn("verdict id not in queue (stale or terminal-handled)", {
        received_id: msg.id,
      });
    }
  }
}
