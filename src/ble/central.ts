// BLE Central — 连接 M5StickC Plus，订阅 NUS TX，提供 RX 写入
// 协议：buddy NUS（claude-desktop-buddy/REFERENCE.md L25-29）
// 行解析：UTF-8 JSON-per-line，'\n' 终止；本模块只做行重组与上下行透传
// 上层（permission_relay / heartbeat）负责 JSON 解析与业务

import noble from "@stoprocent/noble";
import { log } from "../log.ts";

// buddy 协议规定的 NUS service / RX / TX UUID（REFERENCE.md L25-29）
const NUS_SERVICE = "6e400001b5a3f393e0a9e50e24dcca9e";
const NUS_RX_CHAR = "6e400002b5a3f393e0a9e50e24dcca9e"; // PC → M5 写
const NUS_TX_CHAR = "6e400003b5a3f393e0a9e50e24dcca9e"; // M5 → PC 通知

const NAME_PREFIX = "Claude";

export type BleEvents = {
  onLine: (line: string) => void; // 收到 M5 完整 JSON 行（已去 \n）
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
};

type ConnectedState = {
  peripheral: Awaited<ReturnType<typeof noble.startScanningAsync>> extends never ? never : any;
  rxChar: any; // GATT characteristic for write
};

let state: ConnectedState | null = null;
let rxBuffer = "";

export async function connectAndSubscribe(events: BleEvents): Promise<void> {
  await waitForState("poweredOn");

  log.info("BLE: scanning for Claude*");
  await noble.startScanningAsync([NUS_SERVICE], false);

  const peripheral = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      noble.removeListener("discover", onDiscover);
      reject(new Error("scan timeout 30s"));
    }, 30_000);

    const onDiscover = (p: any) => {
      const name = p.advertisement.localName ?? "";
      if (!name.startsWith(NAME_PREFIX)) return;
      clearTimeout(timeout);
      noble.removeListener("discover", onDiscover);
      resolve(p);
    };
    noble.on("discover", onDiscover);
  });

  await noble.stopScanningAsync();
  log.info("BLE: device picked", {
    name: peripheral.advertisement.localName,
    rssi: peripheral.rssi,
  });

  peripheral.once("disconnect", () => {
    log.warn("BLE: peripheral disconnected");
    state = null;
    rxBuffer = "";
    events.onDisconnected("peripheral disconnect event");
  });

  log.info("BLE: connecting (will trigger OS pairing on first connect)");
  await peripheral.connectAsync();
  log.info("BLE: connected; discovering services");

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [NUS_SERVICE],
    [NUS_RX_CHAR, NUS_TX_CHAR],
  );

  const rxChar = characteristics.find((c: any) => c.uuid === NUS_RX_CHAR);
  const txChar = characteristics.find((c: any) => c.uuid === NUS_TX_CHAR);

  if (!rxChar || !txChar) {
    throw new Error(
      `NUS characteristics missing (rx=${!!rxChar}, tx=${!!txChar})`,
    );
  }

  txChar.on("data", (data: Buffer) => {
    rxBuffer += data.toString("utf8");
    let idx;
    while ((idx = rxBuffer.indexOf("\n")) >= 0) {
      const line = rxBuffer.slice(0, idx).trim();
      rxBuffer = rxBuffer.slice(idx + 1);
      if (line.length > 0) events.onLine(line);
    }
  });

  await txChar.subscribeAsync();
  log.info("BLE: subscribed to TX notifications");

  state = { peripheral, rxChar };
  events.onConnected();
}

export async function writeLine(json: string): Promise<void> {
  if (!state) throw new Error("BLE not connected");
  const buf = Buffer.from(json + "\n", "utf8");
  // withoutResponse=false 保证可靠写（NUS RX 是 write with response）
  await state.rxChar.writeAsync(buf, false);
}

export async function disconnect(): Promise<void> {
  if (!state) return;
  try {
    await state.peripheral.disconnectAsync();
  } catch (err) {
    log.warn("BLE: disconnect error", { error: String(err) });
  }
  state = null;
  rxBuffer = "";
}

function waitForState(target: string): Promise<void> {
  return new Promise((resolve) => {
    if ((noble as any).state === target) {
      resolve();
      return;
    }
    const onChange = (s: string) => {
      if (s === target) {
        noble.removeListener("stateChange", onChange);
        resolve();
      }
    };
    noble.on("stateChange", onChange);
  });
}
