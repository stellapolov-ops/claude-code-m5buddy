# m5buddy — Claude Code CLI × M5StickC Plus 远程审批

把 Claude Code 触发的工具审批 prompt 通过 BLE 实时发到 M5StickC Plus，让你在物理设备上按 A 批准 / B 拒绝。

- **物理按钮审批**：A 同意 / B 拒绝，安全二态（绝不实现"以后都同意"）
- **中文 / 英文语音输入**：长按 B 录音 → whisper 转写 → 推到 Claude Code 对话
- **Draft buffer**：多段语音累积，随时 append / discard / submit
- **Fail-open**：channel 子进程崩溃不影响 Claude Code 主流程

协议基于：
- [Claude Code Channels](https://code.claude.com/docs/en/channels-reference)（research preview）
- [buddy BLE NUS](https://github.com/stellapolov-ops/claude-desktop-buddy/blob/main/REFERENCE.md)

---

## 系统要求

| 项 | 要求 |
|----|------|
| OS | macOS（Apple Silicon 已实测；Intel 未测） |
| Claude Code | **v2.1.81+**（permission relay 需要） |
| 登录方式 | **claude.ai login**（API key / Console 不支持 channels） |
| Bun | 1.x（`brew install oven-sh/bun/bun`） |
| 硬件 | M5StickC Plus，已烧 [claude-desktop-buddy](../../claude-desktop-buddy/) 固件 |

---

## 首次启动

### 1. 安装依赖（一次性）

```bash
cd pc/m5buddy
bun install
# Bun 默认阻止 native module 的 postinstall，需手动 trust：
bun pm trust @stoprocent/noble @stoprocent/bluetooth-hci-socket
```

### 2. 准备 M5StickC Plus

如果 M5 之前与 Claude Desktop（或其他 Mac）配对过，**必须先在 macOS 端 forget**：

> 系统设置 → 蓝牙 → 找到 `Claude-XXXX` → 取消配对（forget）

否则 m5buddy 扫不到广告（已 bonded 设备走 directed advertising，不对新 Central 广播）。

确认 M5 屏幕处于活跃状态（任意按键唤醒），buddy 主屏正常显示。

### 3. 启动 Claude Code

```bash
cd /path/to/<project-root>   # 项目根（.mcp.json 所在）
claude --dangerously-load-development-channels server:m5buddy
```

启动后应该看到：
```
Listening for channel messages from: server:m5buddy
Experimental · inbound messages will be pushed into this session ...
```

### 4. 首次配对（OS 弹窗）

第一次连接时 macOS 会弹**蓝牙配对窗**，显示 6 位 passkey。

**抬头看 M5 屏幕**，应该显示同样的 6 位数字。一致 → 点 macOS 弹窗的 **配对**。

### 5. 验证

在 claude REPL 里：
```
/mcp
```
应该看到：
```
Project MCP (.../<project-root>/.mcp.json)
  m5buddy · ✔ connected
```

M5 屏幕：buddy 角色动画在跑（idle 状态）。

---

## 日常使用

### 触发审批

让 Claude 调用 Bash / Write / Edit 等需要审批的工具。例如：

```
请创建文件 /tmp/test.txt，内容是 hello
```

**M5 行为**：
1. 屏幕切到 attention 状态（buddy 头像旁出现黄色感叹号）
2. LED 闪烁，buzzer 提示音
3. 显示工具名 + 命令片段（如 `Write` + `/tmp/test.txt hello`）
4. `approve? Ns` 倒计时

**操作**：
- **A 键**：批准（once，仅本次）
- **B 键**：拒绝

按下后 M5 立即切回 idle，Claude Code 收到决策放行/阻断工具。

### 终端原生 prompt 也仍可用

你可以**同时在 terminal 按 1/2/3** — 先到先得。

特殊情况：terminal 先决策时 M5 不知道，attention 残留**最多 60 秒**后自动消失（TTL 兜底）。

### 退出

`/exit` 或 `Ctrl+C` 退出 claude REPL，channel 子进程跟着退出。M5 30 秒内自动进入 sleep（眼睛闭合）。

---

## 已知限制（fail-open by design）

### 1. Bun 进程崩溃后**不会自动 respawn**
如果 m5buddy 子进程死了（OS kill / crash / 蓝牙 stack 异常），`/mcp` 显示 `m5buddy · ✘ failed`。
- ✅ Claude Code REPL **不会崩**，terminal 原生 prompt 仍能正常工作（fail-open）
- ❌ Channel 不会自恢复
- **恢复方法**：`/exit` 退出 claude，重新 `claude --dangerously-load-development-channels server:m5buddy`

### 2. LCD hint 最多 42 字符
buddy 固件 `drawApproval()` 硬编码 **2 行 × 21 字符**（`src/main.cpp:746-754`），长命令/路径必然被截断，且**不支持滚动**。
- 物理按键的目的是"快速远程批准已知操作"，不是"审阅完整命令"
- 完整命令在 terminal 里能看到

### 3. M5 BLE 一次只能连一个 Central
m5buddy 运行时**与 Claude Desktop Hardware Buddy 互斥**——同时只能用一个。Desktop 端如还连着请先断开。

### 4. Channels 是 research preview
- 必须 claude.ai login（API key 不行）
- 必须用 `--dangerously-load-development-channels` 启动（Anthropic 当前不允许 custom channel 进生产 allowlist）
- 协议未来可能变（v2.1.x 已实测；后续版本上 m5buddy 时需要回归测试）

### 5. Claude Code 对"明显安全"的命令可能不发审批
比如简单的 `echo`、`pwd`、`whoami` 可能直接执行不进 permission_request 流程。这是 Claude Code 决定的，与 m5buddy 无关。如果你需要每个 Bash 都审批，看 Claude Code 的 `/permissions` 设置。

### 6. 终端先决策的 M5 残留
M5 上 attention 弹出后，如果你在 terminal 先按了决策键，M5 不知道——会继续显示 attention 直到 60 秒 TTL 触发清理。这是预期行为（无 ack 协议；不发明）。

---

## 故障排查

### `/mcp` 看不到 m5buddy

- 检查 `<project-root>/.mcp.json` 是否存在并指向正确路径
- 检查启动命令是否带 `--dangerously-load-development-channels`
- 看 `~/.claude/debug/<session-id>.txt` 找 stderr trace（包含本进程的所有日志）

### M5 扫不到 / 连不上

```bash
# 看 macOS 是否还存有旧 bond 记录
system_profiler SPBluetoothDataType | grep -A 2 -i claude
```
如果有：去蓝牙设置 forget。

```bash
# 不启动 claude 也能跑独立扫描
cd pc/m5buddy
bun src/ble/scan_diagnostic.ts
```
应能扫到 `Claude-XXXX`。如果扫不到：按一下 M5 任意键唤醒，再扫。

### M5 attention 弹出但按 A/B 没反应

```bash
# channel 子进程是否还活着
ps aux | grep "bun.*m5buddy/src/server.ts" | grep -v grep
```
- 如果没了 → 进程已死，`/exit` 重启 claude
- 如果还在但 `/mcp` 显示 `failed` → 同上重启

### 修改代码后没生效

channel server 是 claude 启动时一次性 spawn 的，**改代码后必须重启 claude**（`/exit` + 重新 `claude ...`）。

### 想看实时日志

m5buddy 所有日志走 stderr，被 Claude Code 收集到 debug 文件：
```bash
ls -lt ~/.claude/debug/ | head -3                # 找最新文件
tail -f ~/.claude/debug/<file>.txt | grep -i "m5buddy\|BLE\|permission"
```

---

## 项目结构

```
pc/m5buddy/
├── package.json, tsconfig.json
├── .mcp.json                项目级（与项目根的 .mcp.json 内容相同，绝对路径）
├── src/
│   ├── server.ts            MCP channel server 主入口（主循环 + BLE 重连）
│   ├── log.ts               强制 stderr，禁止污染 stdout
│   ├── state_store.ts       active permission prompt + 60s TTL
│   ├── permission_relay.ts  permission_request handler + verdict 发送
│   ├── hint_formatter.ts    input_preview JSON → LCD 友好文本
│   └── ble/
│       ├── central.ts       @stoprocent/noble Central + GATT
│       ├── snapshot.ts      buddy 心跳快照序列化
│       ├── protocol.ts      BLE RX 行解析（cmd:permission / ack）
│       ├── heartbeat.ts     10s keepalive + 5s TTL 扫描 + 状态变更触发
│       ├── scan_diagnostic.ts    [实测脚本] 仅扫描，不连接
│       ├── connect_test.ts       [实测脚本] 连接联调
│       └── heartbeat_test.ts     [实测脚本] 心跳推送
└── tests/                   预留单元测试
```

### 关键铁律（不可妥协）

1. **once / deny 两态**：M5 按 A → `behavior:"allow"`、按 B → `behavior:"deny"`，**永远不实现"以后都同意"**。映射函数 `mapBuddyDecisionToVerdict()` 单点定义于 `permission_relay.ts`
2. **stdout 专属 MCP**：所有日志走 stderr，**绝不**用 `console.log`。`log.ts` 是唯一允许的日志接口


---



---

## 实测信息（2026-04-27）

- Claude Code v2.1.112 ✅
- Bun v1.3.13 ✅
- macOS 25.x（Apple Silicon）✅
- M5StickC Plus + buddy 固件 commit `a280c64` ✅
- 51 分钟长跑：内存零泄漏（RSS 31.7→28.4 MB），10+ 次审批稳定，channel 不掉线
- BLE：扫描 ~50ms / connect ~200ms / 加密配对 ~12s（含 OS pairing 弹窗）

---

## 许可

随项目根。
