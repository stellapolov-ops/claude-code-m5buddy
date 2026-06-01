// STT via whisper.cpp (brew whisper-cpp). Spawns whisper-cli, parses transcript
// from stdout. Pure function — no BLE / protocol coupling.
//
// Day 2 Step 4 — STT integration
// Defaults are resolved against ~/Models/whisper/ggml-small-q5_1.bin and
// `whisper-cli` on PATH; both overridable via env.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { log } from "../log.ts";

const DEFAULT_MODEL = path.join(homedir(), "Models/whisper/ggml-small-q5_1.bin");
const DEFAULT_BIN = "whisper-cli";
const TIMEOUT_MS = 30_000;

const MODEL_PATH = process.env.M5BUDDY_WHISPER_MODEL ?? DEFAULT_MODEL;
const BIN_PATH = process.env.M5BUDDY_WHISPER_BIN ?? DEFAULT_BIN;

export type SttErrorCode =
  | "model_missing"
  | "binary_missing"
  | "exec_failed"
  | "timeout"
  | "empty_output";

export interface SttSuccess {
  ok: true;
  text: string;
  durationMs: number;
}

export interface SttFailure {
  ok: false;
  error: SttErrorCode;
  message?: string;
}

export type SttOutcome = SttSuccess | SttFailure;

let modelChecked = false;

async function ensureModel(): Promise<SttFailure | null> {
  if (modelChecked) return null;
  try {
    await access(MODEL_PATH);
    modelChecked = true;
    return null;
  } catch {
    return { ok: false, error: "model_missing", message: MODEL_PATH };
  }
}

export async function transcribe(
  wavPath: string,
  lang: string,
): Promise<SttOutcome> {
  const modelErr = await ensureModel();
  if (modelErr) return modelErr;

  const t0 = Date.now();
  return await new Promise<SttOutcome>((resolve) => {
    const args = ["-m", MODEL_PATH, "-l", lang, "-nt", wavPath];
    const child = spawn(BIN_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: "timeout", message: `${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    child.stdout.on("data", (b: Buffer) => { stdoutBuf += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderrBuf += b.toString("utf8"); });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const msg = String(err);
      if (msg.includes("ENOENT")) {
        return resolve({ ok: false, error: "binary_missing", message: BIN_PATH });
      }
      resolve({ ok: false, error: "exec_failed", message: msg });
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const durationMs = Date.now() - t0;
      if (code !== 0) {
        log.warn("stt whisper non-zero exit", {
          code,
          stderr: stderrBuf.slice(0, 200),
        });
        return resolve({ ok: false, error: "exec_failed", message: `exit ${code}` });
      }
      const text = extractTranscript(stdoutBuf);
      if (!text) {
        return resolve({ ok: false, error: "empty_output" });
      }
      resolve({ ok: true, text, durationMs });
    });
  });
}

// brew whisper-cpp 1.8.4 (实测): transcript 写入 stdout（前导一个 \n + 文本），
// 所有 init/timing 日志写入 stderr。因此 transcript 提取 = stdout 去空白行 + trim。
export function extractTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}
