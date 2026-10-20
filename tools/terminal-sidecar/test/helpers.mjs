/**
 * 单测公用假实现：假 pty、假时钟、假外部命令执行器。
 * 全部**不会**真的启动 opencode（红线：单测也不许 exec opencode CLI）。
 */

import { EventEmitter } from "node:events"

/** 假 pty：接口对齐 node-pty 的 onData / onExit / write / resize / kill */
export function createFakePty() {
  const pty = new EventEmitter()
  pty.written = []
  pty.resized = []
  pty.killed = false
  pty.write = (data) => {
    pty.written.push(data)
  }
  pty.resize = (cols, rows) => {
    pty.resized.push([cols, rows])
  }
  pty.kill = () => {
    pty.killed = true
  }
  pty.onData = (cb) => pty.on("data", cb)
  pty.onExit = (cb) => pty.on("exit", cb)
  /** 模拟终端输出 */
  pty.push = (data) => pty.emit("data", typeof data === "string" ? data : Buffer.from(data))
  /** 模拟 TUI 退出 */
  pty.exit = (code = 0) => pty.emit("exit", { exitCode: code, signal: 0 })
  return pty
}

/** 假时钟：可手动推进 */
export function createFakeClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    /** 推进时间并触发到期的定时器 */
    advance(ms) {
      now += ms
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    },
    pending: () => timers.size,
  }
}

/**
 * 假外部命令执行器（tmux 命令）。
 * @param {Record<string, object|Function>} responses 按子命令（has-session / list-panes / …）定制返回
 */
export function createFakeRunCmd(responses = {}) {
  const calls = []
  const run = async (file, args) => {
    calls.push({ file, args: [...args] })
    const key = args[0]
    const response = responses[key]
    if (typeof response === "function") {
      return { code: 0, stdout: "", stderr: "", error: null, ...(await response(args)) }
    }
    if (response && typeof response === "object") {
      return { code: 0, stdout: "", stderr: "", error: null, ...response }
    }
    return { code: 0, stdout: "", stderr: "", error: null }
  }
  run.calls = calls
  run.findCalls = (key) => calls.filter((call) => call.args[0] === key)
  return run
}

/** 轮询等待某个条件成立 */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
