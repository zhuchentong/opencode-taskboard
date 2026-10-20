import { describe, expect, test } from "bun:test"
import { createTerminalBridge, type TerminalSocket } from "../../src/terminal"
import { createFakeClock, createFakePty, createFakeRunCmd, createFakeSocket, waitFor } from "./helpers"

/** 组装一个全假实现的桥（绝不碰真 tmux / opencode） */
function setup(overrides: {
  checkSession?: (sessionID: string) => Promise<{ ok: boolean; directory?: string; message?: string }>
  runResponses?: Parameters<typeof createFakeRunCmd>[0]
  idleTimeoutMs?: number
  check?: () => void
} = {}) {
  const clock = createFakeClock()
  const run = createFakeRunCmd(overrides.runResponses ?? {})
  const pty = createFakePty()
  let spawnCount = 0
  const bridge = createTerminalBridge({
    clock,
    runCmd: run,
    spawnPty: async () => {
      spawnCount += 1
      return pty
    },
    checkSession:
      overrides.checkSession ?? (async () => ({ ok: true, directory: "/tmp/work" })),
    discoverDaemon: async () => ({ url: "http://127.0.0.1:49898", password: "pw-12345678" }),
    existsSync: () => true,
    homeDir: () => "/home/u",
    idleTimeoutMs: overrides.idleTimeoutMs ?? 30 * 60 * 1000,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  overrides.check?.()
  return { bridge, clock, run, pty, spawnCount: () => spawnCount }
}

describe("终端桥接核心", () => {
  test("会话不存在 → 中文 error 帧后关连接，且绝不 exec（不建 tmux 会话、不起 pty）", async () => {
    const { bridge, run, pty, spawnCount } = setup({
      checkSession: async () => ({ ok: false, message: "会话不存在：ses_x" }),
    })
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_x")

    expect(ws.controls()).toEqual([{ type: "error", message: "会话不存在：ses_x" }])
    expect(ws.closed.length).toBe(1)
    expect(spawnCount()).toBe(0)
    expect(run.findCalls("new-session").length).toBe(0)
    expect(pty.killed).toBe(false)
  })

  test("服务发现失败 → 中文 error 帧后关连接，绝不 exec", async () => {
    const clock = createFakeClock()
    const run = createFakeRunCmd()
    const pty = createFakePty()
    let spawnCount = 0
    const bridge = createTerminalBridge({
      clock,
      runCmd: run,
      spawnPty: async () => {
        spawnCount += 1
        return pty
      },
      checkSession: async () => ({ ok: true, directory: "/tmp/work" }),
      discoverDaemon: async () => {
        throw new Error("未找到 opencode 服务注册文件：/x/service.json；请先启动 opencode 服务")
      },
      existsSync: () => true,
      homeDir: () => "/home/u",
    })
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_x")

    expect(ws.controls()).toEqual([
      { type: "error", message: "未找到 opencode 服务注册文件：/x/service.json；请先启动 opencode 服务" },
    ])
    expect(ws.closed.length).toBe(1)
    expect(spawnCount).toBe(0)
    expect(run.findCalls("new-session").length).toBe(0)
  })

  test("tmux 不可用 → error 帧后关连接", async () => {
    const { bridge, run, spawnCount } = setup({
      runResponses: { "-V": { code: 1, stdout: "", stderr: "not found" } },
    })
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_x")

    expect(ws.controls()[0]).toMatchObject({ type: "error" })
    expect(String((ws.controls()[0] as { message: string }).message)).toContain("tmux")
    expect(ws.closed.length).toBe(1)
    expect(spawnCount()).toBe(0)
  })

  test("tmux 会话已存在 → 直接 attach，不新建会话", async () => {
    const { bridge, run, spawnCount } = setup()
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    expect(run.findCalls("has-session")[0].args).toEqual(["has-session", "-t", "board-ses_1"])
    expect(run.findCalls("new-session").length).toBe(0)
    expect(spawnCount()).toBe(1)
    expect(ws.closed.length).toBe(0)
  })

  test("tmux 会话不存在 → 新建会话（TUI 命令与凭据进参数数组）", async () => {
    const { bridge, run } = setup({
      runResponses: { "has-session": { code: 1, stdout: "", stderr: "" } },
    })
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    const created = run.findCalls("new-session")[0]
    expect(created.args).toContain("board-ses_1")
    expect(created.args).toContain("--")
    expect(created.args).toContain("opencode")
    expect(created.args).toContain("--server")
    expect(created.args).toContain("http://127.0.0.1:49898")
    expect(created.args).toContain("--session")
    expect(created.args).toContain("ses_1")
    expect(created.args.join(" ")).toContain("OPENCODE_SERVER_PASSWORD=pw-12345678")
    expect(created.args.join(" ")).toContain("-c /tmp/work")
  })

  test("会话工作目录不存在 → 回退 home", async () => {
    const clock = createFakeClock()
    const run = createFakeRunCmd({ "has-session": { code: 1, stdout: "", stderr: "" } })
    const bridge = createTerminalBridge({
      clock,
      runCmd: run,
      spawnPty: async () => createFakePty(),
      checkSession: async () => ({ ok: true, directory: "/no/such/dir" }),
      discoverDaemon: async () => ({ url: "http://127.0.0.1:1", password: "pw-12345678" }),
      existsSync: () => false,
      homeDir: () => "/home/u",
    })
    const ws = createFakeSocket()

    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    const created = run.findCalls("new-session")[0]
    expect(created.args).toContain("/home/u")
  })

  test("终端输出 → 二进制帧回传浏览器", async () => {
    const { bridge, pty } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    pty.push("hello")
    const binary = ws.sent.filter((s) => s.binary)
    expect(binary.length).toBe(1)
    expect(new TextDecoder().decode(binary[0].data as Uint8Array)).toBe("hello")
  })

  test("浏览器输入 → 原样写进 pty（非 UTF-8 字节不被替换）", async () => {
    const { bridge, pty } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    const bytes = new Uint8Array([0x1b, 0xff, 0x41])
    bridge.onMessage(ws as unknown as TerminalSocket, bytes)

    expect(pty.written.length).toBe(1)
    expect(Array.from(pty.written[0] as Uint8Array)).toEqual([0x1b, 0xff, 0x41])
  })

  test("resize 帧 → list-clients 取 tty → stty -F 改尺寸", async () => {
    const { bridge, run } = setup({
      runResponses: { "list-clients": { code: 0, stdout: "/dev/pts/7\n" } },
    })
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    bridge.onMessage(ws as unknown as TerminalSocket, JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
    await waitFor(() => run.calls.some((c) => c.file === "stty"))

    const stty = run.calls.find((c) => c.file === "stty")
    expect(stty?.args).toEqual(["-F", "/dev/pts/7", "cols", "100", "rows", "40"])
  })

  test("非法尺寸 / 未知控制类型：一律忽略，不改尺寸", async () => {
    const { bridge, run } = setup({
      runResponses: { "list-clients": { code: 0, stdout: "/dev/pts/7\n" } },
    })
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    bridge.onMessage(ws as unknown as TerminalSocket, JSON.stringify({ type: "resize", cols: 0, rows: 40 }))
    bridge.onMessage(ws as unknown as TerminalSocket, JSON.stringify({ type: "whatever" }))
    bridge.onMessage(ws as unknown as TerminalSocket, "不是 JSON")
    await new Promise((r) => setTimeout(r, 20))

    expect(run.calls.some((c) => c.file === "stty")).toBe(false)
  })

  test("早到帧缓冲：pty 未就绪时的输入与 resize 排队，就绪后按序补发", async () => {
    const { bridge, run, pty } = setup({
      runResponses: { "list-clients": { code: 0, stdout: "/dev/pts/7\n" } },
    })
    const ws = createFakeSocket()

    const pending = bridge.handle(ws as unknown as TerminalSocket, "ses_1")
    // pty 还没起来就先来两帧
    bridge.onMessage(ws as unknown as TerminalSocket, new TextEncoder().encode("ls\r"))
    bridge.onMessage(ws as unknown as TerminalSocket, JSON.stringify({ type: "resize", cols: 90, rows: 30 }))
    expect(pty.written.length).toBe(0) // 还没写进去（缓冲中）

    await pending
    await waitFor(() => run.calls.some((c) => c.file === "stty"))

    expect(pty.written.length).toBe(1)
    expect(new TextDecoder().decode(pty.written[0] as Uint8Array)).toBe("ls\r")
    const stty = run.calls.find((c) => c.file === "stty")
    expect(stty?.args).toEqual(["-F", "/dev/pts/7", "cols", "90", "rows", "30"])
  })

  test("早到帧缓冲有上限：超出后丢最旧的（防无限增长）", async () => {
    const { bridge, pty } = setup()
    const ws = createFakeSocket()
    const pending = bridge.handle(ws as unknown as TerminalSocket, "ses_1")
    for (let i = 0; i < 400; i++) {
      bridge.onMessage(ws as unknown as TerminalSocket, new TextEncoder().encode(String(i % 10)))
    }
    await pending
    expect(pty.written.length).toBeLessThanOrEqual(256)
    expect(pty.written.length).toBeGreaterThan(0)
  })

  test("TUI 退出 → exit 帧带退出码 + 关连接", async () => {
    const { bridge, pty } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    pty.exit(7)

    expect(ws.controls()).toEqual([{ type: "exit", code: 7 }])
    expect(ws.closed.length).toBe(1)
  })

  test("空闲回收：客户端归零并超时 → kill tmux 会话", async () => {
    const { bridge, clock, run } = setup({ idleTimeoutMs: 1000 })
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    bridge.onClose(ws as unknown as TerminalSocket)
    clock.advance(1000)
    await waitFor(() => run.findCalls("kill-session").length > 0)

    expect(run.findCalls("kill-session")[0].args).toEqual(["kill-session", "-t", "board-ses_1"])
  })

  test("应用层心跳：25s 一帧 ping", async () => {
    const { bridge, clock } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    clock.advance(25_000)
    expect(ws.controls()).toEqual([{ type: "ping" }])
  })

  test("准备期间连接断开 → 刚建的 tmux 会话被回收（不留空跑的 TUI）", async () => {
    const clock = createFakeClock()
    const run = createFakeRunCmd({ "has-session": { code: 1, stdout: "", stderr: "" } })
    let hook: (() => void) | undefined
    const runWithHook = async (file: string, args: string[], opts?: { timeoutMs?: number }) => {
      const r = await run(file, args, opts)
      if (args[0] === "has-session") hook?.()
      return r
    }
    const pty = createFakePty()
    const bridge = createTerminalBridge({
      clock,
      runCmd: runWithHook,
      spawnPty: async () => pty,
      checkSession: async () => ({ ok: true, directory: "/tmp/work" }),
      discoverDaemon: async () => ({ url: "http://127.0.0.1:49898", password: "pw-12345678" }),
      existsSync: () => true,
      homeDir: () => "/home/u",
    })
    const ws = createFakeSocket()
    const pending = bridge.handle(ws as unknown as TerminalSocket, "ses_1")
    hook = () => bridge.onClose(ws as unknown as TerminalSocket)
    await pending

    expect(run.findCalls("new-session").length).toBe(1)
    expect(run.findCalls("kill-session")[0]?.args).toEqual(["kill-session", "-t", "board-ses_1"])
    expect(pty.dataCbs.length).toBe(0) // 没起 attach 客户端
  })

  test("close()：关自身连接与子进程，但不动 tmux 会话", async () => {
    const { bridge, pty, run } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")

    await bridge.close()

    expect(ws.closed.length).toBe(1)
    expect(pty.killed).toBe(true)
    expect(run.findCalls("kill-session").length).toBe(0)
    expect(bridge.stats().connections).toBe(0)
  })

  test("连接关闭后不再回帧（避免对已断开的连接写数据）", async () => {
    const { bridge, pty } = setup()
    const ws = createFakeSocket()
    await bridge.handle(ws as unknown as TerminalSocket, "ses_1")
    bridge.onClose(ws as unknown as TerminalSocket)

    pty.push("late")
    expect(ws.sent.length).toBe(0)
  })
})
