/**
 * 竖直泳道的横向插入判定：卡片在 band 内 flex wrap 排列，
 * 指针落在某张卡片左半 → 插其前；右半 → 插其后。
 * 纯函数（矩形经 getRect 回调注入），便于脱离 DOM 单测。
 */
export function insertIndex(count: number, clientX: number, getRect: (i: number) => DOMRect): number {
  for (let i = 0; i < count; i++) {
    const r = getRect(i)
    if (clientX < r.left + r.width / 2) return i
  }
  return count
}
