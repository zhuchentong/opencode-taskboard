/**
 * 竖直泳道的插入判定：卡片在 band 内 flex wrap 可换行，
 * 先按垂直距离定位指针所在行（行内卡片 top 相同），再在行内按 X 判中线：
 * 指针在某卡左半 → 插其前；右半或行尾之后 → 插行尾卡之后。
 * 纯函数（矩形经 getRect 注入），便于脱离 DOM 单测。
 */
export function insertIndex(
  count: number,
  clientX: number,
  clientY: number,
  getRect: (i: number) => DOMRect,
): number {
  if (count === 0) return 0
  // 定位最近行：垂直中心距指针最近的那张卡
  let nearest = 0
  let best = Infinity
  for (let i = 0; i < count; i++) {
    const r = getRect(i)
    const d = Math.abs(r.top + r.height / 2 - clientY)
    if (d < best) {
      best = d
      nearest = i
    }
  }
  const rowTop = getRect(nearest).top
  let lastInRow = -1
  for (let i = 0; i < count; i++) {
    const r = getRect(i)
    if (Math.abs(r.top - rowTop) > 4) continue // 不同行
    lastInRow = i
    if (clientX < r.left + r.width / 2) return i
  }
  return lastInRow + 1
}
