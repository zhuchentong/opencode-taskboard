import { describe, expect, test } from "bun:test"
import { PHASE_LABELS, formatClock, formatDuration, formatPhaseLine, formatPhaseTooltip, hasRunningSpan, phaseViews } from "../src/lib/duration"
import type { Status, Task } from "../src/lib/types"

const T = (status: Status, spans?: Task["spans"]): Task => ({
  id: "task_x",
  title: "t",
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...(spans ? { spans } : {}),
})

const NOW = new Date("2026-10-16T15:42:30").getTime()

describe("formatDuration", () => {
  test("秒级：不足 1 分钟显示整秒", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(999)).toBe("0s")
    expect(formatDuration(1_000)).toBe("1s")
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(59_999)).toBe("59s")
  })

  test("分钟级：分+补零秒，满 60 秒进位", () => {
    expect(formatDuration(60_000)).toBe("1m00s")
    expect(formatDuration(150_000)).toBe("2m30s")
    expect(formatDuration(605_000)).toBe("10m05s")
    expect(formatDuration(3_599_000)).toBe("59m59s")
  })

  test("小时级：只到分，避免每秒跳动", () => {
    expect(formatDuration(3_600_000)).toBe("1h00m")
    expect(formatDuration(3_900_000)).toBe("1h05m")
    expect(formatDuration(7_500_000)).toBe("2h05m")
  })

  test("负数与非法输入兜底为 0s，不显示负时长", () => {
    expect(formatDuration(-5_000)).toBe("0s")
    expect(formatDuration(NaN)).toBe("0s")
  })
})

describe("formatClock", () => {
  test("同一天只显示时分", () => {
    expect(formatClock(NOW - 5 * 60_000, NOW)).toBe("15:37")
  })

  test("跨天带日期", () => {
    const y = new Date(2026, 9, 15, 9, 5).getTime()
    expect(formatClock(y, NOW)).toBe("10月15日 09:05")
  })

  test("跨年也带日期", () => {
    const y = new Date(2025, 11, 31, 23, 59).getTime()
    expect(formatClock(y, NOW)).toBe("12月31日 23:59")
  })

  test("分钟补零", () => {
    expect(formatClock(new Date(2026, 9, 16, 8, 3).getTime(), NOW)).toBe("08:03")
  })
})

describe("phaseViews", () => {
  test("已封口的段返回固定时长", () => {
    const views = phaseViews(T("done", { analyzing: { startedAt: 1000, endedAt: 4000 } }), NOW)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ phase: "analyzing", label: "分析", startedAt: 1000, endedAt: 4000, duration: 3000, running: false })
  })

  test("进行中的段用 now 计算，running 为真", () => {
    const views = phaseViews(T("executing", { executing: { startedAt: NOW - 90_000 } }), NOW)
    expect(views[0]).toMatchObject({ duration: 90_000, running: true, endedAt: undefined })
  })

  test("无 startedAt 的残缺段丢弃（老任务/伪造数据不渲染）", () => {
    expect(phaseViews(T("executing", { executing: {} as never }), NOW)).toEqual([])
    expect(phaseViews(T("pending"), NOW)).toEqual([])
  })

  test("两段按分析 → 执行排序", () => {
    const views = phaseViews(
      T("done", { executing: { startedAt: 4000, endedAt: 9000 }, analyzing: { startedAt: 1000, endedAt: 4000 } }),
      NOW,
    )
    expect(views.map((v) => v.phase)).toEqual(["analyzing", "executing"])
  })
})

describe("formatPhaseLine", () => {
  test("卡片单行：两段以 · 分隔", () => {
    const line = formatPhaseLine(
      T("done", { analyzing: { startedAt: 0, endedAt: 150_000 }, executing: { startedAt: 150_000, endedAt: 210_000 } }),
      NOW,
    )
    expect(line).toBe("分析 2m30s · 执行 1m00s")
  })

  test("进行中的段带省略号后缀提示仍在跑", () => {
    const line = formatPhaseLine(T("executing", { executing: { startedAt: NOW - 5_000 } }), NOW)
    expect(line).toBe("执行 5s…")
  })

  test("只记了分析段时只显示分析", () => {
    expect(formatPhaseLine(T("analysis_confirm", { analyzing: { startedAt: NOW - 60_000, endedAt: NOW } }), NOW)).toBe(
      "分析 1m00s",
    )
  })

  test("无计时信息返回空串（老任务不显示假数据）", () => {
    expect(formatPhaseLine(T("pending"), NOW)).toBe("")
  })

  test("两张并行卡片的时长互不干扰", () => {
    const a = T("executing", { executing: { startedAt: NOW - 10_000 } })
    const b = T("executing", { executing: { startedAt: NOW - 3_600_000 } })
    expect(formatPhaseLine(a, NOW)).toBe("执行 10s…")
    expect(formatPhaseLine(b, NOW)).toBe("执行 1h00m…")
  })
})

describe("formatPhaseTooltip", () => {
  test("已封口段给出起止绝对时刻与用时", () => {
    const tip = formatPhaseTooltip(T("done", { analyzing: { startedAt: NOW - 90_000, endedAt: NOW - 30_000 } }), NOW)
    expect(tip).toBe("分析：15:41 → 15:42 · 用时 1m00s")
  })

  test("进行中段标「进行中」而非结束时刻", () => {
    const tip = formatPhaseTooltip(T("executing", { executing: { startedAt: NOW - 60_000 } }), NOW)
    expect(tip).toContain("进行中（已 1m00s）")
    expect(tip).toContain("执行：")
  })

  test("无计时段返回空串", () => {
    expect(formatPhaseTooltip(T("pending"), NOW)).toBe("")
  })
})

describe("PHASE_LABELS", () => {
  test("两段中文标签固定", () => {
    expect(PHASE_LABELS.analyzing).toBe("分析")
    expect(PHASE_LABELS.executing).toBe("执行")
  })
})

describe("hasRunningSpan（心跳开关）", () => {
  test("有进行中的段 → true", () => {
    expect(hasRunningSpan(T("executing", { executing: { startedAt: 1000 } }))).toBe(true)
  })

  test("两段都已封口 → false", () => {
    expect(hasRunningSpan(T("done", { analyzing: { startedAt: 1, endedAt: 2 }, executing: { startedAt: 2, endedAt: 3 } }))).toBe(
      false,
    )
  })

  test("无 spans 的老任务 → false（不空转心跳）", () => {
    expect(hasRunningSpan(T("pending"))).toBe(false)
  })

  test("残缺段不算进行中", () => {
    expect(hasRunningSpan(T("executing", { executing: {} as never }))).toBe(false)
  })
})
