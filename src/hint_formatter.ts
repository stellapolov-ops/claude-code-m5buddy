// 把 Claude Code 发的 input_preview（JSON 字符串）格式化为 M5 LCD 友好的 hint
//
// buddy 渲染硬限制（claude-desktop-buddy/src/main.cpp:746-754）：
//   - hint 最多 2 行 × 21 字符 = 42 字符
//   - 不支持滚动；不识别 \n
// 因此我们的目标是：把 ≤42 字符塞最多有效信息，去掉 JSON 结构标点。

const BUDDY_HINT_MAX = 42;

export function formatHint(toolName: string, inputPreview: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const x: unknown = JSON.parse(inputPreview);
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      parsed = x as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：原样截断
  }

  if (!parsed) {
    return truncate(inputPreview, BUDDY_HINT_MAX);
  }

  switch (toolName) {
    case "Bash": {
      const cmd = strField(parsed, "command");
      return truncate(`$ ${cmd}`, BUDDY_HINT_MAX);
    }
    case "Write": {
      const fp = strField(parsed, "file_path");
      const content = strField(parsed, "content");
      const fileShort = shortenPath(fp, 21);
      const remain = BUDDY_HINT_MAX - fileShort.length - 1;
      if (remain > 5 && content.length > 0) {
        return truncate(`${fileShort} ${content}`, BUDDY_HINT_MAX);
      }
      return truncate(fileShort, BUDDY_HINT_MAX);
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const fp = strField(parsed, "file_path");
      return truncate(`edit ${shortenPath(fp, BUDDY_HINT_MAX - 5)}`, BUDDY_HINT_MAX);
    }
    case "Read": {
      const fp = strField(parsed, "file_path");
      return truncate(`read ${shortenPath(fp, BUDDY_HINT_MAX - 5)}`, BUDDY_HINT_MAX);
    }
    case "Grep": {
      const pattern = strField(parsed, "pattern");
      return truncate(`grep ${pattern}`, BUDDY_HINT_MAX);
    }
    case "Glob": {
      const pattern = strField(parsed, "pattern");
      return truncate(`glob ${pattern}`, BUDDY_HINT_MAX);
    }
    case "WebFetch": {
      const url = strField(parsed, "url");
      return truncate(`fetch ${shortenUrl(url, BUDDY_HINT_MAX - 6)}`, BUDDY_HINT_MAX);
    }
    case "WebSearch": {
      const q = strField(parsed, "query");
      return truncate(`search ${q}`, BUDDY_HINT_MAX);
    }
    default: {
      // 未知工具：取第一个非空 string 字段（去掉 JSON 标点）
      const firstStr = Object.entries(parsed).find(
        ([, v]) => typeof v === "string" && (v as string).length > 0,
      );
      if (firstStr) {
        const [k, v] = firstStr;
        return truncate(`${k}: ${v as string}`, BUDDY_HINT_MAX);
      }
      return truncate(inputPreview, BUDDY_HINT_MAX);
    }
  }
}

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // 留一个 … 表示截断
  return s.slice(0, max - 1) + "…";
}

// /Users/alice/foo/bar.ts → …/bar.ts （或保留更多取决于 max）
function shortenPath(p: string, max: number): string {
  if (!p) return "?";
  if (p.length <= max) return p;
  const parts = p.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (last.length + 2 >= max) {
    // 文件名本身就长，从尾部截
    return "…" + last.slice(-(max - 1));
  }
  return ("…/" + last).slice(-max);
}

// https://example.com/very/long/path → example.com/...
function shortenUrl(u: string, max: number): string {
  if (!u) return "?";
  const stripped = u.replace(/^https?:\/\//, "");
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max - 1) + "…";
}
