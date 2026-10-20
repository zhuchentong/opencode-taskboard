/**
 * 浏览器 ↔ sidecar 的 WebSocket 协议。
 *
 * 约定（浏览器端实现须对齐）：
 * - **二进制帧**：终端原始字节流（浏览器 → sidecar 是输入，sidecar → 浏览器 是输出）。
 * - **文本帧**：JSON 控制消息。
 *   浏览器 → sidecar：{"type":"resize","cols":120,"rows":40}
 *   sidecar → 浏览器：{"type":"error","message":"会话不存在：xxx"} / {"type":"exit","code":0}
 *
 * 为什么用「二进制=数据、文本=控制」而不是给数据加 magic 前缀：
 * 前缀方案要求每一帧都做一次字符串扫描，终端粘贴大段文本时开销明显；
 * 而 WebSocket 帧本身已区分二进制/文本，零额外开销也不会误判。
 */

/** 控制消息类型 */
export const CONTROL = {
  /** 浏览器 → sidecar：调整终端尺寸 */
  RESIZE: "resize",
  /** sidecar → 浏览器：中文错误文本 */
  ERROR: "error",
  /** sidecar → 浏览器：TUI 已退出 */
  EXIT: "exit",
}

/** 编码控制消息 */
export function encodeControl(payload) {
  return JSON.stringify(payload)
}

/**
 * 解析控制消息；不是合法控制消息时返回 null（调用方按普通数据处理）。
 * @param {string|Buffer} text
 */
export function parseControl(text) {
  let value
  try {
    value = JSON.parse(typeof text === "string" ? text : text.toString("utf8"))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  if (typeof value.type !== "string") return null
  return value
}

/** 尺寸消息是否合法（cols/rows 为正整数且在合理范围内） */
export function isValidSize(cols, rows) {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 1000 &&
    rows <= 1000
  )
}
