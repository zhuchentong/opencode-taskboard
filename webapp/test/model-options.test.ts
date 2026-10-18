import { describe, expect, test } from "bun:test"
import { groupModels, MODEL_PLACEHOLDER } from "../src/lib/model-options"

describe("模型下拉选项分组", () => {
  test("按 provider 分组,保持首现顺序,组内保持原顺序", () => {
    const groups = groupModels([
      "zhipuai-coding-plan/glm-5.3-flash",
      "minimax-cn-coding-plan/MiniMax-M3.1",
      "zhipuai-coding-plan/glm-4.7",
    ])
    expect(groups).toEqual([
      { provider: "zhipuai-coding-plan", models: ["glm-5.3-flash", "glm-4.7"] },
      { provider: "minimax-cn-coding-plan", models: ["MiniMax-M3.1"] },
    ])
  })

  test("空列表 → 空分组(组件据此显示提示文案)", () => {
    expect(groupModels([])).toEqual([])
  })

  test("非法行(缺斜杠)被跳过,不产生垃圾选项", () => {
    expect(groupModels(["broken", "a/b", ""])).toEqual([{ provider: "a", models: ["b"] }])
  })
})

describe("MODEL_PLACEHOLDER", () => {
  test("空选项文案存在(「跟随 opencode 默认」)", () => {
    expect(MODEL_PLACEHOLDER).toContain("默认")
  })
})
