import { describe, expect, test } from "bun:test"
import { TmuxManager, isValidSessionID, sessionName } from "../../src/terminal/tmux"
import { createFakeRunCmd } from "./helpers"

describe("tmux 会话管理", () => {
  test("会话名带 board- 前缀", () => {
    expect(sessionName("ses_abc")).toBe("board-ses_abc")
  })

  test("sessionID 白名单：只允许字母数字下划线连字符（防会话名注入）", () => {
    expect(isValidSessionID("ses_abc-123")).toBe(true)
    expect(isValidSessionID("ses abc")).toBe(false)
    expect(isValidSessionID("ses;rm -rf /")).toBe(false)
    expect(isValidSessionID("")).toBe(false)
    expect(isValidSessionID("a".repeat(129))).toBe(false)
    expect(isValidSessionID(undefined)).toBe(false)
  })

  test("createSession:参数数组不经 shell，TUI 命令与凭据都进 tmux 参数", async () => {
    const run = createFakeRunCmd()
    const tmux = new TmuxManager({ runCmd: run })

    await tmux.createSession({
      name: "board-ses_1",
      cwd: "/tmp/work",
      cols: 120,
      rows: 30,
      env: { TERM: "tmux-256color", OPENCODE_SERVER_PASSWORD: "pw-123456" },
      command: "opencode",
      args: ["--server", "http://127.0.0.1:49898", "--session", "ses_1"],
    })

    const created = run.findCalls("new-session")[0]
    expect(created.file).toBe("tmux")
    expect(created.args).toEqual([
      "new-session",
      "-d",
      "-s",
      "board-ses_1",
      "-x",
      "120",
      "-y",
      "30",
      "-c",
      "/tmp/work",
      "-e",
      "TERM=tmux-256color",
      "-e",
      "OPENCODE_SERVER_PASSWORD=pw-123456",
      "--",
      "opencode",
      "--server",
      "http://127.0.0.1:49898",
      "--session",
      "ses_1",
    ])
    // 兜底用户 ~/.tmux.conf 可能打开的 remain-on-exit（会复现终端冻屏）
    expect(run.findCalls("set-option").some((c) => c.args.includes("remain-on-exit"))).toBe(true)
  })

  test("createSession:并发撞 duplicate session 视为已建好，不抛错", async () => {
    const run = createFakeRunCmd({
      "new-session": () => ({ code: 1, stdout: "", stderr: "duplicate session: board-x" }),
    })
    const tmux = new TmuxManager({ runCmd: run })
    const r = await tmux.createSession({
      name: "board-x",
      cwd: "/tmp",
      command: "opencode",
      args: ["--server", "u", "--session", "s"],
    })
    expect(r.created).toBe(false)
  })

  test("createSession:其它失败抛中文错误", async () => {
    const run = createFakeRunCmd({ "new-session": () => ({ code: 1, stdout: "", stderr: "boom" }) })
    const tmux = new TmuxManager({ runCmd: run })
    await expect(
      tmux.createSession({ name: "board-x", cwd: "/tmp", command: "opencode", args: [] }),
    ).rejects.toThrow(/创建 tmux 会话失败/)
  })

  test("hasSession/killSession:按退出码判定", async () => {
    const run = createFakeRunCmd({ "has-session": () => ({ code: 0 }), "kill-session": () => ({ code: 1 }) })
    const tmux = new TmuxManager({ runCmd: run })
    expect(await tmux.hasSession("board-x")).toBe(true)
    expect(await tmux.killSession("board-x")).toBe(false)
  })

  test("resizeClients:list-clients 取 tty → stty -F 改尺寸", async () => {
    const run = createFakeRunCmd({ "list-clients": () => ({ code: 0, stdout: "/dev/pts/5\n" }) })
    const tmux = new TmuxManager({ runCmd: run })

    const ok = await tmux.resizeClients("board-x", 100, 40)
    expect(ok).toBe(true)
    expect(run.findCalls("list-clients")[0].args).toEqual([
      "list-clients",
      "-t",
      "board-x",
      "-F",
      "#{client_tty}",
    ])
    const stty = run.findCalls("stty") // stty 是命令名，findCalls 按 args[0] 匹配不到
    expect(stty).toEqual([])
    const sttyCall = run.calls.find((c) => c.file === "stty")
    expect(sttyCall?.args).toEqual(["-F", "/dev/pts/5", "cols", "100", "rows", "40"])
  })

  test("resizeClients:客户端尚未登记时重试若干次后再放弃", async () => {
    let calls = 0
    const run = createFakeRunCmd({
      "list-clients": () => {
        calls += 1
        return { code: 0, stdout: calls < 3 ? "" : "/dev/pts/9\n" }
      },
    })
    const tmux = new TmuxManager({ runCmd: run, sleep: async () => {} })
    const ok = await tmux.resizeClients("board-x", 80, 24)
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test("available:成功永久缓存，失败短缓存后可重试", async () => {
    let probe = 0
    const run = createFakeRunCmd({
      "-V": () => {
        probe += 1
        return { code: probe === 1 ? 1 : 0 }
      },
    })
    const tmux = new TmuxManager({ runCmd: run })
    expect(await tmux.available()).toBe(false)
    // 失败结果在 TTL 内被缓存
    expect(await tmux.available()).toBe(false)
    expect(probe).toBe(1)
  })
})
