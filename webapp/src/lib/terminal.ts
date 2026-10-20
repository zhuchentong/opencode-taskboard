// 「终端」Tab（网页里打开 opencode session）的前端纯函数：
// 同源 WS 地址构造、看板令牌读取、连接收敛判定、帧编解码。
//
// 终端桥跑在**看板服务进程内**（方案 1），地址是同源的：
// `GET /api/tasks/:id/terminal?token=<看板令牌>` → WebSocket 升级。
// 用户零配置：没有独立的 sidecar 进程，也没有地址/口令设置项。
//
// 协议对齐 src/terminal/protocol.ts：
// - 浏览器 → 桥：**二进制帧 = 终端输入字节**；**文本帧 = JSON 控制消息**（如 resize）
// - 桥 → 浏览器：**二进制帧 = 终端输出字节**；**文本帧 = JSON 控制消息**（error / exit / ping）
//
// 因此 xterm 的 onData 回调（给的是字符串）必须先经 TextEncoder 编码再发：
// 直接发字符串会变成文本帧，被桥当成控制消息忽略掉（终端表现为「敲键盘没反应」）。

/** WebSocket readyState：已连接（不依赖浏览器的 WebSocket.OPEN 常量，便于纯函数环境使用） */
export const WS_READY_OPEN = 1

/** 看板终端 WS 路由前缀（与 src/server.ts 的路由正则同款） */
export const TERMINAL_WS_PATH = "/api/tasks"

/** 页面位置（默认取浏览器 location；纯函数测试可注入假值） */
export interface TerminalLocation {
  /** 页面协议，如 http: / https: */
  protocol: string
  /** 页面主机（含端口），如 127.0.0.1:4370 */
  host: string
}

/**
 * 看板访问令牌（服务端注入 window.__TASKBOARD_TOKEN__）。
 *
 * 惰性读取：模块加载期不碰 window（bun 测试环境无 DOM）；取不到 → 空串
 * （调用方按「无法连接」处理，不去连）。
 */
export function boardToken(): string {
  try {
    const w = globalThis as unknown as { window?: { __TASKBOARD_TOKEN__?: string } }
    return (w.window?.__TASKBOARD_TOKEN__ ?? "").trim()
  } catch {
    return ""
  }
}

/** 当前页面位置（bun 测试环境无 location → null） */
function currentLocation(): TerminalLocation | null {
  try {
    const loc = globalThis.location
    if (!loc) return null
    return { protocol: loc.protocol, host: loc.host }
  } catch {
    return null
  }
}

/** 归一化协议：http→ws、https→wss；ws/wss 原样保留；其它协议 → null */
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
 * 拼接看板内置终端桥的 WebSocket 地址（**同源**）。
 *
 * - 协议映射：http→ws、https→wss（ws/wss 原样保留）
 * - taskID 与 token 走 URL 编码（浏览器 WS 带不了自定义头，token 只能走 query）
 * - 缺 taskID / 缺 token / 无页面位置 / 协议非法 → 返回空串（调用方按「无法连接」处理）
 */
export function terminalWsUrl(
  taskID: string,
  token: string,
  loc?: TerminalLocation,
): string {
  const id = taskID.trim()
  const tk = token.trim()
  if (!id || !tk) return ""
  const l = loc ?? currentLocation()
  if (!l) return ""
  const scheme = wsScheme(l.protocol)
  const host = (l.host ?? "").trim()
  if (!scheme || !host) return ""
  return `${scheme}://${host}${TERMINAL_WS_PATH}/${encodeURIComponent(id)}/terminal?token=${encodeURIComponent(tk)}`
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
 * - `connect`：键变了 → 连（换任务 / 换会话 / 换令牌 / 切回页签）
 */
export function decideTerminalConn(input: TerminalConnInput): TerminalConnAction {
  if (!input.active) return "disconnect"
  if (!input.nextKey) return "hold"
  return input.prevKey === input.nextKey ? "hold" : "connect"
}

/**
 * 连接收敛键：任务 ID + 会话 ID + 看板令牌（三者都去空白）。
 * 键不变 → 不重建 WS / xterm（看板快照频繁重渲染不得重建连接）。
 */
export function terminalConnKey(
  taskID: string,
  sessionID: string,
  token: string,
): string {
  return `${taskID.trim()}\u0000${sessionID.trim()}\u0000${token.trim()}`
}

/** 桥 → 浏览器的控制消息 */
export type TerminalControl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "error"; message: string }
  | { type: "exit"; code: number }

/**
 * 解析桥发来的文本控制帧；不是合法控制帧 → null（调用方忽略）。
 * 契约见 src/terminal/protocol.ts：error 带 message、exit 带 code。
 *
 * ⚠️ 未知类型（含服务端 25s 心跳 `{"type":"ping"}`）一律返回 null → 组件忽略，
 * 不报错、不弹提示（心跳是保活噪音，不是错误）。
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
 * xterm 的 onData 给的是字符串，必须编码成字节再发——直接发字符串会被桥当控制消息忽略。
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
