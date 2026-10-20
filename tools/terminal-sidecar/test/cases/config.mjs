import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_ALLOW_ORIGINS,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_PORT,
  ConfigError,
  discoverDaemon,
  normalizeDaemonUrl,
  parseArgs,
  parseServiceJson,
  resolveServiceFilePath,
} from "../../src/config.js"

test("parseArgs：默认值（端口 7681 / 空闲 30 分钟 / 看板 Origin 白名单）", () => {
  const args = parseArgs(["--token", "abc"])
  assert.equal(args.port, DEFAULT_PORT)
  assert.equal(args.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES)
  assert.deepEqual(args.allowOrigins, DEFAULT_ALLOW_ORIGINS)
  assert.equal(args.token, "abc")
})

test("parseArgs：缺少 --token 直接报错", () => {
  assert.throws(() => parseArgs([]), (err) => err instanceof ConfigError && /--token/.test(err.message))
})

test("parseArgs：--port / --idle-timeout / --allow-origin 生效", () => {
  const args = parseArgs([
    "--token",
    "abc",
    "--port=7999",
    "--idle-timeout",
    "5",
    "--allow-origin",
    "http://127.0.0.1:8080",
    "--allow-origin",
    "http://127.0.0.1:8080",
  ])
  assert.equal(args.port, 7999)
  assert.equal(args.idleTimeoutMinutes, 5)
  assert.deepEqual(args.allowOrigins, [...DEFAULT_ALLOW_ORIGINS, "http://127.0.0.1:8080"])
})

test("parseArgs：端口非法时报中文错误", () => {
  assert.throws(
    () => parseArgs(["--token", "abc", "--port", "70000"]),
    (err) => err instanceof ConfigError && /--port/.test(err.message),
  )
})

test("parseArgs：未知参数报错", () => {
  assert.throws(() => parseArgs(["--token", "abc", "--wat"]), ConfigError)
})

test("normalizeDaemonUrl：去掉末尾斜杠并拒绝非 http(s) 地址", () => {
  assert.equal(normalizeDaemonUrl("http://127.0.0.1:49898/"), "http://127.0.0.1:49898")
  assert.throws(() => normalizeDaemonUrl("127.0.0.1:49898"), ConfigError)
  assert.throws(() => normalizeDaemonUrl("http://127.0.0.1:49898 && rm -rf /"), ConfigError)
})

test("resolveServiceFilePath：--service-file 优先，其次 XDG_STATE_HOME，最后 home", () => {
  assert.equal(
    resolveServiceFilePath({ serviceFile: "/tmp/x.json", env: { XDG_STATE_HOME: "/state" }, home: "/home/u" }),
    "/tmp/x.json",
  )
  assert.equal(
    resolveServiceFilePath({ env: { XDG_STATE_HOME: "/state" }, home: "/home/u" }),
    "/state/opencode/service.json",
  )
  assert.equal(
    resolveServiceFilePath({ env: {}, home: "/home/u" }),
    "/home/u/.local/state/opencode/service.json",
  )
})

test("parseServiceJson：正常内容解析出 url 与 password", () => {
  const info = parseServiceJson(
    JSON.stringify({ id: "i", version: "2.0.32", url: "http://127.0.0.1:49898", pid: 1, password: "pw" }),
  )
  assert.equal(info.url, "http://127.0.0.1:49898")
  assert.equal(info.password, "pw")
})

test("parseServiceJson：坏 JSON / 缺 url / 缺 password 都有明确中文错误", () => {
  assert.throws(() => parseServiceJson("{不是 json"), (err) => err instanceof ConfigError && /解析失败/.test(err.message))
  assert.throws(() => parseServiceJson(JSON.stringify({ password: "pw" })), (err) => /url/.test(err.message))
  assert.throws(() => parseServiceJson(JSON.stringify({ url: "http://x" })), (err) => /password/.test(err.message))
})

test("discoverDaemon：默认从服务注册文件读 url 与 password", async () => {
  const readFileImpl = async () =>
    JSON.stringify({ id: "i", version: "2", url: "http://127.0.0.1:49898", pid: 7, password: "pw" })
  const result = await discoverDaemon({ serviceFilePath: "/tmp/service.json", readFileImpl })
  assert.equal(result.url, "http://127.0.0.1:49898")
  assert.equal(result.password, "pw")
})

test("discoverDaemon：--daemon 只覆盖地址，密码仍取服务注册文件", async () => {
  const readFileImpl = async () => JSON.stringify({ url: "http://127.0.0.1:49898", password: "pw" })
  const result = await discoverDaemon({
    serviceFilePath: "/tmp/service.json",
    daemonOverride: "http://127.0.0.1:1234",
    readFileImpl,
  })
  assert.equal(result.url, "http://127.0.0.1:1234")
  assert.equal(result.password, "pw")
})

test("discoverDaemon：文件缺失时报中文错误", async () => {
  const readFileImpl = async () => {
    const err = new Error("ENOENT")
    err.code = "ENOENT"
    throw err
  }
  await assert.rejects(
    () => discoverDaemon({ serviceFilePath: "/tmp/nope.json", readFileImpl }),
    (err) => err instanceof ConfigError && /未找到/.test(err.message),
  )
})
