import { describe, expect, test } from "bun:test";
import {
  adpcmDecode,
  adpcmEncode,
  adpcmStateReset,
} from "../src/audio/ima_adpcm";

function generateSineWave(
  freqHz: number,
  durationSec: number,
  sampleRate = 16000,
  amplitude = 16000,
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

function snrDb(original: Int16Array, decoded: Int16Array): number {
  if (original.length !== decoded.length) {
    throw new Error(
      `length mismatch: ${original.length} vs ${decoded.length}`,
    );
  }
  let signalSum = 0;
  let noiseSum = 0;
  for (let i = 0; i < original.length; i++) {
    signalSum += original[i]! * original[i]!;
    const e = original[i]! - decoded[i]!;
    noiseSum += e * e;
  }
  if (noiseSum === 0) return Infinity;
  return 10 * Math.log10(signalSum / noiseSum);
}

describe("IMA ADPCM codec", () => {
  test("440 Hz sine wave roundtrip SNR >= 30 dB", () => {
    const pcm = generateSineWave(440, 1.0);
    const encoded = adpcmEncode(pcm, adpcmStateReset());
    const decoded = adpcmDecode(encoded, pcm.length, adpcmStateReset());
    const snr = snrDb(pcm, decoded);
    expect(snr).toBeGreaterThanOrEqual(30);
  });

  test("multi-frequency speech-like signal SNR >= 22 dB", () => {
    const sampleRate = 16000;
    const n = sampleRate;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = 0.5 * (1 + Math.sin(2 * Math.PI * 5 * t));
      const sig =
        Math.sin(2 * Math.PI * 200 * t) * 0.5 +
        Math.sin(2 * Math.PI * 600 * t) * 0.3 +
        Math.sin(2 * Math.PI * 1200 * t) * 0.2;
      pcm[i] = Math.round(env * sig * 14000);
    }
    const encoded = adpcmEncode(pcm, adpcmStateReset());
    const decoded = adpcmDecode(encoded, pcm.length, adpcmStateReset());
    expect(snrDb(pcm, decoded)).toBeGreaterThanOrEqual(22);
  });

  test("compression ratio is exactly 4:1", () => {
    const pcm = generateSineWave(1000, 0.5);
    const encoded = adpcmEncode(pcm, adpcmStateReset());
    expect(encoded.length).toBe(pcm.length / 2);
    expect((pcm.byteLength / encoded.byteLength)).toBe(4);
  });

  test("silence (all-zero PCM) decodes to near-silence", () => {
    const pcm = new Int16Array(1000);
    const encoded = adpcmEncode(pcm, adpcmStateReset());
    const decoded = adpcmDecode(encoded, pcm.length, adpcmStateReset());
    let maxAbs = 0;
    for (const s of decoded) maxAbs = Math.max(maxAbs, Math.abs(s));
    expect(maxAbs).toBeLessThan(10);
  });

  test("odd sample count round-trips correctly", () => {
    const pcm = new Int16Array([1000, -1000, 2000, -2000, 3000]);
    const encoded = adpcmEncode(pcm, adpcmStateReset());
    expect(encoded.length).toBe(3);
    const decoded = adpcmDecode(encoded, pcm.length, adpcmStateReset());
    expect(decoded.length).toBe(pcm.length);
  });

  test("streaming chunks produce identical output to single-pass", () => {
    const pcm = generateSineWave(440, 0.5);
    const fullEnc = adpcmEncode(pcm, adpcmStateReset());

    const stateChunked = adpcmStateReset();
    const chunks: Uint8Array[] = [];
    const chunkSize = 480;
    for (let i = 0; i < pcm.length; i += chunkSize) {
      const slice = pcm.subarray(i, Math.min(i + chunkSize, pcm.length));
      chunks.push(adpcmEncode(slice, stateChunked));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    expect(Array.from(merged)).toEqual(Array.from(fullEnc));
  });
});
