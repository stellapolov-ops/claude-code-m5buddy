#!/usr/bin/env bun
// BLE 扫描诊断工具（仅 Day 1 PM-1 实测使用）
// 目的：验证 noble 能否在 macOS 25.x 上扫到广告名以 "Claude" 开头的 M5StickC Plus
// 不连接、不触发配对，纯被动扫描；Ctrl+C 退出
//
// 用法（项目根 cd 进 pc/m5buddy 后）：
//   bun src/ble/scan_diagnostic.ts

import noble from "@stoprocent/noble";
import { log } from "../log.ts";

// buddy 协议规定的 NUS service UUID（REFERENCE.md L25-29）
const NUS_SERVICE = "6e400001b5a3f393e0a9e50e24dcca9e";

const seen = new Map<string, { name: string; rssi: number; lastSeen: number }>();

noble.on("stateChange", (state) => {
  log.info("noble stateChange", { state });
  if (state === "poweredOn") {
    log.info("starting scan", { filter: "name prefix 'Claude'" });
    // 不用 service UUID 过滤，免得过滤过严漏掉广告（先看全部，后筛名字）
    noble.startScanningAsync([], true).catch((err) => {
      log.error("startScanning failed", { error: String(err) });
      process.exit(1);
    });
  } else if (state === "unsupported" || state === "unauthorized") {
    log.error("BLE not available; check macOS Bluetooth permission", { state });
    process.exit(2);
  }
});

noble.on("discover", (peripheral) => {
  const name = peripheral.advertisement.localName ?? "";
  if (!name.startsWith("Claude")) return; // 只关注 Claude* 设备

  const id = peripheral.id;
  const prev = seen.get(id);
  const now = Date.now();
  const services = peripheral.advertisement.serviceUuids ?? [];
  const hasNUS = services.some((u) => u.replace(/-/g, "").toLowerCase() === NUS_SERVICE);

  if (!prev) {
    log.info("FOUND Claude device", {
      id,
      name,
      address: peripheral.address || "(unresolved)",
      rssi: peripheral.rssi,
      services_advertised: services,
      has_nus_service: hasNUS,
      connectable: peripheral.connectable,
    });
  }
  seen.set(id, { name, rssi: peripheral.rssi, lastSeen: now });
});

process.on("SIGINT", async () => {
  log.info("SIGINT, stopping scan");
  await noble.stopScanningAsync().catch(() => {});
  log.info("scan summary", {
    devices_seen: seen.size,
    devices: Array.from(seen.entries()).map(([id, d]) => ({ id, ...d })),
  });
  process.exit(0);
});

log.info("scan_diagnostic starting; press Ctrl+C to stop");
