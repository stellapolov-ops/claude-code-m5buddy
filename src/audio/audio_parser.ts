// Stream parser for the M5 → PC NUS byte stream.
//
// The stream multiplexes:
//   - JSON command lines: start with '{' (0x7B), terminate with '\n' (0x0A)
//   - binary audio frames: start with magic 0xFE 0xFE; format defined in
//     claude-desktop-buddy/src/audio/ble_audio_uploader.h
//
// Binary frame layout (total = 14 + payload_len + 2 bytes):
//   magic[2]=0xFE 0xFE | sid[8] | seq[2 LE] | len[2 LE] | payload[len] | crc16[2 LE]
//
// CRC-16/CCITT-FALSE: poly=0x1021 init=0xFFFF refl=false xorout=0
// Covers magic..payload (NOT crc itself).

export interface AudioFrame {
  sid: Uint8Array;     // 8 raw bytes; voice_start.sid carries the hex form
  seq: number;
  payload: Uint8Array;
}

export interface StreamParserEvents {
  onJsonLine: (line: string) => void;
  onAudioFrame: (frame: AudioFrame) => void;
  onError: (msg: string) => void;
}

const MAGIC_LO = 0xFE;
const MAGIC_HI = 0xFE;
const FRAME_HEADER_BYTES = 14;
const FRAME_TRAILER_BYTES = 2;
const MAX_PAYLOAD = 256;  // sanity cap (M5 sends 240 max per ble_audio_uploader.h)

export class StreamParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private events: StreamParserEvents) {}

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  private drain(): void {
    while (this.buf.length > 0) {
      const b0 = this.buf[0]!;
      if (b0 === MAGIC_LO) {
        if (!this.tryParseBinaryFrame()) return;
      } else if (b0 === 0x7B) {
        if (!this.tryParseJsonLine()) return;
      } else if (b0 === 0x0A || b0 === 0x0D) {
        this.buf = this.buf.subarray(1);  // stray newline; skip
      } else {
        this.events.onError(`unexpected lead byte 0x${b0.toString(16)}`);
        this.buf = this.buf.subarray(1);
      }
    }
  }

  private tryParseBinaryFrame(): boolean {
    if (this.buf.length < FRAME_HEADER_BYTES) return false;
    if (this.buf[1] !== MAGIC_HI) {
      this.events.onError(`bad magic[1]: 0x${this.buf[1]!.toString(16)}`);
      this.buf = this.buf.subarray(1);
      return true;
    }
    const len = this.buf.readUInt16LE(12);
    if (len > MAX_PAYLOAD) {
      this.events.onError(`payload len ${len} > MAX_PAYLOAD; resync`);
      this.buf = this.buf.subarray(1);
      return true;
    }
    const total = FRAME_HEADER_BYTES + len + FRAME_TRAILER_BYTES;
    if (this.buf.length < total) return false;

    const expectedCrc = crc16Ccitt(this.buf.subarray(0, FRAME_HEADER_BYTES + len));
    const actualCrc = this.buf.readUInt16LE(FRAME_HEADER_BYTES + len);
    if (expectedCrc !== actualCrc) {
      const seq = this.buf.readUInt16LE(10);
      this.events.onError(
        `bad CRC seq=${seq} expected=0x${expectedCrc.toString(16).padStart(4, "0")} actual=0x${actualCrc.toString(16).padStart(4, "0")}`,
      );
      this.buf = this.buf.subarray(1);
      return true;
    }

    const sid = new Uint8Array(this.buf.subarray(2, 10));
    const seq = this.buf.readUInt16LE(10);
    const payload = new Uint8Array(this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len));
    this.events.onAudioFrame({ sid, seq, payload });
    this.buf = this.buf.subarray(total);
    return true;
  }

  private tryParseJsonLine(): boolean {
    const nl = this.buf.indexOf(0x0A);
    if (nl < 0) return false;
    const line = this.buf.subarray(0, nl).toString("utf8").trim();
    this.buf = this.buf.subarray(nl + 1);
    if (line.length > 0) this.events.onJsonLine(line);
    return true;
  }
}

export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}
