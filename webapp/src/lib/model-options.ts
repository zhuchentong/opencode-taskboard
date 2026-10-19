// 阶段模型下拉的选项纯函数:服务端 /api/models 返回 "provider/model" 行,按 provider 分组渲染 optgroup
export interface ModelGroup {
  provider: string
  models: string[]
}

/** 模型门禁:分析/执行模型都显式配置(非空字符串)才算已配置;空串/undefined 一律未配置 */
export function modelsConfigured(settings: { modelAnalyze?: string; modelExecute?: string }): boolean {
  return Boolean(settings.modelAnalyze) && Boolean(settings.modelExecute)
}

/** "provider/model" 行分组;非法行(缺斜杠/空)跳过 */
export function groupModels(models: string[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const byProvider = new Map<string, string[]>()
  for (const spec of models) {
    const i = spec.indexOf("/")
    if (i <= 0 || i === spec.length - 1) continue
    const provider = spec.slice(0, i)
    const model = spec.slice(i + 1)
    let list = byProvider.get(provider)
    if (!list) {
      list = []
      byProvider.set(provider, list)
      groups.push({ provider, models: list })
    }
    list.push(model)
  }
  return groups
}
