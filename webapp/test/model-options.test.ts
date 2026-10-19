import { describe, expect, test } from "bun:test"
import { groupModels, modelsConfigured } from "../src/lib/model-options"

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

describe("modelsConfigured(模型门禁判定)", () => {
  test("两模型都是非空字符串 → 已配置", () => {
    expect(modelsConfigured({ modelAnalyze: "a/one", modelExecute: "b/two" })).toBe(true)
  })

  test("任一模型为 undefined 或空串 → 未配置", () => {
    expect(modelsConfigured({ modelAnalyze: "a/one", modelExecute: undefined })).toBe(false)
    expect(modelsConfigured({ modelAnalyze: undefined, modelExecute: "b/two" })).toBe(false)
    expect(modelsConfigured({ modelAnalyze: "a/one", modelExecute: "" })).toBe(false)
    expect(modelsConfigured({ modelAnalyze: "", modelExecute: "b/two" })).toBe(false)
    expect(modelsConfigured({})).toBe(false)
  })

  test("旧数据兼容:全空对象(仅含其他字段)→ 未配置", () => {
    expect(modelsConfigured({ modelAnalyze: undefined, modelExecute: undefined })).toBe(false)
  })
})
