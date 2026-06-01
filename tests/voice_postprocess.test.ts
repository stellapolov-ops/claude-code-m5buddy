import { describe, expect, test } from "bun:test";

import {
  runSttAndNotify,
  codePointSlice,
  codePointLength,
  MAX_PREVIEW_CODEPOINTS,
} from "../src/audio/voice_postprocess";
import { extractTranscript } from "../src/audio/stt";

const SID = "0123456789abcdef";

function captureSender(): { lines: string[]; send: (j: string) => Promise<void> } {
  const lines: string[] = [];
  return {
    lines,
    send: async (j: string) => {
      lines.push(j);
    },
  };
}

describe("voice_postprocess dispatch", () => {
  test("voice_preview JSON shape with short transcript", async () => {
    const { lines, send } = captureSender();
    await runSttAndNotify(SID, "/x.wav", "zh", send, async () => ({
      ok: true,
      text: "你好世界",
      durationMs: 800,
    }));
    expect(lines.length).toBe(1);
    const msg = JSON.parse(lines[0]!);
    expect(msg).toEqual({
      cmd: "voice_preview",
      sid: SID,
      text: "你好世界",
      full_chars: 4,
    });
  });

  test("truncates text to MAX_PREVIEW_CODEPOINTS but full_chars carries full length", async () => {
    const longText = "字".repeat(MAX_PREVIEW_CODEPOINTS + 50);
    const { lines, send } = captureSender();
    await runSttAndNotify(SID, "/x.wav", "zh", send, async () => ({
      ok: true,
      text: longText,
      durationMs: 1200,
    }));
    const msg = JSON.parse(lines[0]!);
    expect(codePointLength(msg.text)).toBe(MAX_PREVIEW_CODEPOINTS);
    expect(msg.full_chars).toBe(MAX_PREVIEW_CODEPOINTS + 50);
  });

  test("voice_error model_missing carries reason and message", async () => {
    const { lines, send } = captureSender();
    await runSttAndNotify(SID, "/x.wav", "zh", send, async () => ({
      ok: false,
      error: "model_missing",
      message: "/tmp/no.bin",
    }));
    expect(lines.length).toBe(1);
    const msg = JSON.parse(lines[0]!);
    expect(msg).toEqual({
      cmd: "voice_error",
      sid: SID,
      reason: "model_missing",
      message: "/tmp/no.bin",
    });
  });

  test("voice_error empty_output has no message field", async () => {
    const { lines, send } = captureSender();
    await runSttAndNotify(SID, "/x.wav", "zh", send, async () => ({
      ok: false,
      error: "empty_output",
    }));
    const msg = JSON.parse(lines[0]!);
    expect(msg.reason).toBe("empty_output");
    expect("message" in msg).toBe(false);
  });

  test("sender failure does not propagate (BLE down tolerated)", async () => {
    const send = async () => {
      throw new Error("BLE not connected");
    };
    // 不抛即视为通过
    await runSttAndNotify(SID, "/x.wav", "zh", send, async () => ({
      ok: true,
      text: "测试",
      durationMs: 100,
    }));
    expect(true).toBe(true);
  });
});

describe("codePointSlice", () => {
  test("preserves full string under limit", () => {
    expect(codePointSlice("hi", 10)).toBe("hi");
  });
  test("truncates CJK by code point not byte", () => {
    expect(codePointSlice("一二三四五", 3)).toBe("一二三");
  });
  test("does not split surrogate pairs (emoji)", () => {
    // 😀 is 2 code units but 1 code point; slicing at 1 should keep it whole
    expect(codePointSlice("a😀b", 2)).toBe("a😀");
  });
});

describe("extractTranscript", () => {
  test("trims leading newline + transcript (实测 brew whisper-cpp 1.8.4 stdout 格式)", () => {
    // 实测：whisper-cli -nt 把 transcript 写 stdout，前导一个空行 + 文本
    expect(extractTranscript("\n打開文件")).toBe("打開文件");
  });

  test("joins multi-line transcript", () => {
    expect(extractTranscript("\n第一行\n第二行\n")).toBe("第一行\n第二行");
  });

  test("empty stdout returns empty (caller maps to empty_output)", () => {
    expect(extractTranscript("")).toBe("");
    expect(extractTranscript("\n\n  \n")).toBe("");
  });
});
