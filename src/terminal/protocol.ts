// 浏览器 ↔ 看板终端桥的帧协议（与 sidecar 完全一致，前端零改动即可切换）。
//
// 约定：
// - **二进制帧**：终端原始字节流（浏览器 → 桥是输入，桥 → 浏览器 是输出）。
// - **文本帧**：JSON 控制消息。
//   浏览器 → 桥：{"type":"resize","cols":120,"rows":40}
//   桥 → 浏览器：{"type":"error","message":"会话不存在：xxx"} / {"type":"exit","code":0} / {"type":"ping"}
//
// 为什么用「二进制=数据、文本=控制」而不是给数据加 magic 前缀：
// 前缀方案要求每一帧都做一次字符串扫描，终端粘贴大段文本时开销明显；
// 而 WebSocket 帧本身已区分二进制/文本，零额外开销也不会误判。

/** 控制消息类型 */
export const CONTROL = {
  /** 浏览器 → 桥：调整终端尺寸 */
  RESIZE: "resize",
  /** 桥 → 浏览器：中文错误文本 */
  ERROR: "error",
  /** 桥 → 浏览器：TUI 已退出 */
  EXIT: "exit",
  /** 桥 → 浏览器：应用层心跳（WS 空闲超时的兜底保活） */
  PING: "ping",
} as const

/** 控制消息类型字面量 */
export type ControlType = (typeof CONTROL)[keyof typeof CONTROL]

/** 解析出来的控制消息（字段随类型而变，调用方按 type 分派） */
export interface ParsedControl {
  type: string
  [key: string]: unknown
}

/** 编码控制消息（文本帧） */
export function encodeControl(payload: { type: string; [key: string]: unknown }): string {
  return JSON.stringify(payload)
}

/**
 * 解析控制消息；不是合法控制消息时返回 null（调用方按普通数据处理）。
 * 刻意宽松：只要求是个带字符串 type 的对象，其余字段由各分支自己校验。
 */
export function parseControl(text: string | Uint8Array): ParsedControl | null {
  let value: unknown
  try {
    value = JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  if (typeof (value as { type?: unknown }).type !== "string") return null
  return value as ParsedControl
}

/** 尺寸消息是否合法（cols/rows 为正整数且在合理范围内） */
export function isValidSize(cols: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    (cols as number) > 0 &&
    (rows as number) > 0 &&
    (cols as number) <= 1000 &&
    (rows as number) <= 1000
  )
}
