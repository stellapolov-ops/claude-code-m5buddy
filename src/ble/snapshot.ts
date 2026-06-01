// 心跳快照构建（buddy 协议 REFERENCE.md L41-79；字段语义弱化见审批 v0.3.2 §11.1）
// Phase 1：不构造 prompt 字段（permission relay 在 Day 2 加）
// 字段固定：total=1（channel 进程存活）、running=0（无来源）、waiting=0
//           msg=""、entries=[]、tokens 字段省略

export type ActivePrompt = {
  request_id: string;
  tool_name: string;
  input_preview: string; // 截断到 LCD 适合长度（80 字符）
};

export type SnapshotState = {
  active: ActivePrompt | null;
  draftChars: number;     // §6.1.4 — only present on LCD top status bar; doesn't drive M5 state
};

export function buildSnapshot(state: SnapshotState): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    total: 1,
    running: 0,
    waiting: state.active ? 1 : 0,
    msg: state.active ? `approve: ${state.active.tool_name}` : "",
    entries: [],
  };

  if (state.active) {
    snapshot.prompt = {
      id: state.active.request_id,
      tool: state.active.tool_name,
      hint: state.active.input_preview,
    };
  }

  // §6.1.4: only emit when > 0 (append-only field, M5 ignores absence as 0).
  if (state.draftChars > 0) {
    snapshot.draft_chars = state.draftChars;
  }

  return snapshot;
}

export function serializeSnapshot(state: SnapshotState): string {
  return JSON.stringify(buildSnapshot(state));
}
