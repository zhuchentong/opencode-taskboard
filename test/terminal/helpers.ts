// 终端桥单测的假实现：假 pty、假时钟、假外部命令执行器、假 socket。
//
// 硬纪律（与 sidecar 同款）：**绝不真的启动 opencode**——
// 单测里的 tmux/opencode 全是假命令，跑一遍不会碰到 daemon，也不会留下 tmux 会话。

import type { PtyLike } from "../../src/terminal"
import type { RunResult } from "../../src/terminal/tmux"

/** 假 pty：接口对齐桥接层的 PtyLike（write / onData / onExit / kill） */
export function createFakePty() {
  const dataCbs: Array<(data: Uint8Array) => void> = []
  const exitCbs: Array<(code: number) => void> = []
  const pty = {
    written: [] as Array<Uint8Array | string>,
    killed: false,
    dataCbs,
    exitCbs,
    write(data: Uint8Array | string) {
      pty.written.push(data)
    },
    onData(cb: (data: Uint8Array) => void) {
      dataCbs.push(cb)
    },
    onExit(cb: (code: number) => void) {
      exitCbs.push(cb)
    },
    kill() {
      pty.killed = true
    },
    /** 模拟终端输出 */
    push(data: Uint8Array | string) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
      for (const cb of dataCbs) cb(bytes)
    },
    /** 模拟 TUI 退出 */
    exit(code = 0) {
      for (const cb of exitCbs) cb(code)
    },
  }
  return pty
}

/** 假 pty 的类型断言（结构兼容 PtyLike） */
export const fakePtyAs = (pty: ReturnType<typeof createFakePty>): PtyLike => pty

/** 假时钟：可手动推进；setInterval 也可推进（心跳用） */
export function createFakeClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map<number, { fn: () => void; at: number; every?: number }>()
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number)
    },
    setInterval(fn: () => void, ms: number) {
      const id = ++seq
      timers.set(id, { fn, at: now + ms, every: ms })
      return id
    },
    clearInterval(id: unknown) {
      timers.delete(id as number)
    },
    /** 推进时间并触发到期的定时器 */
    advance(ms: number) {
      now += ms
      for (let guard = 0; guard < 10_000; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= now)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          if (timer.every !== undefined) {
            timer.at = now + timer.every
          } else {
            timers.delete(id)
          }
          timer.fn()
        }
      }
    },
    pending: () => timers.size,
  }
}

/** 假外部命令执行器（tmux/stty）；按子命令定制返回 */
export function createFakeRunCmd(responses: Record<string, RunResult | ((args: string[]) => RunResult)> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    calls.push({ file, args: [...args] })
    const key = args[0]
    const response = responses[key]
    if (typeof response === "function") return { code: 0, stdout: "", stderr: "", ...response(args) }
    if (response && typeof response === "object") return { code: 0, stdout: "", stderr: "", ...response }
    return { code: 0, stdout: "", stderr: "" }
  }
  run.calls = calls
  run.findCalls = (key: string) => calls.filter((c) => c.args[0] === key)
  return run
}

/** 假 socket：记录发出去的数据与关闭动作 */
export function createFakeSocket() {
  const socket = {
    sent: [] as Array<{ data: string | Uint8Array; binary: boolean }>,
    closed: [] as Array<{ code?: number; reason?: string }>,
    send(data: string | Uint8Array) {
      socket.sent.push({ data, binary: typeof data !== "string" })
    },
    close(code?: number, reason?: string) {
      socket.closed.push({ code, reason })
    },
    /** 文本帧内容（JSON 解析后） */
    controls(): Array<Record<string, unknown>> {
      return socket.sent
        .filter((s) => !s.binary)
        .map((s) => JSON.parse(String(s.data)) as Record<string, unknown>)
    },
  }
  return socket
}

/** 轮询等待某个条件成立 */
export async function waitFor(predicate: () => boolean, { timeoutMs = 2000, intervalMs = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}
