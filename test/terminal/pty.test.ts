import { describe, expect, test } from "bun:test"
import { assertShellSafe, defaultSpawnPty } from "../../src/terminal/pty"

describe("PTY 启动器（script 包装）", () => {
  test("assertShellSafe:含 shell 敏感字符的参数一律拒绝", () => {
    expect(() => assertShellSafe(["tmux", "attach-session", "-t", "board-ses_1"])).not.toThrow()
    expect(() => assertShellSafe(["sh", "-c", "rm -rf /"])).toThrow(/shell 敏感字符/)
    expect(() => assertShellSafe(["x;y"])).toThrow()
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
})
