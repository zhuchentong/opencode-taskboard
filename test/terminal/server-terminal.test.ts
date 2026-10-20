import { afterEach, describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../../src/store"
import { createServer, type ServerHandle } from "../../src/server"
import { createTerminalBridge, type TerminalSocket } from "../../src/terminal"
import { createFakePty, createFakeRunCmd, waitFor } from "./helpers"

const FIXDIR = "test/.webroot-fixture"
const TOKEN = "tok123"

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

/** 起一个带真实终端桥（假依赖）的看板服务，并返回端口与任务 ID */
async function setup(opts: { withTerminal?: boolean; sessionID?: string; checkOk?: boolean } = {}) {
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const task = await store.create({ title: "终端任务" })
  await store.patch(task.id, { status: "pending" })
  const sessionID = opts.sessionID ?? "ses_terminal"
  if (opts.sessionID !== null) {
    await store.claim({ id: task.id, sessionID, agent: "build" })
  }

  const run = createFakeRunCmd({ "list-clients": { code: 0, stdout: "/dev/pts/3\n" } })
  const pty = createFakePty()
  const bridge = createTerminalBridge({
    runCmd: run,
    spawnPty: async () => pty,
    checkSession: async () =>
      opts.checkOk === false
        ? { ok: false, message: "会话不存在：ses_terminal" }
        : { ok: true, directory: "/tmp/work" },
    discoverDaemon: async () => ({ url: "http://127.0.0.1:49898", password: "pw-12345678" }),
    existsSync: () => true,
    homeDir: () => "/home/u",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })

  const handle = createServer(store, {
    port: 0,
    token: TOKEN,
    webDir: FIXDIR,
    primary: true,
    projectID: "proj-test",
    logs: () => [],
    ...(opts.withTerminal === false ? {} : { terminal: bridge }),
  })
  started.push(handle)
  return { base: `http://127.0.0.1:${handle.actualPort}`, taskID: task.id, run, pty, bridge, store }
}

describe("终端 WebSocket 路由", () => {
  test("未装配终端桥 → 404（次要实例/未启用）", async () => {
    const { base, taskID } = await setup({ withTerminal: false })
    const res = await fetch(`${base}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })

  test("token 缺失或错误 → 401（可写面必须门禁）", async () => {
    const { base, taskID } = await setup()
    const bad = await fetch(`${base}/api/tasks/${taskID}/terminal?token=wrong`)
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("forbidden")

    const none = await fetch(`${base}/api/tasks/${taskID}/terminal`)
    expect(none.status).toBe(401)
  })

  test("任务尚无会话 → 404（没有可附着的 opencode 会话）", async () => {
    const { base, taskID } = await setup({ sessionID: null as unknown as string })
    const res = await fetch(`${base}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    expect(res.status).toBe(404)
  })

  test("普通 GET（不带 Upgrade 头）→ 400「WebSocket 升级失败」", async () => {
    const { base, taskID } = await setup()
    const res = await fetch(`${base}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("WebSocket 升级失败")
  })

  test("正常连接：二进制回显 + resize 生效 + 退出帧传播", async () => {
    const { base, taskID, run, pty } = await setup()
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    const messages: Array<{ binary: boolean; text: string }> = []
    let closed = false
    ws.binaryType = "arraybuffer"
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") messages.push({ binary: false, text: ev.data })
      else messages.push({ binary: true, text: new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer)) })
    }
    ws.onclose = () => {
      closed = true
    }

    await waitFor(() => pty.dataCbs.length > 0)
    // 终端输出 → 二进制帧
    pty.push("TUI-OUTPUT")
    await waitFor(() => messages.some((m) => m.binary))
    expect(messages.find((m) => m.binary)?.text).toBe("TUI-OUTPUT")

    // resize → 服务端改 tmux 客户端尺寸
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
    await waitFor(() => run.calls.some((c) => c.file === "stty"))
    expect(run.calls.find((c) => c.file === "stty")?.args).toEqual([
      "-F",
      "/dev/pts/3",
      "cols",
      "100",
      "rows",
      "40",
    ])

    // TUI 退出 → exit 帧 + 连接关闭
    pty.exit(0)
    await waitFor(() => closed)
    const exitFrame = messages.filter((m) => !m.binary).map((m) => JSON.parse(m.text)).find((m) => m.type === "exit")
    expect(exitFrame).toEqual({ type: "exit", code: 0 })
    ws.close()
  })

  test("会话不存在 → 握手后收到中文 error 帧并关连接", async () => {
    const { base, taskID, pty } = await setup({ checkOk: false })
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    const texts: string[] = []
    let closed = false
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") texts.push(ev.data)
    }
    ws.onclose = () => {
      closed = true
    }

    await waitFor(() => texts.length > 0)
    expect(JSON.parse(texts[0])).toEqual({ type: "error", message: "会话不存在：ses_terminal" })
    await waitFor(() => closed)
    expect(pty.dataCbs.length).toBe(0)
  })

  test("浏览器输入 → 写进 pty（字节原样）", async () => {
    const { base, taskID, pty } = await setup()
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    await waitFor(() => pty.dataCbs.length > 0)
    ws.send(new Uint8Array([0x1b, 0x41]))
    await waitFor(() => pty.written.length > 0)
    expect(Array.from(pty.written[0] as Uint8Array)).toEqual([0x1b, 0x41])
    ws.close()
  })

  test("终端 WS 与 SSE 互不干扰：SSE 照常推快照", async () => {
    const { base, taskID, pty } = await setup()
    const sse = await fetch(`${base}/api/events`)
    expect(sse.status).toBe(200)
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    /** 取下一帧 SSE（先看缓冲再看流） */
    const nextFrame = async (): Promise<string> => {
      for (;;) {
        const idx = buf.indexOf("\n\n")
        if (idx >= 0) {
          const one = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          return one
        }
        const { value } = await reader.read()
        buf += decoder.decode(value)
      }
    }
    // 先读到 hello 帧
    for (;;) {
      const one = await nextFrame()
      if (one.includes("hello")) break
    }

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    await waitFor(() => pty.dataCbs.length > 0)

    // WS 在线时 SSE 仍能收到新快照（走写路由触发广播）
    const w = await fetch(`${base}/api/tasks/${taskID}`, {
      method: "PATCH",
      headers: { "X-Taskboard-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "改名了" }),
    })
    expect(w.status).toBe(200)
    const frame = await Promise.race([
      (async () => {
        for (;;) {
          const one = await nextFrame()
          if (one.includes("改名了")) return one
        }
      })(),
      new Promise<string>((r) => setTimeout(() => r("超时"), 2000)),
    ])
    expect(frame).toContain("data:")
    expect(frame).toContain("改名了")
    ws.close()
    reader.cancel()
  })

  test("服务停止后桥连接被收掉（不残留连接）", async () => {
    const { base, taskID, pty, bridge } = await setup()
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/tasks/${taskID}/terminal?token=${TOKEN}`)
    await waitFor(() => pty.dataCbs.length > 0)
    expect(bridge.stats().connections).toBe(1)
    await bridge.close()
    expect(bridge.stats().connections).toBe(0)
    expect(pty.killed).toBe(true)
    ws.close()
  })
})

/** 类型断言辅助：确保 TerminalSocket 满足桥接层要求 */
export type _SocketCheck = TerminalSocket
