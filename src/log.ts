// 强制 stderr 日志：stdout 是 MCP JSON-RPC 通道，**禁止**任何无关字节
//
// D-2: 同时落盘 ~/.cache/m5buddy/server-${pid}.log
// 理由：父 CC 进程吞掉 stderr，运行时 BLE 状态完全不可观测；
//      落盘后用户/开发者可 tail -f 看实时日志
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: Level =
  (process.env.M5BUDDY_LOG_LEVEL as Level) ?? "info";

const LOG_DIR = join(homedir(), ".cache", "m5buddy");
const LOG_FILE = join(LOG_DIR, `server-${process.pid}.log`);

let logFileReady = false;
function ensureLogDir(): void {
  if (logFileReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logFileReady = true;
  } catch (err) {
    // 目录创建失败不阻塞 stderr 输出；只是落盘暂时缺失
    process.stderr.write(
      `[log] failed to mkdir ${LOG_DIR}: ${String(err)}\n`,
    );
  }
}

function emit(level: Level, msg: string, meta?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  const ts = new Date().toISOString();
  const payload = meta === undefined
    ? `${ts} [${level}] ${msg}\n`
    : `${ts} [${level}] ${msg} ${safeStringify(meta)}\n`;
  process.stderr.write(payload);

  ensureLogDir();
  if (logFileReady) {
    try {
      appendFileSync(LOG_FILE, payload);
    } catch {
      // 单次落盘失败静默：stderr 已写出，避免反复抛错污染输出
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, meta?: unknown) => emit("debug", msg, meta),
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};

export const LOG_FILE_PATH = LOG_FILE; // 暴露给启动信息打印
