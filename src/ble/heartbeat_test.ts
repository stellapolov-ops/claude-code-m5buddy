#!/usr/bin/env bun
// 心跳推送联调脚本（Day 1 PM-2 实测）
// 目的：验证 PC 端构建的 buddy 心跳快照能让 M5 LCD 正确渲染 idle 状态
//
// 测试矩阵：
//   - 连接成功后立即推 idle 心跳（无 prompt）
//   - 每 10s keepalive
//   - 测试 30s 后 SIGINT 退出（看 M5 是否切回 sleep）
//
// 期望：M5 LCD 显示 idle 状态（"connected"），无审批 attention，buddy 角色正常动画

import { connectAndSubscribe, writeLine, disconnect } from "./central.ts";
import { serializeSnapshot } from "./snapshot.ts";
import { log } from "../log.ts";

let connected = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const KEEPALIVE_MS = 10_000;
const SHUTDOWN_MS = 60_000; // 60s 自动退出（让 M5 心跳 dead detection 兜底）

function pushSnapshot(): void {
  if (!connected) return;
  const json = serializeSnapshot({ active: null });
  writeLine(json).then(
    () => log.info("BLE TX heartbeat", { json }),
    (err) => log.error("BLE TX heartbeat failed", { error: String(err) }),
  );
}

await connectAndSubscribe({
  onLine: (line) => {
    log.info("BLE RX line", { line });
  },
  onConnected: () => {
    connected = true;
    log.info("connected, sending initial heartbeat");
    pushSnapshot();
    heartbeatTimer = setInterval(pushSnapshot, KEEPALIVE_MS);
  },
  onDisconnected: (reason) => {
    connected = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    log.warn("disconnected", { reason });
  },
});

process.on("SIGINT", async () => {
  log.info("SIGINT, cleaning up");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await disconnect();
  process.exit(0);
});

setTimeout(async () => {
  log.info("auto-stop after duration", { ms: SHUTDOWN_MS });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await disconnect();
  process.exit(0);
}, SHUTDOWN_MS);

log.info("heartbeat_test running; will auto-exit in 60s or on SIGINT");
