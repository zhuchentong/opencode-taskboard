/**
 * 合并-排空评估触发源:修死代码的核心。
 *
 * 旧实现的缺陷:`runEvaluate` 里 `await dispatch(...)`,dispatch 末尾的
 * scheduleEvaluate 被 `if (evaluating) return` 必然丢弃 —— 「即时填槽」在主链路上
 * 是死代码,填槽退化到写事件防抖与 30s 兜底 tick。
 *
 * 新模型:dirty 标志 + 排空循环。运行中到达的请求只置 dirty、不再丢弃;
 * 当前轮 evaluate 结束后循环看到 dirty 立即续跑。每轮至多派发一个任务
 * 由调用方(evaluate 实现)保证,循环天然有界。
 */

export interface Trigger {
  /** 外部写事件:走 externalDebounceMs 防抖,窗口内多次合并为一次 */
  requestExternal(): void
  /** 内部沿结算/派发完成:零延迟置 dirty,排空循环续跑 */
  requestInternal(reason: string): void
  dispose(): void
}

export function createTrigger(opts: {
  evaluate: () => Promise<void>
  externalDebounceMs: number
  /** 0 关闭兜底周期 */
  tickMs: number
  log: (m: string) => void
}): Trigger {
  let dirty = false
  let running = false
  let disposed = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  // 兜底评估:评估主链路由写事件驱动,空闲(无写事件)时冷却到期/任务回池无人触发,
  // 靠这个周期性 tick 自行恢复(下游 evaluate 内部有全部守卫,空转开销可忽略)
  if (opts.tickMs > 0) {
    tickTimer = setInterval(() => {
      dirty = true
      drain()
    }, opts.tickMs)
  }

  /** 排空循环:只要 dirty 就再跑一轮;evaluate 抛错接住记账,循环继续 */
  const drain = (): void => {
    if (running || disposed) return
    running = true
    void (async () => {
      while (dirty && !disposed) {
        dirty = false
        try {
          await opts.evaluate()
        } catch (e) {
          const at =
            e instanceof Error
              ? (e.stack ?? "")
                  .split("\n")
                  .slice(1, 3)
                  .map((s) => s.trim())
                  .join(" | ")
              : ""
          opts.log(`派发评估失败:${e instanceof Error ? e.message : String(e)} @ ${at}`)
        }
      }
      running = false
      // evaluate 运行期间又有内部请求置 dirty(而循环已到尾部)→ 补一轮
      if (dirty && !disposed) drain()
    })()
  }

  const clearDebounce = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  return {
    requestExternal(): void {
      if (disposed) return
      dirty = true
      clearDebounce()
      debounceTimer = setTimeout(
        () => {
          debounceTimer = null
          drain()
        },
        Math.max(0, opts.externalDebounceMs),
      )
    },
    requestInternal(reason: string): void {
      if (disposed) return
      dirty = true
      // 内部诉求零延迟:挂着的防抖 timer 即时满足,清掉防它到点后多跑一轮
      if (!running) clearDebounce()
      opts.log(`评估触发(内部:${reason})`)
      drain()
    },
    dispose(): void {
      disposed = true
      clearDebounce()
      if (tickTimer !== null) {
        clearInterval(tickTimer)
        tickTimer = null
      }
    },
  }
}
