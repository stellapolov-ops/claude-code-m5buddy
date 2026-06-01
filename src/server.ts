#!/usr/bin/env bun
// m5buddy MCP channel server
// Phase 1: 审批 relay (审批 v0.3.2)
//
// 主循环：MCP server (stdio) + BLE central (with retry) + heartbeat scheduler
// fail-open 设计：BLE 连不上时 channel 仍正常运行，让本地终端对话框接管

// 故意使用 Server（low-level）而非 McpServer（high-level）：
// channel 需要发 custom notification（permission verdict）+ 处理 custom request handler，
// 官方 SDK 文档指出此类 "advanced usage" 必须用 Server。
// IDE 的 deprecated 警告可忽略。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, LOG_FILE_PATH } from "./log.ts";
import { connectAndSubscribe, disconnect, writeLine } from "./ble/central.ts";
import { startHeartbeat, stopHeartbeat } from "./ble/heartbeat.ts";
import { handleLine } from "./ble/protocol.ts";
import {
  registerPermissionRelay,
  handleBuddyDecision,
} from "./permission_relay.ts";
import {
  onVoiceStart,
  onVoiceFrame,
  onVoiceEnd,
  onVoiceAbort,
} from "./audio/voice_session.ts";
import { runSttAndNotify } from "./audio/voice_postprocess.ts";
import {
  appendSegment,
  discardSegment,
  peekSubmit,
  commitSubmit,
  discardDraft,
  abortSession as abortDraftSession,
  getDraftChars,
} from "./audio/draft_buffer.ts";

const BLE_RECONNECT_DELAY_MS = 5_000;
const BLE_INITIAL_BACKOFF_MS = 60_000;

// BLE 启用开关（Phase 1）
// 默认不连 BLE：避免多 CC session 共享同一 .mcp.json 时互相抢 BLE 连接
// 仅 channel session 启动时显式 export M5BUDDY_ENABLE_BLE=1
const ENABLE_BLE = process.env.M5BUDDY_ENABLE_BLE === "1";

let shuttingDown = false;

async function main(): Promise<void> {
  // 声明 channel capabilities（v0.3.2 §5.1.1）
  // - claude/channel: 注册 notification 监听
  // - claude/channel/permission: 启用 permission relay (CLI v2.1.81+)
  // 字段名引用自 https://code.claude.com/docs/en/channels-reference (2026-04-27)
  const server = new Server(
    { name: "m5buddy", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      instructions:
        "本 channel 来自用户的 M5StickC Plus 物理设备的远程审批通道。" +
        "通过 BLE 与本地 buddy 固件双向通信，仅做工具审批 relay，不接收常规消息。",
    },
  );

  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown initiated", { signal });
    stopHeartbeat();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // 注册 permission_request notification handler（D2-AM-2）
  registerPermissionRelay(server);

  log.info("m5buddy starting", {
    pid: process.pid,
    version: "0.1.0",
    ble_enabled: ENABLE_BLE,
    log_file: LOG_FILE_PATH,
  });
  await server.connect(transport);
  log.info("MCP server ready on stdio");

  if (ENABLE_BLE) {
    // BLE 在后台异步连接（fail-open）
    // 不 await：BLE 失败不应阻塞 MCP 通道
    void bleLoop(server);
  } else {
    log.info(
      "BLE disabled — set M5BUDDY_ENABLE_BLE=1 to enable (channel session only)",
    );
  }
}

async function bleLoop(server: Server): Promise<void> {
  let backoffMs = BLE_RECONNECT_DELAY_MS;
  while (!shuttingDown) {
    let disconnectedResolver: (() => void) | null = null;
    const disconnectedPromise = new Promise<void>((resolve) => {
      disconnectedResolver = resolve;
    });

    try {
      await connectAndSubscribe({
        onLine: (line) => {
          handleLine(line, {
            onPermissionDecision: (msg) => {
              void handleBuddyDecision(server, msg);
            },
            onAck: (msg) => log.debug("BLE ack", msg),
            onVoiceStart: (msg) => {
              const result = onVoiceStart(msg);
              const ack = result.ok
                ? { ack: "voice_start", ok: true }
                : { ack: "voice_start", ok: false, error: result.error };
              void writeLine(JSON.stringify(ack));
            },
            onVoiceEnd: (msg) => {
              void (async () => {
                const result = await onVoiceEnd(msg.sid, msg.total_chunks);
                const ack = result.ok
                  ? { ack: "voice_end", ok: true }
                  : { ack: "voice_end", ok: false, error: result.error };
                void writeLine(JSON.stringify(ack));
                // §6.1.1 ack 与 STT 解耦：ack 已发后再异步跑 STT，
                // 完成后单独推 voice_preview / voice_error
                if (result.ok) {
                  void runSttAndNotify(msg.sid, result.wavPath, "zh", writeLine);
                }
              })();
            },
            onVoiceAbort: (msg) => {
              onVoiceAbort(msg.sid);
              abortDraftSession(msg.sid);
              void writeLine(JSON.stringify({ ack: "voice_session_abort", ok: true }));
            },
            // §6.1.2 Draft 操作
            onVoiceSegmentAppend: (msg) => {
              const r = appendSegment(msg.sid);
              const ack = r.ok
                ? { ack: "voice_segment_append", ok: true, draft_chars: r.draftChars }
                : { ack: "voice_segment_append", ok: false, error: r.error,
                    draft_chars: getDraftChars() };
              void writeLine(JSON.stringify(ack));
            },
            onVoiceSegmentDiscard: (msg) => {
              // §6.1.2.1 idempotent
              const r = discardSegment(msg.sid);
              void writeLine(JSON.stringify({
                ack: "voice_segment_discard", ok: true, draft_chars: r.draftChars,
              }));
            },
            onVoiceDraftSubmit: () => {
              void (async () => {
                const preview = peekSubmit();
                if (!preview.ok) {
                  void writeLine(JSON.stringify({
                    ack: "voice_draft_submit", ok: false, error: preview.error,
                    draft_chars: getDraftChars(),
                  }));
                  return;
                }
                // §6.3 PC → CLI channel notification (try first, commit on success)
                try {
                  await server.notification({
                    method: "notifications/claude/channel",
                    params: {
                      content: preview.content,
                      meta: {
                        kind: "voice",
                        draft_id: preview.draftId,
                        segment_count: String(preview.segmentCount),
                      },
                    },
                  });
                  // Only clear segments after CLI confirms (notification didn't throw).
                  // §6.1.2 review P2-4: keep segments intact if dispatch fails.
                  const committed = commitSubmit(preview.draftId);
                  log.info("draft submitted via channel notification", {
                    draft_id: preview.draftId,
                    segment_count: preview.segmentCount,
                    content_chars: preview.content.length,
                    committed,
                  });
                  void writeLine(JSON.stringify({
                    ack: "voice_draft_submit", ok: true, draft_chars: 0,
                  }));
                } catch (err) {
                  log.error("draft submit notification failed; segments retained", {
                    error: String(err),
                  });
                  void writeLine(JSON.stringify({
                    ack: "voice_draft_submit", ok: false, error: "submit_failed",
                    detail: String(err).slice(0, 100),
                    draft_chars: getDraftChars(),
                  }));
                }
              })();
            },
            onVoiceDraftDiscard: () => {
              // §6.1.2.1 idempotent
              discardDraft();
              void writeLine(JSON.stringify({
                ack: "voice_draft_discard", ok: true, draft_chars: 0,
              }));
            },
          });
        },
        onAudioFrame: (frame) => {
          const result = onVoiceFrame(frame.sid, frame.seq, frame.payload);
          if (!result.ok) {
            log.warn("voice_chunk reject", { seq: frame.seq, error: result.error });
          }
        },
        onConnected: () => {
          backoffMs = BLE_RECONNECT_DELAY_MS; // 成功重置 backoff
          startHeartbeat();
        },
        onDisconnected: (reason) => {
          stopHeartbeat();
          log.warn("BLE disconnected", { reason });
          disconnectedResolver?.();
        },
      });

      // 走到这里说明已成功 connect + subscribe；等 disconnect 信号
      await disconnectedPromise;

      if (shuttingDown) break;
      log.info("BLE will reconnect", { delay_ms: BLE_RECONNECT_DELAY_MS });
      await sleep(BLE_RECONNECT_DELAY_MS);
    } catch (err) {
      log.warn("BLE connect attempt failed; backoff", {
        error: String(err),
        backoff_ms: backoffMs,
      });
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BLE_INITIAL_BACKOFF_MS);
    }
  }
  log.info("bleLoop exited");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log.error("fatal", { error: String(err), stack: (err as Error)?.stack });
  process.exit(1);
});
