import { test } from "node:test"
import assert from "node:assert/strict"

import { createLogger } from "../../src/log.js"

test("日志脱敏：长度 ≥ 8 的机密被替换成 ***", () => {
  const lines = []
  const logger = createLogger({ redact: ["super-secret-token"], sink: (line) => lines.push(line) })
  logger.info("连接用的口令是 super-secret-token，请勿外传")
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes("super-secret-token"))
  assert.match(lines[0], /\*\*\*/)
  // 其余内容保持可读
  assert.match(lines[0], /请勿外传/)
})

test("日志脱敏：短于 8 个字符的机密不做替换（避免打烂整行日志）", () => {
  const lines = []
  const logger = createLogger({ redact: ["abc"], sink: (line) => lines.push(line) })
  logger.info("路径 /home/abc/def 正常输出")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\/home\/abc\/def/)
  assert.ok(!lines[0].includes("***"))
})

test("日志脱敏：多个机密都会被替换", () => {
  const lines = []
  const logger = createLogger({
    redact: ["token-value-1", "password-value-2"],
    sink: (line) => lines.push(line),
  })
  logger.info("token-value-1 与 password-value-2")
  assert.ok(!lines[0].includes("token-value-1"))
  assert.ok(!lines[0].includes("password-value-2"))
})

test("debug 级日志：默认静默，打开后才输出", () => {
  const lines = []
  const quiet = createLogger({ sink: (line) => lines.push(line) })
  quiet.debug("不该出现")
  assert.equal(lines.length, 0)

  const verbose = createLogger({ sink: (line) => lines.push(line), debug: true })
  verbose.debug("应该出现")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /应该出现/)
})
