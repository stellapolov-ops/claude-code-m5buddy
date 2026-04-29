// IMA ADPCM 4:1 codec — companion to claude-desktop-buddy/src/audio/adpcm_encoder.{h,cpp}.
//
// Standard reference (verified 2026-04-29):
//   IMA Digital Audio Interchange Format (1992), open standard.
//   Wikipedia: https://en.wikipedia.org/wiki/Interactive_Multimedia_Association
//   Step / index tables are public-domain constants from the standard.
//
// Both sides (M5 firmware encoder + this PC codec) implement the same
// algorithm bit-exactly. Production path uses adpcmDecode only; adpcmEncode
// is exported to enable round-trip unit tests and future PC-side capture
// playback validation.
//
// Byte format: byte = (high_nibble << 4) | (low_nibble & 0x0F)
//   low_nibble  = first sample of pair
//   high_nibble = second sample of pair

const STEP_TABLE: ReadonlyArray<number> = [
       7,     8,     9,    10,    11,    12,    13,    14,    16,    17,
      19,    21,    23,    25,    28,    31,    34,    37,    41,    45,
      50,    55,    60,    66,    73,    80,    88,    97,   107,   118,
     130,   143,   157,   173,   190,   209,   230,   253,   279,   307,
     337,   371,   408,   449,   494,   544,   598,   658,   724,   796,
     876,   963,  1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,
    2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,  4871,  5358,
    5894,  6484,  7132,  7845,  8630,  9493, 10442, 11487, 12635, 13899,
   15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

const INDEX_TABLE: ReadonlyArray<number> = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
];

export interface AdpcmState {
  predictor: number;   // int16, last reconstructed sample
  stepIndex: number;   // 0..88 index into STEP_TABLE
}

export function adpcmStateReset(): AdpcmState {
  return { predictor: 0, stepIndex: 0 };
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function encodeSample(sample: number, state: AdpcmState): number {
  let diff = sample - state.predictor;
  let sign = 0;
  if (diff < 0) { sign = 8; diff = -diff; }

  let step = STEP_TABLE[state.stepIndex]!;
  let delta = 0;
  let vpdiff = step >> 3;

  if (diff >= step) { delta |= 4; diff -= step; vpdiff += step; }
  step >>= 1;
  if (diff >= step) { delta |= 2; diff -= step; vpdiff += step; }
  step >>= 1;
  if (diff >= step) { delta |= 1;               vpdiff += step; }

  state.predictor = clamp(
    sign ? state.predictor - vpdiff : state.predictor + vpdiff,
    -32768, 32767,
  );
  state.stepIndex = clamp(state.stepIndex + INDEX_TABLE[delta | sign]!, 0, 88);

  return delta | sign;
}

function decodeSample(code: number, state: AdpcmState): number {
  const sign = code & 8;
  const delta = code & 7;
  let step = STEP_TABLE[state.stepIndex]!;

  let vpdiff = step >> 3;
  if (delta & 4) vpdiff += step;
  if (delta & 2) vpdiff += step >> 1;
  if (delta & 1) vpdiff += step >> 2;

  state.predictor = clamp(
    sign ? state.predictor - vpdiff : state.predictor + vpdiff,
    -32768, 32767,
  );
  state.stepIndex = clamp(state.stepIndex + INDEX_TABLE[code]!, 0, 88);

  return state.predictor;
}

// Encode int16 PCM into packed 4-bit nibbles. Output length = ceil(pcm.length / 2).
export function adpcmEncode(pcm: Int16Array, state: AdpcmState): Uint8Array {
  const outLen = (pcm.length + 1) >> 1;
  const out = new Uint8Array(outLen);
  for (let i = 0, o = 0; i < pcm.length; i += 2, o++) {
    const low = encodeSample(pcm[i]!, state);
    const high = i + 1 < pcm.length ? encodeSample(pcm[i + 1]!, state) : 0;
    out[o] = ((high << 4) | (low & 0x0F)) & 0xFF;
  }
  return out;
}

// Decode packed nibbles into int16 PCM. `sampleCount` is the exact original sample count
// (needed because byte-packing rounds up if an odd number of samples were encoded).
export function adpcmDecode(
  adpcm: Uint8Array,
  sampleCount: number,
  state: AdpcmState,
): Int16Array {
  const out = new Int16Array(sampleCount);
  let o = 0;
  for (let i = 0; i < adpcm.length && o < sampleCount; i++) {
    const byte = adpcm[i]!;
    out[o++] = decodeSample(byte & 0x0F, state);
    if (o < sampleCount) {
      out[o++] = decodeSample((byte >> 4) & 0x0F, state);
    }
  }
  return out;
}
