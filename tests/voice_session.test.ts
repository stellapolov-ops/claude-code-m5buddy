import { afterEach, describe, expect, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";

import {
  onVoiceStart,
  onVoiceFrame,
  onVoiceEnd,
  onVoiceAbort,
  activeSessionCount,
  tickInactivity,
} from "../src/audio/voice_session";
import { adpcmEncode, adpcmStateReset } from "../src/audio/ima_adpcm";
import { encodeWav } from "../src/audio/wav_writer";

const SID_HEX = "0123456789abcdef";
const SID_BIN = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);

function generateSineWave(
  freqHz: number,
  durationSec: number,
  sampleRate = 16000,
  amplitude = 12000,
): Int16Array {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(
      amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate),
    );
  }
  return out;
}

afterEach(() => {
  // Defensive: drop any session left from a failing test
  onVoiceAbort(SID_HEX);
});

describe("voice_session", () => {
  test("end-to-end: start → 100 chunks → end → WAV file produced", async () => {
    const start = onVoiceStart({
      sid: SID_HEX,
      codec: "adpcm-ima",
      rate: 16000,
      ch: 1,
    });
    expect(start).toEqual({ ok: true });

    // Synthesize 100 ADPCM frames (each 240 bytes ⇒ 480 samples)
    const enc = adpcmStateReset();
    const totalChunks = 100;
    const samplesPerChunk = 480;
    const sineFull = generateSineWave(440, totalChunks * samplesPerChunk / 16000);

    for (let i = 0; i < totalChunks; i++) {
      const slice = sineFull.subarray(i * samplesPerChunk, (i + 1) * samplesPerChunk);
      const adpcm = adpcmEncode(slice, enc);
      expect(adpcm.length).toBe(samplesPerChunk / 2);
      const result = onVoiceFrame(SID_BIN, i, adpcm);
      expect(result).toEqual({ ok: true });
    }

    const end = await onVoiceEnd(SID_HEX, totalChunks);
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.samples).toBe(totalChunks * samplesPerChunk);
    expect(end.durationS).toBeCloseTo(3.0, 1);
    expect(activeSessionCount()).toBe(0);

    // Verify WAV file structure
    const wavBytes = await readFile(end.wavPath);
    expect(wavBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wavBytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wavBytes.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wavBytes.readUInt16LE(20)).toBe(1);                      // PCM
    expect(wavBytes.readUInt16LE(22)).toBe(1);                      // mono
    expect(wavBytes.readUInt32LE(24)).toBe(16000);                  // rate
    expect(wavBytes.readUInt16LE(34)).toBe(16);                     // bits/sample
    expect(wavBytes.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wavBytes.readUInt32LE(40)).toBe(end.samples * 2);

    await unlink(end.wavPath);
  });

  test("rejects voice_start with unsupported codec", () => {
    const result = onVoiceStart({
      sid: SID_HEX,
      codec: "opus",
      rate: 16000,
      ch: 1,
    });
    expect(result).toEqual({ ok: false, error: "unsupported_codec" });
    expect(activeSessionCount()).toBe(0);
  });

  test("rejects voice_chunk for unknown sid", () => {
    const result = onVoiceFrame(SID_BIN, 0, new Uint8Array(10));
    expect(result).toEqual({ ok: false, error: "sid_mismatch" });
  });

  test("rejects out-of-order seq", () => {
    onVoiceStart({ sid: SID_HEX, codec: "adpcm-ima", rate: 16000, ch: 1 });
    onVoiceFrame(SID_BIN, 0, new Uint8Array(20));
    const r = onVoiceFrame(SID_BIN, 5, new Uint8Array(20));
    expect(r).toEqual({ ok: false, error: "seq_out_of_order" });
    onVoiceAbort(SID_HEX);
  });

  test("voice_session_abort drops session even if not present", () => {
    const r = onVoiceAbort("ffffffffffffffff");
    expect(r).toEqual({ ok: true });
    expect(activeSessionCount()).toBe(0);
  });

  test("tickInactivity drops sessions silent > 60s", () => {
    onVoiceStart({ sid: SID_HEX, codec: "adpcm-ima", rate: 16000, ch: 1 });
    expect(activeSessionCount()).toBe(1);
    // Within window: nothing dropped.
    const aborted0 = tickInactivity(Date.now() + 30_000);
    expect(aborted0).toEqual([]);
    expect(activeSessionCount()).toBe(1);
    // Past 60s window: aborted, sid returned.
    const aborted1 = tickInactivity(Date.now() + 61_000);
    expect(aborted1).toEqual([SID_HEX]);
    expect(activeSessionCount()).toBe(0);
  });

  test("tickInactivity returns empty when no sessions", () => {
    expect(tickInactivity(Date.now() + 999_999)).toEqual([]);
  });
});

describe("encodeWav", () => {
  test("produces well-formed RIFF/WAVE header for 100 samples", () => {
    const pcm = new Int16Array([0, 1000, -1000, 32000, -32000]);
    const wav = encodeWav(pcm, 16000);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length * 2);
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(28)).toBe(16000 * 2);  // byte rate
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(1000);
    expect(wav.readInt16LE(48)).toBe(-1000);
  });
});
