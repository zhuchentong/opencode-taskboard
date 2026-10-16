// token 消耗展示的纯函数（供卡片 meta 行与详情面板复用；无 DOM 依赖，便于 bun 直测）
import type { TaskUsage } from "./types"

/** 计量字段求和用的兜底：非有限数/负数/缺失一律按 0 计（旧快照可能缺字段） */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

/** token 数紧凑显示：<1000 原样；<1e6 → floor(n/1000)+"k"；<1e9 → (n/1e6).toFixed(1)+"M"；>=1e9 → (n/1e9).toFixed(1)+"G"；负数/NaN → "0" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1000) return String(n)
  if (n < 1e6) return `${Math.floor(n / 1000)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`
  return `${(n / 1e9).toFixed(1)}G`
}

/** 任务总 token 消耗 = input + output + reasoning + cacheRead + cacheWrite；缺字段按 0 计 */
export function totalTokens(usage: TaskUsage): number {
  return num(usage.input) + num(usage.output) + num(usage.reasoning) + num(usage.cacheRead) + num(usage.cacheWrite)
}
