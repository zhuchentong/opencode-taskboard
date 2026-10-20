/**
 * 存在性校验：执行 opencode 之前先确认会话真的存在。
 *
 * 为什么要先校验：`opencode --session <id>` 在会话不存在时会**静默新建**，
 * 所以必须先 GET 一次 daemon API，404 就短路，**绝不 exec**。
 */

/** 校验结果码 */
export const CHECK_CODE = {
  OK: "ok",
  NOT_FOUND: "not_found",
  UNAUTHORIZED: "unauthorized",
  UNREACHABLE: "unreachable",
  ERROR: "error",
}

/** 组装 Basic 认证头（用户名固定为 opencode） */
export function basicAuthHeader(password) {
  const encoded = Buffer.from(`opencode:${password}`, "utf8").toString("base64")
  return `Basic ${encoded}`
}

/**
 * 校验会话是否存在。
 * @param {object} options
 * @param {string} options.daemonUrl daemon 根地址
 * @param {string} options.password daemon 密码（来自 service.json）
 * @param {string} options.sessionID 会话 ID
 * @param {typeof fetch} [options.fetchImpl] 假 fetch 注入点
 * @param {number} [options.timeoutMs] 请求超时
 * @returns {Promise<{ok:true, directory?:string} | {ok:false, code:string, message:string}>}
 */
export async function verifySession({
  daemonUrl,
  password,
  sessionID,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}) {
  const base = String(daemonUrl).replace(/\/+$/, "")
  const url = `${base}/api/session/${encodeURIComponent(sessionID)}`

  let response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: basicAuthHeader(password) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return {
      ok: false,
      code: CHECK_CODE.UNREACHABLE,
      message: `无法连接 opencode 服务（${base}）：${err?.message ?? "未知错误"}`,
    }
  }

  if (response.status === 200) {
    let directory
    try {
      const body = await response.json()
      directory = body?.data?.location?.directory ?? body?.location?.directory
    } catch {
      // 响应体不是 JSON 也不影响结论：会话存在即可继续
    }
    return { ok: true, directory: typeof directory === "string" ? directory : undefined }
  }

  if (response.status === 404) {
    return { ok: false, code: CHECK_CODE.NOT_FOUND, message: `会话不存在：${sessionID}` }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: CHECK_CODE.UNAUTHORIZED,
      message: "opencode 服务认证失败：凭据可能已过期，请重启 sidecar 重新读取服务注册文件",
    }
  }

  return {
    ok: false,
    code: CHECK_CODE.ERROR,
    message: `opencode 服务返回异常状态：${response.status}`,
  }
}
