// Minimal WAV writer for s16le mono PCM.
// Format reference: https://soundfile.sapp.org/doc/WaveFormat/

import { writeFile } from "node:fs/promises";

export async function writeWavFile(
  path: string,
  pcm: Int16Array,
  sampleRate: number,
): Promise<void> {
  await writeFile(path, encodeWav(pcm, sampleRate));
}

export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);

  // RIFF / WAVE header
  buf.write("RIFF", 0, 4, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, 4, "ascii");

  // fmt chunk
  buf.write("fmt ", 12, 4, "ascii");
  buf.writeUInt32LE(16, 16);             // chunk size
  buf.writeUInt16LE(1, 20);              // audio format = PCM
  buf.writeUInt16LE(1, 22);              // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);              // block align
  buf.writeUInt16LE(16, 34);             // bits per sample

  // data chunk
  buf.write("data", 36, 4, "ascii");
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  }

  return buf;
}
