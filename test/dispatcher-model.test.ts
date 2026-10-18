// 模型引用解析与阶段模型选择(分析/执行分模型设置的核心纯函数)
import { describe, expect, test } from "bun:test"
import { parseModelRef, resolvePhaseModel } from "../src/dispatcher/model"

describe("parseModelRef", () => {
  test("provider/model 形态解析为 create 用的 { providerID, id }", () => {
    expect(parseModelRef("zhipuai-coding-plan/glm-5.3-flash")).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3-flash",
    })
  })

  test("空串/undefined/null → null(跟随 opencode 默认)", () => {
    expect(parseModelRef("")).toBeNull()
    expect(parseModelRef(undefined)).toBeNull()
    expect(parseModelRef(null)).toBeNull()
  })

  test("缺斜杠/多段/空白段 → null(不猜测)", () => {
    expect(parseModelRef("just-a-model")).toBeNull()
    expect(parseModelRef("a/b/c")).toBeNull()
    expect(parseModelRef("/model")).toBeNull()
    expect(parseModelRef("provider/")).toBeNull()
  })
})

describe("resolvePhaseModel", () => {
  const fallback = { providerID: "env-provider", id: "env-model" }

  test("网页设置优先:settings 非空时覆盖 env/config 兜底", () => {
    expect(
      resolvePhaseModel("analyze", { modelAnalyze: "web/model-a" }, fallback),
    ).toEqual({ providerID: "web", id: "model-a" })
  })

  test("settings 空串=显式跟随默认:压过 env 兜底,返回 null", () => {
    // 用户在网页选了「跟随默认」即表达「不要用 env 的模型」
    expect(resolvePhaseModel("analyze", { modelAnalyze: "" }, fallback)).toBeNull()
  })

  test("settings 未设置(undefined)时回退 env/config 兜底", () => {
    expect(resolvePhaseModel("analyze", {}, fallback)).toEqual(fallback)
    expect(resolvePhaseModel("analyze", { modelAnalyze: undefined }, fallback)).toEqual(fallback)
  })

  test("两阶段各自取各自的字段,互不串扰", () => {
    const s = { modelAnalyze: "a/one", modelExecute: "b/two" }
    expect(resolvePhaseModel("analyze", s, null)).toEqual({ providerID: "a", id: "one" })
    expect(resolvePhaseModel("execute", s, null)).toEqual({ providerID: "b", id: "two" })
  })

  test("全链路无配置 → null(opencode 默认解析)", () => {
    expect(resolvePhaseModel("execute", {}, null)).toBeNull()
  })

  test("settings 非法格式(缺斜杠)视为未设置,回退兜底", () => {
    expect(resolvePhaseModel("analyze", { modelAnalyze: "broken" }, fallback)).toEqual(fallback)
  })
})
