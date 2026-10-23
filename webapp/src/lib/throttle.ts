/** 固定窗口节流判定：窗口内返回 false（不刷新窗口），窗口外返回 true 并记录。
 * 纯函数（时间注入），不 import sonner，保证 bun 可测。 */
export function shouldEmit(
  last: Map<string, number>,
  key: string,
  now: number,
  windowMs = 5000,
): boolean {
  const prev = last.get(key)
  if (prev !== undefined && now - prev < windowMs) return false
  last.set(key, now)
  return true
}
