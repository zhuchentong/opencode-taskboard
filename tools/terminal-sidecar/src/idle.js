/**
 * idle 回收：某个 sessionID 的客户端归零后开始计时，超时则回收它的 tmux 会话。
 *
 * 时间源可注入（测试用假时钟），默认用 Node 内置定时器。
 */

/** 默认时钟：Node 内置定时器 */
export const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

export class IdleReaper {
  /**
   * @param {object} options
   * @param {number} options.timeoutMs 空闲超时（毫秒）；0 表示不回收
   * @param {object} [options.clock] 时间源（注入点）
   * @param {(sessionID: string) => void|Promise<void>} options.onExpire 超时回调
   * @param {object} [options.logger] 日志器
   */
  constructor({ timeoutMs, clock = systemClock, onExpire, logger } = {}) {
    this.timeoutMs = timeoutMs
    this.clock = clock
    this.onExpire = onExpire
    this.logger = logger
    /** @type {Map<string, number>} sessionID → 客户端数 */
    this.clients = new Map()
    /** @type {Map<string, any>} sessionID → 定时器句柄 */
    this.timers = new Map()
  }

  /** 客户端接入：计数 +1，并取消空闲计时 */
  attach(sessionID) {
    const count = (this.clients.get(sessionID) ?? 0) + 1
    this.clients.set(sessionID, count)
    this._clearTimer(sessionID)
  }

  /** 客户端断开：计数 -1，归零则开始空闲计时 */
  detach(sessionID) {
    const current = this.clients.get(sessionID)
    if (current === undefined) return
    const count = current - 1
    if (count > 0) {
      this.clients.set(sessionID, count)
      return
    }
    this.clients.delete(sessionID)
    this._startTimer(sessionID)
  }

  /** 当前客户端数（测试/观测用） */
  clientCount(sessionID) {
    return this.clients.get(sessionID) ?? 0
  }

  /** 关闭：清掉所有定时器 */
  dispose() {
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle)
    this.timers.clear()
    this.clients.clear()
  }

  _clearTimer(sessionID) {
    const handle = this.timers.get(sessionID)
    if (handle !== undefined) {
      this.clock.clearTimeout(handle)
      this.timers.delete(sessionID)
    }
  }

  _startTimer(sessionID) {
    if (!this.timeoutMs || this.timeoutMs <= 0) return
    this._clearTimer(sessionID)
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(sessionID)
      this.logger?.info?.(`会话空闲超时，回收 tmux 会话：${sessionID}`)
      Promise.resolve(this.onExpire?.(sessionID)).catch((err) => {
        this.logger?.error?.(`回收 tmux 会话失败：${sessionID}（${err?.message ?? "未知错误"}）`)
      })
    }, this.timeoutMs)
    this.timers.set(sessionID, handle)
  }
}
