import { test } from "node:test"
import assert from "node:assert/strict"

import {
  checkHandshake,
  extractToken,
  isOriginAllowed,
  isValidSessionID,
  safeEqual,
} from "../../src/auth.js"

test("safeEqual：相同为真、不同为假、非字符串为假", () => {
  assert.equal(safeEqual("abc", "abc"), true)
  assert.equal(safeEqual("abc", "abd"), false)
  assert.equal(safeEqual("abc", "abcd"), false)
  assert.equal(safeEqual(undefined, "abc"), false)
})

test("isOriginAllowed：空 Origin 放行、白名单内放行、白名单外拒绝", () => {
  const allow = ["http://127.0.0.1:4370"]
  assert.equal(isOriginAllowed("", allow), true)
  assert.equal(isOriginAllowed(undefined, allow), true)
  assert.equal(isOriginAllowed("http://127.0.0.1:4370", allow), true)
  assert.equal(isOriginAllowed("http://evil.example", allow), false)
  assert.equal(isOriginAllowed("http://127.0.0.1:4371", allow), false)
})

test("isValidSessionID：只允许字母数字下划线连字符", () => {
  assert.equal(isValidSessionID("ses_abc-123"), true)
  assert.equal(isValidSessionID("ses_abc.def"), false)
  assert.equal(isValidSessionID("ses abc"), false)
  assert.equal(isValidSessionID("ses/abc"), false)
  assert.equal(isValidSessionID("ses;rm -rf /"), false)
  assert.equal(isValidSessionID(""), false)
  assert.equal(isValidSessionID("a".repeat(129)), false)
})

test("checkHandshake：token 缺失/不匹配一律拒绝", () => {
  const base = { expectedToken: "secret", allowOrigins: ["http://127.0.0.1:4370"] }
  assert.equal(checkHandshake({ ...base, token: "", origin: "" }).ok, false)
  assert.equal(checkHandshake({ ...base, token: "", origin: "" }).reason, "missing_token")
  assert.equal(checkHandshake({ ...base, token: "wrong", origin: "" }).reason, "token_mismatch")
  assert.equal(checkHandshake({ ...base, token: "secret", origin: "" }).ok, true)
})

test("checkHandshake：Origin 不在白名单一律拒绝", () => {
  const result = checkHandshake({
    token: "secret",
    origin: "http://evil.example",
    expectedToken: "secret",
    allowOrigins: ["http://127.0.0.1:4370"],
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "origin_denied")
})

test("extractToken：优先查询参数，其次 Authorization: Bearer", () => {
  const url = new URL("http://127.0.0.1:7681/ws/ses_1?token=q")
  assert.equal(extractToken(url, {}), "q")
  const url2 = new URL("http://127.0.0.1:7681/ws/ses_1")
  assert.equal(extractToken(url2, { authorization: "Bearer hdr" }), "hdr")
  assert.equal(extractToken(url2, {}), "")
})
