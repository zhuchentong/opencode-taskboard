import { test } from "node:test"
import assert from "node:assert/strict"

import { CHECK_CODE, basicAuthHeader, verifySession } from "../../src/session-check.js"

/** 造一个假 fetch */
function fakeFetch(response) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options })
    if (typeof response === "function") return response(url, options)
    return response
  }
  impl.calls = calls
  return impl
}

const base = { daemonUrl: "http://127.0.0.1:49898", password: "pw", sessionID: "ses_abc" }

test("verifySession：200 → 放行，并取出会话工作区", async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    json: async () => ({ data: { id: "ses_abc", location: { directory: "/tmp/work" } } }),
  })
  const result = await verifySession({ ...base, fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.directory, "/tmp/work")
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:49898/api/session/ses_abc")
  assert.match(fetchImpl.calls[0].options.headers.Authorization, /^Basic /)
})

test("verifySession：404 → 拒绝执行并给出中文提示", async () => {
  const fetchImpl = fakeFetch({ status: 404, json: async () => ({}) })
  const result = await verifySession({ ...base, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, CHECK_CODE.NOT_FOUND)
  assert.match(result.message, /会话不存在：ses_abc/)
})

test("verifySession：401 → 拒绝执行并提示凭据可能过期", async () => {
  const fetchImpl = fakeFetch({ status: 401, json: async () => ({}) })
  const result = await verifySession({ ...base, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, CHECK_CODE.UNAUTHORIZED)
  assert.match(result.message, /认证失败/)
})

test("verifySession：网络异常 → 拒绝执行", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("ECONNREFUSED")
  })
  const result = await verifySession({ ...base, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, CHECK_CODE.UNREACHABLE)
  assert.match(result.message, /无法连接 opencode 服务/)
})

test("verifySession：其它异常状态 → 拒绝执行", async () => {
  const fetchImpl = fakeFetch({ status: 500, json: async () => ({}) })
  const result = await verifySession({ ...base, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, CHECK_CODE.ERROR)
})

test("basicAuthHeader：用户名固定 opencode", () => {
  const header = basicAuthHeader("pw")
  assert.equal(header, `Basic ${Buffer.from("opencode:pw").toString("base64")}`)
})
