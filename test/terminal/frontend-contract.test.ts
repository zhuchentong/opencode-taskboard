// 前后端终端路由的**跨层真契约**用例。
//
// 问题背景：前端 `TERMINAL_WS_PATH`（webapp/src/lib/terminal.ts）与服务端正则
// （src/server.ts 的 `terminalMatch`）各写一份路径——一旦服务端改路径/段序，
// 前端单测（自带仿写假服务端）照样全绿，终端页签却静默连不上。
//
// 本用例把两端接起来：前端**真** `terminalWsUrl` 生成的地址 → 连**真**服务端
// （`createServer`，路由正则走真的）→ 断言 WebSocket 升级成功。
// 服务端路径一改，这里立刻红。

import { afterEach, describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../../src/store"
import { createServer, type ServerHandle } from "../../src/server"
import { createTerminalBridge } from "../../src/terminal"
import { terminalWsUrl } from "../../webapp/src/lib/terminal"
import { createFakePty, createFakeRunCmd } from "./helpers"

const FIXDIR = "test/.webroot-fixture"
const TOKEN = "tok123"

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

/**
 * 起一个真实看板服务（内存 store + 真 createServer）。
 * @param withTerminal 是否注入终端桥（false = 次要实例/未装配）
 */
async function setup(opts: { withTerminal?: boolean } = {}) {
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const task = await store.create({ title: "契约任务" })
  await store.patch(task.id, { status: "pending" })
  await store.claim({ id: task.id, sessionID: "ses_contract", agent: "build" })

  const run = createFakeRunCmd({ "list-clients": { code: 0, stdout: "/dev/pts/3\n" } })
  const pty = createFakePty()
  // 真桥接层 + 假外部依赖（绝不真的启动 opencode / tmux）
  const bridge = createTerminalBridge({
    runCmd: run,
    spawnPty: async () => pty,
    checkSession: async () => ({ ok: true, directory: "/tmp/work" }),
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
    projectID: "proj-contract",
    logs: () => [],
    ...(opts.withTerminal === false ? {} : { terminal: bridge }),
  })
  started.push(handle)
  return { handle, task, store }
}

/**
 * 连一次 WebSocket，返回是否升级成功。
 * - "open"：握手成功（onopen 触发）
 * - "failed"：握手失败（服务端没升级：404/401/400，浏览器只会拿到通用 onerror）
 */
function connectOnce(url: string, timeoutMs = 3000): Promise<"open" | "failed"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const done = (r: "open" | "failed") => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      done("failed")
      try {
        ws.close()
      } catch {
        /* 已断开 */
      }
    }, timeoutMs)
    ws.onopen = () => {
      clearTimeout(timer)
      done("open")
    }
    ws.onerror = () => {
      clearTimeout(timer)
      done("failed")
    }
    ws.onclose = () => {
      clearTimeout(timer)
      done("failed")
    }
  })
}

describe("前后端终端路由契约（前端 terminalWsUrl ↔ 服务端真路由）", () => {
  test("前端生成的同源地址能连上真服务端的终端 WS 路由（升级成功）", async () => {
    const { handle, task } = await setup()
    const url = terminalWsUrl(task.id, TOKEN, {
      protocol: "http:",
      host: `127.0.0.1:${handle.actualPort}`,
    })
    // 前端拼出的地址形状（钉住路径与段序：/api/tasks/<taskID>/terminal）
    expect(new URL(url).pathname).toBe(`/api/tasks/${encodeURIComponent(task.id)}/terminal`)
    expect(new URL(url).searchParams.get("token")).toBe(TOKEN)

    // 真服务端（路由正则走真的）必须能升级这条连接
    expect(await connectOnce(url)).toBe("open")
  })

  test("未装配终端桥（次要实例）→ 同一地址升级失败（钉住「仅主实例装配」）", async () => {
    const { handle, task } = await setup({ withTerminal: false })
    const url = terminalWsUrl(task.id, TOKEN, {
      protocol: "http:",
      host: `127.0.0.1:${handle.actualPort}`,
    })
    expect(await connectOnce(url)).toBe("failed")
  })

  test("令牌错误 → 同一地址升级失败（前端令牌必须被服务端接受）", async () => {
    const { handle, task } = await setup()
    const url = terminalWsUrl(task.id, "wrong-token", {
      protocol: "http:",
      host: `127.0.0.1:${handle.actualPort}`,
    })
    expect(await connectOnce(url)).toBe("failed")
  })

  test("任务 ID 不存在 → 升级失败（前端不能用别的任务 ID 连终端）", async () => {
    const { handle } = await setup()
    const url = terminalWsUrl("不存在的任务", TOKEN, {
      protocol: "http:",
      host: `127.0.0.1:${handle.actualPort}`,
    })
    expect(await connectOnce(url)).toBe("failed")
  })
})
