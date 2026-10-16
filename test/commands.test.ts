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
})
