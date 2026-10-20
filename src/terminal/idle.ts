// 空闲回收器：某个 sessionID 的客户端归零后开始计时，超时则回收它的 tmux 会话。
//
// 为什么需要：TUI 活在 tmux 会话里，浏览器关掉页签后 TUI 仍占着终端与 daemon 连接；
// 长期没人用的 tmux 会话会一直挂着。空闲超时后 kill 掉是唯一的收敛手段。
//
// 时间源可注入（测试用假时钟），默认用宿主定时器。

/** 默认时钟：宿主定时器 */
export const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
}

/** 时钟接口（注入点） */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** 区间定时器（应用层心跳用）；不实现时回退宿主定时器 */
  setInterval?(fn: () => void, ms: number): unknown
  clearInterval?(handle: unknown): void
}

export class IdleReaper {
  /**
   * @param options.timeoutMs 空闲超时（毫秒）；0 表示不回收
   * @param options.clock 时间源（注入点）
   * @param options.onExpire 超时回调（回收 tmux 会话）
   * @param options.logger 日志器
   */
  constructor({
    timeoutMs,
    clock = systemClock,
    onExpire,
    logger,
  }: {
    timeoutMs: number
    clock?: Clock
    onExpire?: (sessionID: string) => void | Promise<void>
    logger?: { info?: (m: string) => void; debug?: (m: string) => void; error?: (m: string) => void }
  }) {
    this.timeoutMs = timeoutMs
    this.clock = clock
    this.onExpire = onExpire
    this.logger = logger
    /** @type {Map<string, number>} sessionID → 客户端数 */
    this.clients = new Map()
    /** @type {Map<string, unknown>} sessionID → 定时器句柄 */
    this.timers = new Map()
  }

  private timeoutMs: number
  private clock: Clock
  private onExpire?: (sessionID: string) => void | Promise<void>
  private logger?: { info?: (m: string) => void; debug?: (m: string) => void; error?: (m: string) => void }
  private clients: Map<string, number>
  private timers: Map<string, unknown>

  /** 客户端接入：计数 +1，并取消空闲计时 */
  attach(sessionID: string): void {
    const count = (this.clients.get(sessionID) ?? 0) + 1
    this.clients.set(sessionID, count)
    this.clearTimer(sessionID)
  }

  /** 客户端断开：计数 -1，归零则开始空闲计时 */
  detach(sessionID: string): void {
    const current = this.clients.get(sessionID)
    if (current === undefined) return
    const count = current - 1
    if (count > 0) {
      this.clients.set(sessionID, count)
      return
    }
    this.clients.delete(sessionID)
    this.startTimer(sessionID)
  }

  /** 当前客户端数（测试/观测用） */
  clientCount(sessionID: string): number {
    return this.clients.get(sessionID) ?? 0
  }

  /** 关闭：清掉所有定时器 */
  dispose(): void {
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle)
    this.timers.clear()
    this.clients.clear()
  }

  private clearTimer(sessionID: string): void {
    const handle = this.timers.get(sessionID)
    if (handle !== undefined) {
      this.clock.clearTimeout(handle)
      this.timers.delete(sessionID)
    }
  }

  private startTimer(sessionID: string): void {
    if (!this.timeoutMs || this.timeoutMs <= 0) return
    this.clearTimer(sessionID)
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(sessionID)
      // 竞态：到期那一刻可能刚好有客户端接进来 → 本轮作废并重排
      if (this.clientCount(sessionID) > 0) {
        this.logger?.debug?.(`会话 ${sessionID} 在空闲到期瞬间有客户端接入，延后回收`)
        this.startTimer(sessionID)
        return
      }
      this.logger?.info?.(`会话空闲超时，回收 tmux 会话：${sessionID}`)
      Promise.resolve(this.onExpire?.(sessionID)).catch((err) => {
        this.logger?.error?.(`回收 tmux 会话失败：${sessionID}（${err?.message ?? "未知错误"}）`)
      })
    }, this.timeoutMs)
    this.timers.set(sessionID, handle)
  }
}
