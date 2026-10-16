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

  test("buildDispatchPrompt 放开工作流、锁定任务并保留停止约定", async () => {
    const { buildDispatchPrompt } = await import("../src/dispatcher")
    const text = buildDispatchPrompt({ id: "task_abc123", title: "重构登录模块" })
    expect(text).toContain("自动派发")
    expect(text).toContain("taskboard_claim")
    expect(text).toContain("taskboard_analyze")
    expect(text).toContain("taskboard_complete")
    expect(text).toContain("立即停止")
    // 预分配任务：并发下 worker 不自己去抢，避免多 worker 抢同一批任务
    expect(text).toContain("task_abc123")
    expect(text).toContain("重构登录模块")
    // 放开工作流：压制性措辞必须消失
    expect(text).not.toContain("不要加载或执行任何 skill")
    expect(text).not.toContain("skill")
    expect(text).not.toContain("worktree")
    expect(text).not.toContain("不要创建计划文件")
    expect(text).not.toContain("直接行动")
    // 新引导语：如实评估复杂度后自行选择工作流
    expect(text).toContain("如实评估")
    expect(text).toContain("复杂")
    expect(text).toContain("按任务本身的需要")
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
