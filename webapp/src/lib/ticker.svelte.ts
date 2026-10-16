/**
 * 秒级心跳（Svelte 5 runes 模块状态）：驱动「当前执行时长」实时递增。
 * 组件直接 $derived 消费 ticker.now，无需经 props 传递。
 *
 * 启停由 App 依 hasRunningSpan 判定：没有任务在跑时定时器停摆，不空转。
 */

export const ticker = $state({ now: Date.now() })

let handle: ReturnType<typeof setInterval> | null = null

/** 启动心跳；幂等——重复调用不会叠加定时器 */
export function startTicker(): void {
  if (handle !== null) return
  handle = setInterval(() => {
    ticker.now = Date.now()
  }, 1000)
}

/** 停止心跳；幂等 */
export function stopTicker(): void {
  if (handle === null) return
  clearInterval(handle)
  handle = null
}
