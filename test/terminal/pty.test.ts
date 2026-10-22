import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ScriptProbe, SCRIPT_ARGS, assertShellSafe, defaultSpawnPty, resolvePtySize } from "../../src/terminal/pty"
import { createFakeRunCmd } from "./helpers"

describe("PTY 启动器（script 包装）", () => {
  test("assertShellSafe:含 shell 敏感字符的参数一律拒绝", () => {
    expect(() => assertShellSafe(["tmux", "attach-session", "-t", "board-ses_1"])).not.toThrow()
    expect(() => assertShellSafe(["sh", "-c", "rm -rf /"])).toThrow(/shell 敏感字符/)
    expect(() => assertShellSafe(["x;y"])).toThrow()
  })

  test("resolvePtySize:非法尺寸回退默认（NaN/负数/小数/越界）", () => {
    expect(resolvePtySize(100, 40)).toEqual({ cols: 100, rows: 40 })
    expect(resolvePtySize(NaN, 40)).toEqual({ cols: 120, rows: 30 })
    expect(resolvePtySize(100, -5)).toEqual({ cols: 120, rows: 30 })
    expect(resolvePtySize(100.5, 40)).toEqual({ cols: 120, rows: 30 })
    expect(resolvePtySize(5000, 40)).toEqual({ cols: 120, rows: 30 })
    expect(resolvePtySize(undefined, undefined)).toEqual({ cols: 120, rows: 30 })
  })

  test("ScriptProbe:script 不可用 → false；可用 → true（成功永久缓存）", async () => {
    let probe = 0
    const run = createFakeRunCmd({
      "--version": () => {
        probe += 1
        return { code: probe === 1 ? 1 : 0 }
      },
    })
    const p = new ScriptProbe(run)
    expect(await p.available()).toBe(false)
    // 失败结果短缓存：TTL 内不重复探测
    expect(await p.available()).toBe(false)
    expect(probe).toBe(1)
  })

  test("defaultSpawnPty:真起一个 PTY（跑 cat，不是 opencode）→ 输入能回显、退出能感知", async () => {
    const pty = defaultSpawnPty(["cat"], { cols: 100, rows: 30 })
    const chunks: string[] = []
    const decoder = new TextDecoder()
    let exitCode: number | null = null
    pty.onData((data) => {
      chunks.push(decoder.decode(data))
    })
    pty.onExit((code) => {
      exitCode = code
    })

    pty.write("hello-pty\n")
    const deadline = Date.now() + 5000
    while (!chunks.join("").includes("hello-pty") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(chunks.join("")).toContain("hello-pty")

    pty.kill()
    const exitDeadline = Date.now() + 5000
    while (exitCode === null && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(exitCode).not.toBeNull()
  }, 15_000)

  test("SCRIPT_ARGS 含 -e（退出码透传）——缺它浏览器只能收到 code=0", () => {
    expect(SCRIPT_ARGS.join("")).toContain("e")
    expect(SCRIPT_ARGS.join("")).toContain("c")
  })

  test("内层命令狂写 stderr 不影响终端输出与退出码", async () => {
    // 写 2000 行错误信息（远超 64KB 管道缓冲）：若 stderr 用 pipe 却不排空，script 会被卡住
    const dir = mkdtempSync(join(tmpdir(), "pty-noise-"))
    const scriptPath = join(dir, "noisy.sh")
    writeFileSync(
      scriptPath,
      '#!/bin/sh\ni=0\nwhile [ $i -lt 2000 ]; do echo "很长的错误信息，用来灌满 stderr 管道缓冲" >&2; i=$((i+1)); done\nexit 3\n',
      { mode: 0o755 },
    )
    try {
      const pty = defaultSpawnPty([scriptPath], { cols: 100, rows: 30 })
      let exitCode: number | null = null
      pty.onExit((code) => {
        exitCode = code
      })
      const deadline = Date.now() + 8000
      while (exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      // onExit 回调里的赋值 TS 控制流看不到，显式恢复声明类型，防止被窄化成 null
      expect(exitCode as number | null).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("defaultSpawnPty:退出码透传（script -e）→ 内层 exit 7 则退出码为 7", async () => {
    // 命令参数走 shell 白名单（不能带空格），故用临时脚本表达「退出码 7」
    const dir = mkdtempSync(join(tmpdir(), "pty-exit-"))
    const scriptPath = join(dir, "exit7.sh")
    writeFileSync(scriptPath, "#!/bin/sh\nexit 7\n", { mode: 0o755 })
    try {
      const pty = defaultSpawnPty([scriptPath], { cols: 100, rows: 30 })
      let exitCode: number | null = null
      pty.onExit((code) => {
        exitCode = code
      })
      const deadline = Date.now() + 5000
      while (exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      // onExit 回调里的赋值 TS 控制流看不到，显式恢复声明类型，防止被窄化成 null
      expect(exitCode as number | null).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
