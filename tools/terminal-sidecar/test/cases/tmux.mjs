import { test } from "node:test"
import assert from "node:assert/strict"

import { TMUX_PROBE_FAILURE_TTL_MS, TMUX_SESSION_PREFIX, TmuxManager, sessionName } from "../../src/tmux.js"
import { createFakeClock, createFakeRunCmd } from "../helpers.mjs"

test("sessionName：会话名带 board- 前缀", () => {
  assert.equal(sessionName("ses_abc"), `${TMUX_SESSION_PREFIX}ses_abc`)
})

test("TmuxManager：has-session 依据退出码判定", async () => {
  const runCmd = createFakeRunCmd({ "has-session": { code: 0 } })
  const tmux = new TmuxManager({ runCmd })
  assert.equal(await tmux.hasSession("board_x"), true)
  assert.deepEqual(runCmd.calls[0].args, ["has-session", "-t", "board_x"])

  const runCmd2 = createFakeRunCmd({ "has-session": { code: 1 } })
  const tmux2 = new TmuxManager({ runCmd: runCmd2 })
  assert.equal(await tmux2.hasSession("board_x"), false)
})

test("TmuxManager：不设 remain-on-exit（TUI 退出即会话消失，避免 attach 客户端冻屏）", async () => {
  const runCmd = createFakeRunCmd()
  const tmux = new TmuxManager({ runCmd })
  await tmux.createSession({
    name: "board_ses_abc",
    cwd: "/tmp/work",
    command: "opencode",
    args: ["--server", "http://127.0.0.1:49898", "--session", "ses_abc"],
  })
  const optionCalls = runCmd.findCalls("set-option")
  assert.ok(
    !optionCalls.some((call) => call.args.includes("remain-on-exit")),
    "不应再设置 remain-on-exit",
  )
  // 死面板判定接口已下线
  assert.equal(tmux.isPaneDead, undefined)
})

test("TmuxManager：createSession 用参数数组执行命令，不经 shell", async () => {
  const runCmd = createFakeRunCmd()
  const tmux = new TmuxManager({ runCmd })
  await tmux.createSession({
    name: "board_ses_abc",
    cwd: "/tmp/work",
    cols: 100,
    rows: 40,
    env: { TERM: "tmux-256color", OPENCODE_SERVER_PASSWORD: "pw" },
    command: "opencode",
    args: ["--server", "http://127.0.0.1:49898", "--session", "ses_abc"],
  })

  const create = runCmd.findCalls("new-session")[0]
  assert.deepEqual(create.args, [
    "new-session",
    "-d",
    "-s",
    "board_ses_abc",
    "-x",
    "100",
    "-y",
    "40",
    "-c",
    "/tmp/work",
    "-e",
    "TERM=tmux-256color",
    "-e",
    "OPENCODE_SERVER_PASSWORD=pw",
    "--",
    "opencode",
    "--server",
    "http://127.0.0.1:49898",
    "--session",
    "ses_abc",
  ])
  // 命令与参数是独立 argv 元素，没有拼成 shell 字符串
  assert.ok(create.args.includes("opencode"))
  assert.ok(!create.args.some((arg) => String(arg).includes("&&")))

  // 只设终端类型，不设 remain-on-exit
  assert.deepEqual(runCmd.findCalls("set-option")[0].args, [
    "set-option",
    "-t",
    "board_ses_abc",
    "default-terminal",
    "tmux-256color",
  ])
})

test("TmuxManager：createSession 失败时抛中文错误", async () => {
  const runCmd = createFakeRunCmd({ "new-session": { code: 1, stderr: "no server running" } })
  const tmux = new TmuxManager({ runCmd })
  await assert.rejects(
    () => tmux.createSession({ name: "board_x", cwd: "/tmp", command: "opencode", args: [] }),
    (err) => /创建 tmux 会话失败/.test(err.message),
  )
})

test("TmuxManager：kill-session 不存在时不算失败", async () => {
  const runCmd = createFakeRunCmd({ "kill-session": { code: 1 } })
  const tmux = new TmuxManager({ runCmd })
  assert.equal(await tmux.killSession("board_x"), false)

  const runCmd2 = createFakeRunCmd({ "kill-session": { code: 0 } })
  const tmux2 = new TmuxManager({ runCmd: runCmd2 })
  assert.equal(await tmux2.killSession("board_x"), true)
})

test("TmuxManager：attach 走注入的 pty 启动器", async () => {
  const calls = []
  const pty = { marker: true }
  const spawnPty = async (file, args, options) => {
    calls.push({ file, args, options })
    return pty
  }
  const tmux = new TmuxManager({ runCmd: createFakeRunCmd(), spawnPty })
  const result = await tmux.attach({ name: "board_x", cwd: "/tmp", cols: 80, rows: 24 })
  assert.equal(result, pty)
  assert.deepEqual(calls[0].args, ["attach-session", "-t", "board_x"])
  assert.equal(calls[0].options.cols, 80)
})

test("TmuxManager：available 依据 tmux -V 判定", async () => {
  const ok = new TmuxManager({ runCmd: createFakeRunCmd({ "-V": { code: 0, stdout: "tmux 3.7c" } }) })
  assert.equal(await ok.available(), true)
  const missing = new TmuxManager({ runCmd: createFakeRunCmd({ "-V": { code: 127 } }) })
  assert.equal(await missing.available(), false)
})

test("TmuxManager：探测成功永久缓存，不再重复执行 tmux -V", async () => {
  const runCmd = createFakeRunCmd({ "-V": { code: 0 } })
  const tmux = new TmuxManager({ runCmd })
  assert.equal(await tmux.available(), true)
  assert.equal(await tmux.available(), true)
  assert.equal(runCmd.findCalls("-V").length, 1)
})

test("TmuxManager：探测失败只在短 TTL 内缓存，装上 tmux 后自动恢复", async () => {
  let installed = false
  const clock = createFakeClock()
  const runCmd = createFakeRunCmd({ "-V": () => ({ code: installed ? 0 : 127 }) })
  const tmux = new TmuxManager({ runCmd, clock })

  assert.equal(await tmux.available(), false)
  // TTL 内不重复探测
  assert.equal(await tmux.available(), false)
  assert.equal(runCmd.findCalls("-V").length, 1)

  // 装上 tmux 后，超过 TTL 再探测即可恢复（无需重启 sidecar）
  installed = true
  clock.advance(TMUX_PROBE_FAILURE_TTL_MS + 1)
  assert.equal(await tmux.available(), true)
})
