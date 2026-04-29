#!/usr/bin/env bun
// BLE 连接联调脚本（Day 1 PM-1 实测）
// 目的：验证 noble 能完整连接 M5、走完 LE Secure Connections passkey 配对、订阅 TX、能 RX/TX
// 不发心跳快照（那是 #7 的事）；只跑 5 分钟看连接稳定性
// Ctrl+C 退出
//
// 期望输出顺序：
//   1. scanning
//   2. device picked
//   3. connecting (will trigger OS pairing on first connect)
//      → macOS 弹窗要求输入 passkey；M5 LCD 显示 6 位数字
//      → 用户在弹窗里输入数字
//   4. connected
//   5. discovering services
//   6. subscribed to TX notifications
//   7. （此后任何 M5 主动发的消息都打印；我们也每 30s 写一条 dummy 看 M5 是否拒绝）

import { connectAndSubscribe, disconnect } from "./central.ts";
import { log } from "../log.ts";

let connected = false;
let linesSeen = 0;

await connectAndSubscribe({
  onLine: (line) => {
    linesSeen += 1;
    log.info("BLE RX line", { line });
  },
  onConnected: () => {
    connected = true;
    log.info("BLE connected callback fired");
  },
  onDisconnected: (reason) => {
    connected = false;
    log.warn("BLE disconnected", { reason });
  },
});

// 不主动发任何业务消息（避免 M5 误以为有 prompt 或被未识别 cmd 干扰）
// 只看连接稳定性 + M5 主动发什么（应该会发 cmd:status ack 等）

process.on("SIGINT", async () => {
  log.info("SIGINT, summary", { connected, linesSeen });
  await disconnect();
  process.exit(0);
});

log.info("connect_test idle; Ctrl+C to stop");
// 保持进程活
setInterval(() => {
  log.debug("alive", { connected, linesSeen });
}, 60_000);
