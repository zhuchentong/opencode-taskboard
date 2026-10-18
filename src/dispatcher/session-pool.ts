/**
 * 会话池:一任务一会话的建/收/超时回收与在途跟踪。
 *
 * 分层(见账本 Task 4 裁决):pool 只管时序与回收;退避状态(任务级 streak/冷却、
 * 全局派发异常、建会话失败退避)全部归 engine,经回调注入 —— 满足 blob 持久化约束。
 *
 * 在途表按 **taskID** 索引(旧实现按 sessionID,人工拖拽的 human claim
 * `sessionID: ""` 永不匹配,在途条目只能干等超时、被误判「worker 抢先领取」
 * 保留会话泄漏烧 token —— 按 taskID 结算根治,见 sweep/settleByTask)。
 */

import type { Task } from "../types"
import type { DispatcherSession } from "./types"

export interface SessionPoolDeps {
  session: DispatcherSession
  /** worker 会话的工作目录:必须显式传,否则回退到服务进程 cwd(实测曾落到 .debug/playground) */
  directory: string
  /** 派发后等待 worker 领取的时限 */
  claimWaitMs: number
  /** 注入 store.patch:超时撤任务(先撤任务再回收会话,顺序不能反) */
  patchTask(id: string, patch: { status: "pending" }): Promise<void>
  /** 任务已被任何人领取/流转离开 pending(含 human claim):结算名额 */
  onSettled(taskID: string, entry: { sessionID: string; sentAt: number }): void
  /** 超时已退回待领取:engine 记任务级 streak 与冷却 */
  onTimeout(taskID: string): void
  /** 建会话失败:engine 记独立低上限退避(不置全局 paused) */
  onCreateFail(): void
  /** 任务消失(被删除):engine 清理沿状态键,防键空间泄漏 */
  onTaskGone(taskID: string): void
  log(m: string): void
}

interface AwaitingEntry {
  sessionID: string
  sentAt: number
  timer: ReturnType<typeof setTimeout>
}

export type DispatchOutcome = "ok" | "create-fail" | "prompt-fail"

export function createSessionPool(deps: SessionPoolDeps) {
  /** 在途派发:taskID → 条目。一任务一会话,任务终结后不复用。 */
  const awaiting = new Map<string, AwaitingEntry>()
  let disposed = false

  /** 统一清理入口(clearTimeout + delete),幂等 —— 三处清理沿/超时/结算全走这里 */
  const releaseEntry = (taskID: string, why: string): void => {
    const entry = awaiting.get(taskID)
    if (!entry) return
    clearTimeout(entry.timer)
    awaiting.delete(taskID)
    deps.log(`释放名额 task=${taskID}（${why}）`)
  }

  /** 回收会话:派发失败、超时、任务已删除等不再需要它的场景。删会话是破坏性操作,容错静默。 */
  const dropSession = async (sessionID: string, why: string): Promise<void> => {
    if (!deps.session.remove) return
    try {
      await deps.session.remove({ sessionID })
      deps.log(`回收会话 ${sessionID.slice(0, 8)}(${why})`)
    } catch {
      // 会话可能已被清理,忽略
    }
  }

  const settleByTask = (taskID: string): void => {
    const entry = awaiting.get(taskID)
    if (!entry) return
    deps.log(`已领取 task=${taskID}（派发→领取 ${Math.round((Date.now() - entry.sentAt) / 1000)}s）`)
    releaseEntry(taskID, "已领取/流转")
    deps.onSettled(taskID, { sessionID: entry.sessionID, sentAt: entry.sentAt })
  }

  /**
   * 超时回收(未领取):先撤任务再回收会话,顺序不能反 ——
   * 反了会留下「任务已被别人领走、会话却被删掉」的永久孤儿。
   */
  const releaseStalled = async (taskID: string, sessionID: string): Promise<void> => {
    try {
      try {
        await deps.patchTask(taskID, { status: "pending" })
        deps.onTimeout(taskID)
        deps.log(`派发超时未见领取，任务已退回待领取 task=${taskID}`)
        await dropSession(sessionID, "超时未领取")
        return
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === "invalid_transition") {
          // worker 抢先领取(状态已不是 pending):会话仍在用,不能动
          deps.log(`派发超时但任务已被领取,保留会话 ${sessionID.slice(0, 8)} task=${taskID}`)
          settleByTask(taskID)
          return
        }
        if (code === "not_found") {
          // 任务已被用户删除:不是 worker 的失败,只回收会话,不计连败不设冷却
          deps.log(`派发超时但任务已删除 task=${taskID},回收会话`)
          deps.onTaskGone(taskID)
          await dropSession(sessionID, "任务已删除")
          return
        }
        deps.log(`超时回收撤任务失败 task=${taskID}:${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      // 两分支都必须摘掉在途记录:漏删会让该任务永久被剔除候选 → 名额泄漏 + 永不重派
      releaseEntry(taskID, "超时流程收尾")
    }
  }

  return {
    /**
     * 派发:建会话 → 登记在途 → 发提示词(text 由 engine 经 prompt.ts 构建)。
     * model 为分析阶段模型(create key 是 id,SDK Model.Ref;首 prompt key 是 modelID),
     * 会话默认模型与首回合模型一致;缺省用 opencode 默认解析。
     * 返回结果供 engine 记对应连败口径。
     */
    async dispatch(task: Task, workerName: string, text: string, model?: { providerID: string; id: string }): Promise<DispatchOutcome> {
      if (disposed) {
        deps.log(`派发器已卸载,跳过派发 task=${task.id}`)
        return "create-fail"
      }
      let sessionID: string
      try {
        const info = await deps.session.create({
          title: `看板:${task.title}`,
          location: { directory: deps.directory },
          // 实验:显式指定 model——诊断发现无 model 的会话创建即被 opencode 挂起
          // (time_suspended=创建时刻,回合永不启动);正常会话有模型。
          ...(model ? { model } : {}),
        } as never)
        sessionID = info.id
      } catch (e) {
        // 建会话失败:任务没被派出去,不计名额也不熔断,等下一轮评估重试
        deps.log(`创建会话失败 task=${task.id}:${e instanceof Error ? e.message : String(e)}`)
        deps.onCreateFail()
        return "create-fail"
      }

      const entry: AwaitingEntry = {
        sessionID,
        sentAt: Date.now(),
        timer: setTimeout(() => {
          void releaseStalled(task.id, sessionID).catch((e) =>
            deps.log(`超时回收失败:${e instanceof Error ? e.message : String(e)}`),
          )
        }, deps.claimWaitMs),
      }
      awaiting.set(task.id, entry)

      try {
        const promptModel = model ? { providerID: model.providerID, modelID: model.id } : undefined
        await deps.session.prompt({ sessionID, text, ...(promptModel ? { model: promptModel } : {}) })
      } catch (e) {
        // 派发异常是会话 API 层面的故障:回收名额与会话,全局口径由 engine 记
        releaseEntry(task.id, "派发失败")
        await dropSession(sessionID, "派发失败")
        deps.log(`派发失败 task=${task.id}:${e instanceof Error ? e.message : String(e)}`)
        return "prompt-fail"
      }
      deps.log(`派发 → ${workerName}=${sessionID.slice(0, 8)} task=${task.id}「${task.title}」`)
      return "ok"
    },

    /** 沿驱动零延迟结算:任务领取/流转的沿到达时按 taskID 立即释放名额。幂等。 */
    settleByTask,

    /**
     * 收敛兜底(旧 runEvaluate 收敛循环的迁移):对任务快照核对在途条目。
     * 旧条件 `claim.sessionID === entry.sessionID` 永不命中 human claim(盲区),
     * 新条件按 taskID:任务已不在 pending 即结算 —— 根治拖拽盲区;
     * 任务消失则 onTaskGone 清沿状态键。
     */
    sweep(tasks: Task[]): void {
      let settledAny = false
      for (const entry of [...awaiting.keys()]) {
        const t = tasks.find((x) => x.id === entry)
        if (!t) {
          deps.onTaskGone(entry)
          releaseEntry(entry, "任务已删除(sweep)")
          continue
        }
        if (t.status !== "pending") {
          settleByTask(entry)
          settledAny = true
        }
      }
      if (settledAny) deps.log("收敛兜底:存在已领取的在途派发,名额已回收")
    },

    /** 统一清理入口,对外暴露给 engine(沿驱动/评估收尾共用) */
    releaseEntry(taskID: string, why: string): void {
      releaseEntry(taskID, why)
    },

    inFlightCount(): number {
      return awaiting.size
    },

    inFlightTaskIDs(): Set<string> {
      return new Set(awaiting.keys())
    },

    dispose(): void {
      disposed = true
      for (const [taskID] of awaiting) releaseEntry(taskID, "dispose")
      awaiting.clear()
    },
  }
}
