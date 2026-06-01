# m5buddy

**English | [中文](README.zh.md)**

> **Bring Claude Code to M5StickC Plus: physical-button tool approval + Chinese / English voice input.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.x-black.svg)](https://bun.sh)
[![Last commit](https://img.shields.io/github/last-commit/stellapolov-ops/claude-code-m5buddy)](https://github.com/stellapolov-ops/claude-code-m5buddy/commits/main)
![Stars](https://img.shields.io/github/stars/stellapolov-ops/claude-code-m5buddy?style=social)

<!-- TODO: insert demo GIF / video here once recorded -->

## Why this exists

When Claude Code CLI runs long tasks, every tool call (Bash / Write / Edit) requires approval — focus-stealing prompts interrupt your flow, and a misclick on the `1/2/3` keyboard option can accidentally select "approve all future". m5buddy routes the approval prompt over BLE to a physical 1.14" screen on M5StickC Plus:

- **Press A to approve / B to deny** — always only `once` / `deny` two-state (hardware misclick protection; never implements "approve all future")
- **Long-press B to record** → whisper Chinese / English transcription → pushed back to Claude Code via channel — skip typing long prompts
- **No focus stealing** — keep typing or attend video calls without interruption

## Features

- **Physical-button approval**: A approve / B deny, safe two-state
- **Chinese / English voice input**: long-press B to record → whisper transcription → push to Claude Code conversation
- **Draft buffer**: accumulate multiple recording segments, append / discard / submit at will
- **Fail-open**: channel subprocess crash does not affect Claude Code main flow

> Requires the **buddy firmware** on M5StickC Plus (voice-extended fork of [anthropics/claude-desktop-buddy](https://github.com/anthropics/claude-desktop-buddy)): [stellapolov-ops/claude-desktop-buddy](https://github.com/stellapolov-ops/claude-desktop-buddy)

Protocol references:
- [Claude Code Channels](https://code.claude.com/docs/en/channels-reference) (research preview)
- [Hardware Buddy BLE NUS](https://github.com/stellapolov-ops/claude-desktop-buddy/blob/main/REFERENCE.md)

## Requirements

| Item | Requirement |
|---|---|
| OS | macOS (Apple Silicon tested; Intel untested) |
| Claude Code | **v2.1.81+** (permission relay needed) |
| Login | **claude.ai login** (API key / Console do not support channels) |
| Bun | 1.x (`brew install oven-sh/bun/bun`) |
| Hardware | M5StickC Plus with [claude-desktop-buddy](https://github.com/stellapolov-ops/claude-desktop-buddy) firmware |

## Quick start

```bash
# 1. Install dependencies (one-time)
cd pc/m5buddy
bun install
bun pm trust @stoprocent/noble @stoprocent/bluetooth-hci-socket

# 2. Forget any previous Claude-XXXX pairing in macOS Bluetooth settings
#    (bonded devices use directed advertising and won't be discoverable)

# 3. Wake the M5 screen (press any button), then from the project root:
cd /path/to/<project-root>
claude --dangerously-load-development-channels server:m5buddy
```

When the macOS Bluetooth pairing dialog appears, confirm the 6-digit passkey matches what's shown on the M5 screen.

Verify with `/mcp` inside Claude Code — you should see `m5buddy · ✔ connected`.

**For full setup walkthrough, daily usage, troubleshooting, and architecture details, see [中文 README](README.zh.md).**

## Known limitations (fail-open by design)

- **Bun subprocess crash does NOT auto-respawn** — restart `claude` to recover. Claude Code REPL itself stays alive (fail-open) and terminal-native prompts continue to work.
- **LCD hint truncated at 42 chars** (2 lines × 21 chars hardcoded) — full command visible in terminal.
- **M5 BLE supports one Central at a time** — close Claude Desktop Hardware Buddy first.
- **Channels is a research preview** — must use `claude.ai login`, must use `--dangerously-load-development-channels` flag, protocol may change in future Claude Code releases.

## License

[MIT](LICENSE)
