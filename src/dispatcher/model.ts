/**
 * 模型引用解析与阶段模型选择(纯函数,无 IO)。
 *
 * 两级来源(高→低):看板网页设置(BoardSettings.modelAnalyze/modelExecute)
 * > 运维兜底(TASKBOARD_MODEL env / opencode.json,启动时解析传入)。
 *
 * 网页设置仅在「非空且格式合法」时生效;空串/未设置/非法格式一律视为未配置,
 * 回退运维兜底。返回 null 表示全链路无可用模型——由派发引擎解释为「不可派发」,
 * 绝不回退 opencode 默认解析(无显式模型的 worker 会话有创建即挂起风险)。
 */

/** session.create 形态(SDK Model.Ref:key 是 id) */
export interface CreateModelRef {
  providerID: string
  id: string
}

/** "provider/model" → CreateModelRef;格式不合法/空 → null(不猜测) */
export function parseModelRef(spec: string | null | undefined): CreateModelRef | null {
  if (!spec) return null
  const i = spec.indexOf("/")
  if (i <= 0 || i === spec.length - 1 || spec.indexOf("/", i + 1) !== -1) return null
  return { providerID: spec.slice(0, i), id: spec.slice(i + 1) }
}

export type PhaseModelSettings = {
  modelAnalyze?: string
  modelExecute?: string
}

/**
 * 按阶段解析生效模型:网页设置(非空且格式合法)> fallback(运维兜底)> null。
 * 空串视为未配置,与其他未设置情形一样回退 fallback。
 */
export function resolvePhaseModel(
  phase: "analyze" | "execute",
  settings: PhaseModelSettings,
  fallback: CreateModelRef | null,
): CreateModelRef | null {
  const spec = phase === "analyze" ? settings.modelAnalyze : settings.modelExecute
  if (spec) {
    const ref = parseModelRef(spec)
    if (ref) return ref
    // 非法格式视为未设置,继续走 fallback
  }
  return fallback
}
