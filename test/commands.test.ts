import { describe, expect, test } from "bun:test"
import { buildBoardText, buildClaimPrompt } from "../src/commands"

describe("命令文本", () => {
  test("buildBoardText 含 URL 与查看提示", () => {
    const text = buildBoardText("http://127.0.0.1:4370/")
    expect(text).toContain("http://127.0.0.1:4370/")
    expect(text).toContain("看板")
  })

  test("buildClaimPrompt 含完整工作流关键词", () => {
    const text = buildClaimPrompt()
    for (const kw of ["领取", "分析", "执行", "完成确认", "代码工具目录"]) {
      expect(text).toContain(kw)
    }
    expect(text).toContain("taskboard_claim")
    expect(text).toContain("taskboard_analyze")
    expect(text).toContain("taskboard_complete")
  })

  test("buildDispatchPrompt 限定一次一个并复用闭环骨架", async () => {
    const { buildDispatchPrompt } = await import("../src/dispatcher")
    const text = buildDispatchPrompt()
    expect(text).toContain("自动派发")
    expect(text).toContain("只领取并处理一个任务")
    expect(text).toContain("不要继续领取下一个")
    expect(text).toContain("taskboard_claim") // 复用 buildClaimPrompt 骨架
  })

  test("registerCommands 的 /taskboard 输出追加 dispatcherText", async () => {
    const { registerCommands } = await import("../src/commands")
    const added: { name: string; execute: (i: { sessionID: string }) => Promise<void> }[] = []
    const syntheticTexts: string[] = []
    await registerCommands(
      {
        command: {
          transform: async (cb) => {
            cb({
              add: (cmd) => added.push(cmd as never),
            })
            return { dispose: async () => {} }
          },
        },
        session: {
          prompt: async () => ({}),
          synthetic: async (i: { text: string }) => {
            syntheticTexts.push(i.text)
          },
        },
      } as never,
      {} as never,
      { port: 4370, dispatcherText: () => "🤖 自动领取：关" },
    )
    const cmd = added.find((c) => c.name === "taskboard")
    expect(cmd).toBeDefined()
    await cmd!.execute({ sessionID: "ses_x" })
    expect(syntheticTexts[0]).toContain("看板")
    expect(syntheticTexts[0]).toContain("🤖 自动领取：关")
  })
})
