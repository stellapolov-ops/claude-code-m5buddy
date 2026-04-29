import { describe, expect, test } from "bun:test";
import {
  StreamParser,
  crc16Ccitt,
  type AudioFrame,
} from "../src/audio/audio_parser";

function buildBinaryFrame(
  sid: Uint8Array,
  seq: number,
  payload: Uint8Array,
): Buffer {
  const len = payload.length;
  const buf = Buffer.alloc(14 + len + 2);
  buf[0] = 0xFE;
  buf[1] = 0xFE;
  for (let i = 0; i < 8; i++) buf[2 + i] = sid[i]!;
  buf.writeUInt16LE(seq, 10);
  buf.writeUInt16LE(len, 12);
  for (let i = 0; i < len; i++) buf[14 + i] = payload[i]!;
  const crc = crc16Ccitt(buf.subarray(0, 14 + len));
  buf.writeUInt16LE(crc, 14 + len);
  return buf;
}

describe("StreamParser", () => {
  test("CRC-16/CCITT-FALSE matches reference vector for '123456789'", () => {
    // ITU-T V.41 reference: CRC of ASCII '123456789' = 0x29B1
    const data = new TextEncoder().encode("123456789");
    expect(crc16Ccitt(data)).toBe(0x29B1);
  });

  test("parses single binary frame", () => {
    const frames: AudioFrame[] = [];
    const errors: string[] = [];
    const p = new StreamParser({
      onJsonLine: () => {},
      onAudioFrame: (f) => frames.push(f),
      onError: (e) => errors.push(e),
    });
    const sid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const payload = new Uint8Array([10, 20, 30, 40]);
    p.feed(buildBinaryFrame(sid, 0, payload));
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!.sid)).toEqual(Array.from(sid));
    expect(frames[0]!.seq).toBe(0);
    expect(Array.from(frames[0]!.payload)).toEqual(Array.from(payload));
  });

  test("parses interleaved JSON and binary", () => {
    const frames: AudioFrame[] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const p = new StreamParser({
      onJsonLine: (l) => lines.push(l),
      onAudioFrame: (f) => frames.push(f),
      onError: (e) => errors.push(e),
    });
    const sid = new Uint8Array(8);
    const payload = new Uint8Array(60);
    const stream = Buffer.concat([
      Buffer.from('{"cmd":"voice_start","sid":"0000000000000000","codec":"adpcm-ima","rate":16000,"ch":1}\n', "utf8"),
      buildBinaryFrame(sid, 0, payload),
      buildBinaryFrame(sid, 1, payload),
      Buffer.from('{"cmd":"voice_end","sid":"0000000000000000","total_chunks":2}\n', "utf8"),
    ]);
    p.feed(stream);
    expect(errors).toEqual([]);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).cmd).toBe("voice_start");
    expect(JSON.parse(lines[1]!).cmd).toBe("voice_end");
    expect(frames.length).toBe(2);
    expect(frames[0]!.seq).toBe(0);
    expect(frames[1]!.seq).toBe(1);
  });

  test("reassembles frame split across BLE chunks", () => {
    const frames: AudioFrame[] = [];
    const errors: string[] = [];
    const p = new StreamParser({
      onJsonLine: () => {},
      onAudioFrame: (f) => frames.push(f),
      onError: (e) => errors.push(e),
    });
    const sid = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44]);
    const payload = new Uint8Array(120).fill(0x42);
    const full = buildBinaryFrame(sid, 7, payload);
    // Split into 3 arbitrary chunks
    p.feed(full.subarray(0, 14));
    expect(frames.length).toBe(0);
    p.feed(full.subarray(14, 80));
    expect(frames.length).toBe(0);
    p.feed(full.subarray(80));
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect(frames[0]!.seq).toBe(7);
    expect(frames[0]!.payload.length).toBe(120);
  });

  test("detects bad CRC and resyncs", () => {
    const frames: AudioFrame[] = [];
    const errors: string[] = [];
    const p = new StreamParser({
      onJsonLine: () => {},
      onAudioFrame: (f) => frames.push(f),
      onError: (e) => errors.push(e),
    });
    const sid = new Uint8Array(8);
    const corrupted = buildBinaryFrame(sid, 0, new Uint8Array(20));
    const crcLowByteIdx = 14 + 20;
    corrupted.writeUInt8(corrupted.readUInt8(crcLowByteIdx) ^ 0xFF, crcLowByteIdx);
    const good = buildBinaryFrame(sid, 1, new Uint8Array(20));
    p.feed(Buffer.concat([corrupted, good]));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!).toContain("bad CRC");
    expect(frames.length).toBe(1);
    expect(frames[0]!.seq).toBe(1);
  });

  test("skips stray newlines between messages", () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const p = new StreamParser({
      onJsonLine: (l) => lines.push(l),
      onAudioFrame: () => {},
      onError: (e) => errors.push(e),
    });
    p.feed(Buffer.from('\n\n{"cmd":"x"}\n\n{"cmd":"y"}\n', "utf8"));
    expect(errors).toEqual([]);
    expect(lines).toEqual(['{"cmd":"x"}', '{"cmd":"y"}']);
  });
});
