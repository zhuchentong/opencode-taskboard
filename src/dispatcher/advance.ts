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
  { name: "execute-nudge", label: "执行唤醒", on: { from: "*", to: "executing" } },
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
 * act 失败记日志、不推进 —— 同沿下轮评估自动重发。
 */
export async function runAdvance(
  rules: AdvanceRule[],
  t: TaskTransition,
  task: Task,
  ctx: { shouldAct(t: TaskTransition): boolean; markActed(t: TaskTransition): void; log(m: string): void },
): Promise<void> {
  for (const rule of rules) {
    if (rule.on.to !== t.to) continue
    if (rule.on.from !== undefined && rule.on.from !== "*" && rule.on.from !== t.from) continue
    if (!ctx.shouldAct(t)) continue
    const label = BUILTIN_RULES.find((s) => s.name === rule.name)?.label ?? rule.name
    try {
      await rule.act(task, ctx.log)
      ctx.markActed(t)
    } catch (e) {
      ctx.log(`${label}失败:${e instanceof Error ? e.message : String(e)}`)
    }
    return // 一条沿至多命中一条规则(规则表按 to 互斥)
  }
}
