/**
 * 握手门禁：token 比对 + Origin 白名单（CSWSH 收口）。
 *
 * 硬要求：任何一条不过都要**拒接**，且日志里**不打印 token 值**。
 */

import { createHash, timingSafeEqual } from "node:crypto"

/** sessionID 只允许这些字符（同时防 tmux 会话名注入） */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 常量时间比较（先哈希再比，避免长度差异带来的时序泄漏）。
 * 任意一侧不是字符串都按「不相等」处理。
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const ha = createHash("sha256").update(a, "utf8").digest()
  const hb = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(ha, hb)
}

/** sessionID 是否合法 */
export function isValidSessionID(id) {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id)
}

/**
 * Origin 白名单判定。
 * 空 Origin 放行（非浏览器客户端，如 curl / 本地脚本）；其余必须精确命中白名单。
 */
export function isOriginAllowed(origin, allowOrigins = []) {
  if (origin === undefined || origin === null || origin === "") return true
  return allowOrigins.includes(origin)
}

/** 门禁失败原因 → 中文说明（不含任何凭据） */
export const REJECT_REASON_TEXT = {
  missing_token: "缺少 token 参数",
  token_mismatch: "token 不匹配",
  origin_denied: "Origin 不在白名单内",
  invalid_session_id: "sessionID 非法",
  unknown_path: "未知路径",
}

/**
 * 握手门禁判定。
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkHandshake({ token, origin, expectedToken, allowOrigins = [] }) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" }
  }
  if (!safeEqual(token, expectedToken)) {
    return { ok: false, reason: "token_mismatch" }
  }
  if (!isOriginAllowed(origin, allowOrigins)) {
    return { ok: false, reason: "origin_denied" }
  }
  return { ok: true }
}

/** 从请求里取 token：优先查询参数，其次 Authorization: Bearer */
export function extractToken(url, headers = {}) {
  const fromQuery = url?.searchParams?.get?.("token")
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery
  const auth = headers.authorization ?? headers.Authorization
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1]
  }
  return ""
}
