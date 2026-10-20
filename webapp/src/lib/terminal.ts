// 「终端」Tab（网页里打开 opencode session）的前端纯函数：
// sidecar 地址拼接、配置读写、帧编解码、可用性判定。
//
// 协议对齐 tools/terminal-sidecar/README.md §5（sidecar 侧已实现并复审通过）：
// - 浏览器 → sidecar：**二进制帧 = 终端输入字节**；**文本帧 = JSON 控制消息**（如 resize）
// - sidecar → 浏览器：**二进制帧 = 终端输出字节**；**文本帧 = JSON 控制消息**（error / exit）
//
// 因此 xterm 的 onData 回调（给的是字符串）必须先经 TextEncoder 编码再发：
// 直接发字符串会变成文本帧，被 sidecar 当成控制消息忽略掉（终端表现为「敲键盘没反应」）。

/** 终端配置（持久化在 localStorage） */
export interface TerminalConfig {
  /** sidecar 地址，如 http://127.0.0.1:7681 */
  sidecarUrl: string
  /** sidecar 共享口令（sidecar 启动参数 --token） */
  token: string
}

/** localStorage 键名（与 sidecar README §6 建议一致） */
export const TERMINAL_URL_KEY = "taskboard:terminal:sidecar-url"
export const TERMINAL_TOKEN_KEY = "taskboard:terminal:token"

/** WebSocket readyState：已连接（不依赖浏览器的 WebSocket.OPEN 常量，便于纯函数环境使用） */
export const WS_READY_OPEN = 1

/** sidecar 默认放行的看板 Origin（与 sidecar 启动参数默认值一致） */
export const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:4370", "http://localhost:4370"]

/** 最小 storage 接口：浏览器 localStorage 与测试里的假实现共用同一面 */
export interface TerminalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 空配置 */
export function emptyTerminalConfig(): TerminalConfig {
  return { sidecarUrl: "", token: "" }
}

/**
 * 取浏览器 localStorage。
 * bun 测试环境没有 localStorage、浏览器隐私模式访问可能抛错——一律返回 null（读写助手静默跳过）。
 */
export function defaultTerminalStorage(): TerminalStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 当前页面 Origin（bun 测试环境无 location → 空串） */
export function currentOrigin(): string {
  try {
    return globalThis.location?.origin ?? ""
  } catch {
    return ""
  }
}

/**
 * 当前看板 Origin 是否不在 sidecar 的默认白名单内。
 * 不在 → 启动 sidecar 时必须加 `--allow-origin <当前 Origin>`，否则握手被 403 拒。
 */
export function originNeedsAllowOrigin(origin: string): boolean {
  const o = origin.trim()
  if (!o) return false
  return !DEFAULT_ALLOWED_ORIGINS.includes(o)
}

/**
 * 读终端配置。
 * 无 localStorage / 读取抛错（隐私模式）→ 静默回落空配置，**绝不抛异常**。
 */
export function loadTerminalConfig(
  storage: TerminalStorage | null = defaultTerminalStorage(),
): TerminalConfig {
  try {
    const sidecarUrl = storage?.getItem(TERMINAL_URL_KEY)?.trim() ?? ""
    const token = storage?.getItem(TERMINAL_TOKEN_KEY)?.trim() ?? ""
    return { sidecarUrl, token }
  } catch {
    return emptyTerminalConfig()
  }
}

/** 写终端配置；写入失败（隐私模式/配额满）静默忽略，不影响功能 */
export function saveTerminalConfig(
  config: TerminalConfig,
  storage: TerminalStorage | null = defaultTerminalStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_URL_KEY, config.sidecarUrl.trim())
    storage?.setItem(TERMINAL_TOKEN_KEY, config.token.trim())
  } catch {
    /* 忽略 */
  }
}

/** 归一化 base 的协议：http→ws、https→wss；ws/wss 原样保留；其它协议 → null */
function wsScheme(protocol: string): "ws" | "wss" | null {
  switch (protocol.toLowerCase()) {
    case "http:":
      return "ws"
    case "https:":
      return "wss"
    case "ws:":
      return "ws"
    case "wss:":
      return "wss"
    default:
      return null
  }
}

/**
 * 拼接 sidecar 的 WebSocket 地址。
 * - base 归一化：去尾斜杠、http→ws、https→wss
 * - sessionID 与 token 走 URL 编码
 * - base 非法 / 缺参数 → 返回空串（调用方按「未配置」处理，不去连）
 */
export function sidecarWsUrl(base: string, sessionID: string, token: string): string {
  const b = base.trim()
  const sid = sessionID.trim()
  const tk = token.trim()
  if (!b || !sid || !tk) return ""
  let u: URL
  try {
    u = new URL(b)
  } catch {
    return ""
  }
  const scheme = wsScheme(u.protocol)
  if (!scheme || !u.host) return ""
  // 保留 base 里的路径前缀（反向代理场景），去尾斜杠
  const path = u.pathname.replace(/\/+$/, "")
  return `${scheme}://${u.host}${path}/ws/${encodeURIComponent(sid)}?token=${encodeURIComponent(tk)}`
}

/**
 * sidecar 地址是否合法（能被解析成 sidecar 的 WS 地址）。
 * 探针用的 sessionID / token 只为让拼接流程走完整，不参与实际连接。
 */
export function isValidSidecarUrl(url: string): boolean {
  return sidecarWsUrl(url, "probe", "probe") !== ""
}

/**
 * 终端 Tab 是否可用：需要任务已有会话 ID（worker 已领取）+ 配置齐全且地址合法。
 * 缺配置 / 缺会话 ID / 地址非法 → false（不显示那个点开就报错的空 Tab）。
 */
export function terminalAvailable(config: TerminalConfig, sessionID: string | null | undefined): boolean {
  const sid = (sessionID ?? "").trim()
  if (!sid) return false
  if (!config.sidecarUrl.trim() || !config.token.trim()) return false
  return isValidSidecarUrl(config.sidecarUrl)
}

/** 连接状态机的动作 */
export type TerminalConnAction = "connect" | "hold" | "disconnect"

/** 连接判定的输入 */
export interface TerminalConnInput {
  /** 上一轮的连接键（空串 = 尚未连接，或切出页签时已被清空） */
  prevKey: string
  /** 本轮计算出的连接键 */
  nextKey: string
  /** 终端 Tab 是否处于激活态 */
  active: boolean
}

/**
 * 连接判定（组件只调用它，判定逻辑不留在 .svelte 里）。
 *
 * - `disconnect`：页签切出 → 断开（键同时清空；切回时键变化 → 会重连）
 * - `hold`：键未变 → 不动。**键未变一律不重连**——看板快照重渲染
 *   （父组件把 task 换成新对象，props 的 getter 失效 → effect 重跑）、
 *   配置对象被整体替换但值没变、exit/error 之后的自动重连，全属此类。
 *   重连的唯一入口是用户点「重连」（切出切回除外）。
 * - `connect`：键变了 → 连（换任务 / 换会话 / 换配置 / 切回页签）
 */
export function decideTerminalConn(input: TerminalConnInput): TerminalConnAction {
  if (!input.active) return "disconnect"
  if (!input.nextKey) return "hold"
  return input.prevKey === input.nextKey ? "hold" : "connect"
}

/**
 * 连接收敛键：任务 ID + 会话 ID + sidecar 地址 + 口令。
 * 键不变 → 不重建 WS / xterm（看板快照频繁重渲染不得重建连接）。
 */
export function terminalConnKey(
  taskID: string,
  sessionID: string,
  sidecarUrl: string,
  token: string,
): string {
  return `${taskID}\u0000${sessionID}\u0000${sidecarUrl.trim()}\u0000${token.trim()}`
}

/** sidecar → 浏览器的控制消息 */
export type TerminalControl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "error"; message: string }
  | { type: "exit"; code: number }

/**
 * 解析 sidecar 发来的文本控制帧；不是合法控制帧 → null（调用方忽略）。
 * 契约见 sidecar README §5：error 带 message、exit 带 code。
 */
export function parseTerminalControl(text: string): TerminalControl | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const o = value as Record<string, unknown>
  if (o.type === "resize" && typeof o.cols === "number" && typeof o.rows === "number") {
    return { type: "resize", cols: o.cols, rows: o.rows }
  }
  if (o.type === "error" && typeof o.message === "string") {
    return { type: "error", message: o.message }
  }
  if (o.type === "exit") {
    return { type: "exit", code: typeof o.code === "number" ? o.code : 0 }
  }
  return null
}

/** 编码 resize 控制帧（**文本帧**：JSON 控制消息） */
export function encodeTerminalResize(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows })
}

/**
 * 编码终端输入（**二进制帧**）。
 * xterm 的 onData 给的是字符串，必须编码成字节再发——直接发字符串会被 sidecar 当控制消息忽略。
 */
export function encodeTerminalInput(data: string): Uint8Array {
  return new TextEncoder().encode(data)
}

/** 编码终端的 8 位二进制输入（xterm 的 onBinary：每个字符码是一个字节） */
export function encodeTerminalBinary(data: string): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff
  return out
}
