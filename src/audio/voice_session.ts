// Voice session lifecycle on PC side: track active sessions, decode IMA ADPCM,
// accumulate decoded PCM, write WAV file on voice_end.
//
// Step 3c scope: WAV落盘 only. STT (whisper-cli) + voice_preview return are Step 4.

import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

import { adpcmDecode, adpcmStateReset, type AdpcmState } from "./ima_adpcm.ts";
import { writeWavFile } from "./wav_writer.ts";
import { log } from "../log.ts";

export interface VoiceStartParams {
  sid: string;
  codec: string;
  rate: number;
  ch: number;
}

interface ActiveSession {
  sid: string;
  rate: number;
  decoderState: AdpcmState;
  pcmChunks: Int16Array[];
  totalSamples: number;
  expectedSeq: number;
  startedAt: number;
  lastFrameAt: number;
}

const sessions = new Map<string, ActiveSession>();

// §7.6.1 stage 1: if no frames arrive for this long, the M5 side likely
// died / BLE dropped mid-session — abort so a new session can begin.
const RECORDING_INACTIVITY_MS = 60_000;

const RECORDINGS_DIR = path.join(tmpdir(), "m5buddy-recordings");
mkdirSync(RECORDINGS_DIR, { recursive: true });

export const voiceRecordingsDir = RECORDINGS_DIR;

export function sidBinToHex(bin: Uint8Array): string {
  if (bin.length !== 8) throw new Error(`sid must be 8 bytes, got ${bin.length}`);
  return Array.from(bin).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type StartResult = { ok: true } | { ok: false; error: string };
type ChunkResult = { ok: true } | { ok: false; error: string };
type EndResult =
  | { ok: true; wavPath: string; samples: number; durationS: number }
  | { ok: false; error: string };

export function onVoiceStart(p: VoiceStartParams): StartResult {
  if (sessions.has(p.sid)) return { ok: false, error: "duplicate_sid" };
  if (sessions.size > 0) return { ok: false, error: "busy" };
  if (p.codec !== "adpcm-ima") {
    log.warn("voice_start unsupported codec", { sid: p.sid, codec: p.codec });
    return { ok: false, error: "unsupported_codec" };
  }
  const now = Date.now();
  sessions.set(p.sid, {
    sid: p.sid,
    rate: p.rate,
    decoderState: adpcmStateReset(),
    pcmChunks: [],
    totalSamples: 0,
    expectedSeq: 0,
    startedAt: now,
    lastFrameAt: now,
  });
  log.info("voice_start", { sid: p.sid, codec: p.codec, rate: p.rate });
  return { ok: true };
}

export function onVoiceFrame(
  sidBin: Uint8Array,
  seq: number,
  payload: Uint8Array,
): ChunkResult {
  const sid = sidBinToHex(sidBin);
  const session = sessions.get(sid);
  if (!session) return { ok: false, error: "sid_mismatch" };
  if (seq !== session.expectedSeq) {
    log.warn("voice_chunk seq", {
      sid,
      expected: session.expectedSeq,
      got: seq,
    });
    return { ok: false, error: "seq_out_of_order" };
  }
  const sampleCount = payload.length * 2;
  const pcm = adpcmDecode(payload, sampleCount, session.decoderState);
  session.pcmChunks.push(pcm);
  session.totalSamples += pcm.length;
  session.expectedSeq++;
  session.lastFrameAt = Date.now();
  return { ok: true };
}

// §7.6.1 stage 1: drop any active session that's gone silent for too long.
// Called from heartbeat's 5s tick. Returns the sids aborted so the caller
// can clean up associated DraftBuffer.pending entries.
export function tickInactivity(now: number = Date.now()): string[] {
  const aborted: string[] = [];
  for (const [sid, s] of sessions) {
    if (now - s.lastFrameAt > RECORDING_INACTIVITY_MS) {
      log.warn("voice session inactivity timeout — aborting", {
        sid,
        idle_ms: now - s.lastFrameAt,
        threshold_ms: RECORDING_INACTIVITY_MS,
      });
      sessions.delete(sid);
      aborted.push(sid);
    }
  }
  return aborted;
}

export async function onVoiceEnd(
  sid: string,
  totalChunks: number,
): Promise<EndResult> {
  const session = sessions.get(sid);
  if (!session) return { ok: false, error: "sid_mismatch" };

  if (session.expectedSeq !== totalChunks) {
    log.warn("voice_end total_chunks mismatch", {
      sid,
      received: session.expectedSeq,
      reported: totalChunks,
    });
  }

  const allPcm = new Int16Array(session.totalSamples);
  let off = 0;
  for (const chunk of session.pcmChunks) {
    allPcm.set(chunk, off);
    off += chunk.length;
  }

  const wavPath = path.join(RECORDINGS_DIR, `recording_${sid}.wav`);
  await writeWavFile(wavPath, allPcm, session.rate);

  const durationS = session.totalSamples / session.rate;
  log.info("voice_end → wav", {
    sid,
    chunks: totalChunks,
    samples: session.totalSamples,
    duration_s: Number(durationS.toFixed(3)),
    path: wavPath,
  });
  sessions.delete(sid);
  return { ok: true, wavPath, samples: session.totalSamples, durationS };
}

export function onVoiceAbort(sid: string): { ok: true } {
  if (sessions.has(sid)) {
    log.info("voice_session_abort", { sid });
    sessions.delete(sid);
  }
  return { ok: true };
}

export function activeSessionCount(): number {
  return sessions.size;
}
