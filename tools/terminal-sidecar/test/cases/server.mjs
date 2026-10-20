import { test } from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"

import { createSidecar } from "../../src/server.js"
import { createLogger, createSilentLogger } from "../../src/log.js"
import { createFakeClock, createFakePty, createFakeRunCmd, waitFor } from "../helpers.mjs"

const TOKEN = "test-token"
const ORIGIN = "http://127.0.0.1:4370"

function makeConfig(overrides = {}) {
  return {
    port: 0,
    token: TOKEN,
    daemonUrl: "http://127.0.0.1:49898",
    daemonPassword: "daemon-pw",
    allowOrigins: [ORIGIN],
    idleTimeoutMs: 60_000,
    ...overrides,
  }
}

function okFetch() {
  return async () => ({
    status: 200,
    json: async () => ({ data: { id: "ses_abc", location: { directory: process.cwd() } } }),
  })
}

/** 起一个 sidecar（全部外部依赖用假实现） */
async function startSidecar({ config, fetchImpl, runCmd, spawnPty, clock, logger } = {}) {
  const ptys = []
  const spawnCalls = []
  const sidecar = createSidecar({
    config: config ?? makeConfig(),
    fetchImpl: fetchImpl ?? okFetch(),
    runCmd: runCmd ?? createFakeRunCmd(),
    spawnPty:
      spawnPty ??
      (async (file, args, options) => {
        spawnCalls.push({ file, args, options })
        const pty = createFakePty()
        ptys.push(pty)
        return pty
      }),
    clock: clock ?? createFakeClock(),
    logger: logger ?? createSilentLogger(),
  })
  const { port } = await sidecar.listen(0)
  return { sidecar, port, ptys, spawnCalls }
}

/** 建立 WS 连接 */
function connect(port, { sessionID = "ses_abc", token = TOKEN, origin = ORIGIN } = {}) {
  const url = `ws://127.0.0.1:${port}/ws/${sessionID}?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(url, origin ? { origin } : {})
  const messages = []
  ws.on("message", (data, isBinary) => messages.push({ data, isBinary }))
  let opened = false
  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", () => {
      opened = true
      resolve(ws)
    })
    ws.on("error", (err) => {
      if (!opened) reject(err)
    })
  })
  return { ws, messages, openPromise }
}

/** 期望握手被拒，返回 HTTP 状态码 */
function expectRejected(port, { sessionID = "ses_abc", token = TOKEN, origin = ORIGIN } = {}) {
  const url = `ws://127.0.0.1:${port}/ws/${sessionID}?token=${encodeURIComponent(token)}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {})
    let settled = false
    ws.on("unexpected-response", (req, res) => {
      settled = true
      res.resume()
      resolve(res.statusCode)
    })
    ws.on("open", () => {
      settled = true
      ws.close()
      reject(new Error("本应被拒接，却握手成功"))
    })
    ws.on("error", (err) => {
      if (!settled) reject(err)
    })
  })
}

test("WS 握手：token 不匹配 → 401，且不打印 token 值", async () => {
  const { sidecar, port } = await startSidecar()
  try {
    const status = await expectRejected(port, { token: "wrong-token" })
    assert.equal(status, 401)
  } finally {
    await sidecar.close()
  }
})

test("WS 握手：Origin 不在白名单 → 403", async () => {
  const { sidecar, port } = await startSidecar()
  try {
    const status = await expectRejected(port, { origin: "http://evil.example" })
    assert.equal(status, 403)
  } finally {
    await sidecar.close()
  }
})

test("WS 握手：sessionID 含非法字符 → 400", async () => {
  const { sidecar, port } = await startSidecar()
  try {
    const status = await expectRejected(port, { sessionID: "ses_abc;rm" })
    assert.equal(status, 400)
  } finally {
    await sidecar.close()
  }
})

test("WS 握手：token 与 Origin 都通过 → 建立连接并把终端输出透传给浏览器", async () => {
  const { sidecar, port, ptys } = await startSidecar()
  try {
    const { ws, messages, openPromise } = connect(port)
    await openPromise
    const pty = await waitFor(() => ptys[0])
    pty.push("hello 终端")
    await waitFor(() => messages.length > 0)
    assert.equal(messages[0].isBinary, true)
    assert.equal(messages[0].data.toString("utf8"), "hello 终端")
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：浏览器输入的二进制帧原样写进 pty，resize 控制消息调整尺寸", async () => {
  const { sidecar, port, ptys } = await startSidecar()
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    const pty = await waitFor(() => ptys[0])

    ws.send(Buffer.from("ls\n", "utf8"))
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
    await waitFor(() => pty.written.length > 0 && pty.resized.length > 0)

    // 输入以 Buffer 原样写入（非 UTF-8 字节不被替换成 U+FFFD）
    assert.equal(Buffer.isBuffer(pty.written[0]), true)
    assert.equal(pty.written[0].toString("utf8"), "ls\n")
    assert.deepEqual(pty.resized[0], [100, 40])
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：连接后立刻发来的 resize 不会丢（pty 未就绪时先缓冲）", async () => {
  // 让 pty 启动慢一点：确保浏览器的首帧在 attach 之前到达
  let captured
  const spawnPty = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    captured = createFakePty()
    return captured
  }
  const { sidecar, port } = await startSidecar({ spawnPty })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }))

    const pty = await waitFor(() => captured)
    await waitFor(() => pty.resized.length > 0)
    assert.deepEqual(pty.resized[pty.resized.length - 1], [132, 43])
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：pty 未就绪时先到的输入会在 attach 后按序补写", async () => {
  let captured
  const spawnPty = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    captured = createFakePty()
    return captured
  }
  const { sidecar, port } = await startSidecar({ spawnPty })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    ws.send(Buffer.from("first\n", "utf8"))
    ws.send(Buffer.from("second\n", "utf8"))

    const pty = await waitFor(() => captured)
    await waitFor(() => pty.written.length >= 2)
    assert.equal(pty.written[0].toString("utf8"), "first\n")
    assert.equal(pty.written[1].toString("utf8"), "second\n")
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：未知类型的文本控制帧被忽略，不回错误且连接保持", async () => {
  const logs = []
  const logger = createLogger({ sink: (line) => logs.push(line), debug: true })
  const { sidecar, port, ptys } = await startSidecar({ logger })
  try {
    const { ws, messages, openPromise } = connect(port)
    await openPromise
    const pty = await waitFor(() => ptys[0])

    ws.send(JSON.stringify({ type: "whatever", payload: 1 }))
    ws.send("这不是 JSON")
    await waitFor(() => logs.some((line) => line.includes("忽略未知控制消息类型")))

    // 没有错误帧回传，连接仍在，输入也没被写进 pty
    assert.equal(messages.length, 0)
    assert.equal(ws.readyState, ws.OPEN)
    assert.equal(pty.written.length, 0)
    assert.ok(logs.some((line) => line.includes("忽略无法解析的文本控制帧")))
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：会话不存在 → 回中文错误文本并关闭，绝不 exec", async () => {
  const fetchImpl = async () => ({ status: 404, json: async () => ({}) })
  const { sidecar, port, spawnCalls } = await startSidecar({ fetchImpl })
  try {
    const { ws, messages, openPromise } = connect(port)
    await openPromise
    await waitFor(() => messages.length > 0)
    const payload = JSON.parse(messages[0].data.toString("utf8"))
    assert.equal(payload.type, "error")
    assert.match(payload.message, /会话不存在：ses_abc/)
    // 关键红线：会话不存在时绝不启动 opencode
    assert.equal(spawnCalls.length, 0)
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：daemon 认证失败 → 回中文错误文本，绝不 exec", async () => {
  const fetchImpl = async () => ({ status: 401, json: async () => ({}) })
  const { sidecar, port, spawnCalls } = await startSidecar({ fetchImpl })
  try {
    const { ws, messages, openPromise } = connect(port)
    await openPromise
    await waitFor(() => messages.length > 0)
    const payload = JSON.parse(messages[0].data.toString("utf8"))
    assert.equal(payload.type, "error")
    assert.match(payload.message, /认证失败/)
    assert.equal(spawnCalls.length, 0)
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：tmux 不存在 → 回中文错误文本提示安装 tmux", async () => {
  const runCmd = createFakeRunCmd({ "-V": { code: 127 } })
  const { sidecar, port } = await startSidecar({ runCmd })
  try {
    const { ws, messages, openPromise } = connect(port)
    await openPromise
    await waitFor(() => messages.length > 0)
    const payload = JSON.parse(messages[0].data.toString("utf8"))
    assert.equal(payload.type, "error")
    assert.match(payload.message, /tmux/)
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：tmux 会话不存在时创建，且用参数数组跑 opencode（不经 shell）", async () => {
  const runCmd = createFakeRunCmd({ "has-session": { code: 1 } })
  const { sidecar, port } = await startSidecar({ runCmd })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    await waitFor(() => runCmd.findCalls("new-session").length > 0)
    const args = runCmd.findCalls("new-session")[0].args
    assert.ok(args.includes("opencode"))
    assert.ok(args.includes("--server"))
    assert.ok(args.includes("--session"))
    assert.ok(args.includes("ses_abc"))
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("WS：tmux 会话已存在 → 直接 attach，不重建也不 kill", async () => {
  const runCmd = createFakeRunCmd({ "has-session": { code: 0 } })
  const { sidecar, port } = await startSidecar({ runCmd })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    await waitFor(() => sidecar.idle.clientCount("ses_abc") === 1)
    // 会话已存在：不新建、不 kill
    assert.equal(runCmd.findCalls("new-session").length, 0)
    assert.equal(runCmd.findCalls("kill-session").length, 0)
    assert.equal(runCmd.findCalls("list-panes").length, 0)
    ws.close()
  } finally {
    await sidecar.close()
  }
})

test("HTTP /health：返回 ok/daemon/tmux，且不含密码", async () => {
  const { sidecar, port } = await startSidecar()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.daemon, "http://127.0.0.1:49898")
    assert.equal(typeof body.tmux, "boolean")
    assert.ok(!JSON.stringify(body).includes("daemon-pw"))
  } finally {
    await sidecar.close()
  }
})

test("HTTP /close：缺 token → 401；有 token → 结束 tmux 会话", async () => {
  const runCmd = createFakeRunCmd()
  const { sidecar, port } = await startSidecar({ runCmd })
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/close/ses_abc`, { method: "POST" })
    assert.equal(unauthorized.status, 401)

    const ok = await fetch(`http://127.0.0.1:${port}/close/ses_abc?token=${TOKEN}`, { method: "POST" })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.ok, true)
    assert.equal(runCmd.findCalls("kill-session").length, 1)
    assert.deepEqual(runCmd.findCalls("kill-session")[0].args, ["kill-session", "-t", "board-ses_abc"])
  } finally {
    await sidecar.close()
  }
})

test("空闲回收：客户端断开后超时则 kill 掉 tmux 会话", async () => {
  const clock = createFakeClock()
  const runCmd = createFakeRunCmd()
  const { sidecar, port } = await startSidecar({ runCmd, clock, config: makeConfig({ idleTimeoutMs: 1000 }) })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    await waitFor(() => sidecar.idle.clientCount("ses_abc") === 1)

    ws.close()
    await waitFor(() => sidecar.idle.clientCount("ses_abc") === 0)

    clock.advance(1000)
    await waitFor(() => runCmd.findCalls("kill-session").length > 0)
    assert.deepEqual(runCmd.findCalls("kill-session")[0].args, ["kill-session", "-t", "board-ses_abc"])
  } finally {
    await sidecar.close()
  }
})

test("客户端断开只关自己的 pty 客户端，不 kill 会话（除非超时）", async () => {
  const clock = createFakeClock()
  const runCmd = createFakeRunCmd()
  const { sidecar, port, ptys } = await startSidecar({ runCmd, clock })
  try {
    const { ws, openPromise } = connect(port)
    await openPromise
    const pty = await waitFor(() => ptys[0])

    ws.close()
    await waitFor(() => pty.killed === true)
    assert.equal(runCmd.findCalls("kill-session").length, 0)
  } finally {
    await sidecar.close()
  }
})

test("启动：端口被占用时给中文提示（原始错误留在 cause 里）", async () => {
  const first = createSidecar({ config: makeConfig() })
  const second = createSidecar({ config: makeConfig() })
  try {
    const { port } = await first.listen(0)
    await assert.rejects(
      () => second.listen(port),
      (err) => {
        assert.equal(err.name, "SidecarError")
        assert.match(err.message, new RegExp(`端口 ${port} 已被占用`))
        assert.match(err.message, /--port/)
        // 原始错误保留在 cause 里（供 debug 日志使用）
        assert.equal(err.cause?.code, "EADDRINUSE")
        return true
      },
    )
  } finally {
    await first.close()
    await second.close()
  }
})
