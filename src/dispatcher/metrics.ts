/**
 * 沿流订阅者:消耗统计(第二个订阅者,第一个是推进规则/日志)。
 * 迁移并收编旧 dispatcher 的 flushUsage/pollUsage/recordUsage;
 * token 刷新只走现有 Store.recordUsage —— 一期零新 Store 方法(规格 §3.3)。
 */

import type { SessionTokens, DispatcherSession, TaskTransition } from "./types"
import type { Store } from "../store"
import type { Task } from "../types"

/**
 * 从会话信息里抽 token 读数;结构不认得时返回 null(宁可没有统计,也不要写入假数据)。
 */
export function readTokens(info: unknown): SessionTokens | null {
  const t = (info as { tokens?: unknown } | null)?.tokens
  if (!t || typeof t !== "object") return null
  const cache = (t as { cache?: unknown }).cache
  return {
    input: Number((t as { input?: unknown }).input) || 0,
    output: Number((t as { output?: unknown }).output) || 0,
    reasoning: Number((t as { reasoning?: unknown }).reasoning) || 0,
    cache: {
      read: Number((cache as { read?: unknown } | undefined)?.read) || 0,
      write: Number((cache as { write?: unknown } | undefined)?.write) || 0,
    },
  }
}

export interface MetricsDeps {
  store: Store
  session: DispatcherSession
  /** 把 store 层写入广播到前端 SSE(不经 HTTP 路由的写入推不到看板) */
  broadcast?: () => Promise<void> | void
  /** 活跃任务消耗刷新间隔;0 关闭轮询 */
  usagePollMs: number
  log: (m: string) => void
}

export function createMetrics(deps: MetricsDeps) {
  let pollTimer: ReturnType<typeof setInterval> | null = null

  /** 记录一条消耗统计并广播:会话累计读数 → store.recordUsage(现有方法) */
  const recordUsage = async (taskID: string, sessionID: string): Promise<void> => {
    const info = await deps.session.get({ sessionID })
    const tk = readTokens(info)
    if (!tk) return
    await deps.store.recordUsage({
      id: taskID,
      usage: {
        input: tk.input ?? 0,
        output: tk.output ?? 0,
        reasoning: tk.reasoning ?? 0,
        cacheRead: tk.cache?.read ?? 0,
        cacheWrite: tk.cache?.write ?? 0,
        at: Date.now(),
      },
    })
    await deps.broadcast?.()
  }

  return {
    /** 沿边界刷新:任何转移沿(有会话才刷)到达时把会话累计读数写回任务 */
    async applyTransition(t: TaskTransition, task: Task): Promise<void> {
      const sessionID = task.claim?.sessionID
      if (!sessionID) return
      try {
        await recordUsage(task.id, sessionID)
      } catch (e) {
        deps.log(`沿边界消耗刷新失败 task=${task.id}:${e instanceof Error ? e.message : String(e)}`)
      }
    },

    /**
     * 任务终结(completion_confirm/done)补一次消耗:此刻读数才是完整的,
     * 不必等下一个轮询周期。(旧 nudgedTaskIDs/confirmSeen 清理已随旧机制删除)
     */
    async flushTerminal(tasks: Task[]): Promise<void> {
      for (const t of tasks) {
        if (t.status !== "completion_confirm" && t.status !== "done") continue
        const sessionID = t.claim?.sessionID
        if (!sessionID) continue
        try {
          await recordUsage(t.id, sessionID)
        } catch (e) {
          deps.log(`消耗统计失败 task=${t.id}:${e instanceof Error ? e.message : String(e)}`)
        }
      }
    },

    /** 定时刷新活跃任务(analyzing/executing)的消耗,让长任务执行中也看得到 token 在涨 */
    startPoll(): void {
      if (deps.usagePollMs <= 0 || pollTimer) return
      pollTimer = setInterval(() => {
        void (async () => {
          let tasks: Task[]
          try {
            tasks = await deps.store.list()
          } catch {
            return // 读失败下轮重试
          }
          for (const t of tasks) {
            if (t.status !== "analyzing" && t.status !== "executing") continue
            const sessionID = t.claim?.sessionID
            if (!sessionID) continue // 人工拖入执行的任务没有会话,无从统计
            try {
              await recordUsage(t.id, sessionID)
            } catch (e) {
              deps.log(`消耗刷新失败 task=${t.id}:${e instanceof Error ? e.message : String(e)}`)
            }
          }
        })()
      }, deps.usagePollMs)
    },

    dispose(): void {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    },
  }
}
