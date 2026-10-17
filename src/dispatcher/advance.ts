/**
 * 推进规则表:沿驱动的唤醒动作,取代旧「confirmSeen/nudgedTaskIDs 一次性 nudge」。
 *
 * 旧语义的缺陷(规格诊断 #3/#4):「一任务一次」在打回重做第二轮放行后不再唤醒
 * (任务卡死);人工拖回 analyzing 完全没有推进器(同会话停滞)。
 * 新语义:每条转移沿独立消费(seq 幂等),任何次数的放行/拖回都正确唤醒。
 */

import type { Task } from "../types"
import type { AdvanceRule, DispatcherSession, TaskTransition } from "./types"
import { buildExecuteNudgePrompt, buildReanalyzePrompt } from "./prompt"

/** 内置规则的静态描述(session 由 makeBuiltinRules 绑定) */
export interface AdvanceRuleSpec {
  name: string
  label: string
  on: { from?: TaskTransition["from"] | "*"; to: TaskTransition["to"] }
}

/** 内置规则注册表:未来「轮次上限熔断」「卡死自愈」等只加 spec + 构建分支 */
export const BUILTIN_RULES: AdvanceRuleSpec[] = [
  // from 收窄为 analysis_confirm:沿区分不了「用户放行」与「confirm-off 下 analyze 直落」,
  // from:"*" 会在默认配置(requireAnalysisConfirm:false)下每任务误发一枪唤醒(审查 I-1)。
  // 「多次跳转」场景(analyzing↔analysis_confirm 往复后再放行)每次都经过 analysis_confirm,
  // 收窄不影响多轮唤醒的正确性。
  { name: "execute-nudge", label: "执行唤醒", on: { from: "analysis_confirm", to: "executing" } },
  {
    name: "reanalyze-nudge",
    label: "重析唤醒",
    on: { from: "analysis_confirm", to: "analyzing" },
  },
]

/** 任务最近一条用户评论(打回/确认必附评论是 store 硬约束,数据源可靠) */
export function latestUserComment(task: Task): string | null {
  for (let i = task.comments.length - 1; i >= 0; i--) {
    const c = task.comments[i]
    if (c.author === "user") return c.text
  }
  return null
}

export function makeBuiltinRules(deps: {
  session: DispatcherSession
  log: (m: string) => void
}): AdvanceRule[] {
  return BUILTIN_RULES.map((spec): AdvanceRule => ({
    name: spec.name,
    on: spec.on,
    act: async (task, log) => {
      const sessionID = task.claim?.sessionID
      if (!sessionID) {
        log(`${spec.label}跳过:任务无会话(human claim)task=${task.id}`)
        return
      }
      const text =
        spec.name === "reanalyze-nudge"
          ? buildReanalyzePrompt({ title: task.title }, latestUserComment(task))
          : buildExecuteNudgePrompt({ title: task.title })
      await deps.session.prompt({ sessionID, text })
      log(`${spec.label} → session=${sessionID.slice(0, 8)} task=${task.id}`)
    },
  }))
}

/**
 * 消费一条转移沿:命中规则的 on → 幂等检查 → act → 成功才推进水位。
 * 返回消费结果供引擎决定是否入重试队列:
 * - "acted":命中且 act 成功(水位已推进)
 * - "skipped":已处理过(shouldAct 为 false)或无会话等免唤醒场景
 * - "no-match":无规则命中(沿静默忽略)
 * - "failed":act 抛错 —— 水位未推进,**调用方必须保留该沿待重发**,
 *   否则瞬断一次 worker 就永久停在等唤醒(审查 I-3)。
 */
export async function runAdvance(
  rules: AdvanceRule[],
  t: TaskTransition,
  task: Task,
  ctx: { shouldAct(t: TaskTransition): boolean; markActed(t: TaskTransition): void; log(m: string): void },
): Promise<"acted" | "skipped" | "no-match" | "failed"> {
  for (const rule of rules) {
    if (rule.on.to !== t.to) continue
    if (rule.on.from !== undefined && rule.on.from !== "*" && rule.on.from !== t.from) continue
    if (!ctx.shouldAct(t)) return "skipped"
    const label = BUILTIN_RULES.find((s) => s.name === rule.name)?.label ?? rule.name
    try {
      await rule.act(task, ctx.log)
      ctx.markActed(t)
      return "acted"
    } catch (e) {
      ctx.log(`${label}失败:${e instanceof Error ? e.message : String(e)}`)
      return "failed"
    }
  }
  return "no-match" // 一条沿至多命中一条规则(规则表按 to 互斥)
}
