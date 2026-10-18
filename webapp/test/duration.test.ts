import { describe, expect, test } from "bun:test"
import { PHASE_LABELS, formatClock, formatDuration, formatPhaseLine, formatPhaseTooltip, hasRunningSpan, needsTicker, phaseViews, queueWaitMs, summarizeSpans } from "../src/lib/duration"
import type { Status, Task } from "../src/lib/types"

const T = (status: Status, spans?: Task["spans"], over?: Partial<Task>): Task => ({
  id: "task_x",
  title: "t",
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...(spans ? { spans } : {}),
  ...over,
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

describe("queueWaitMs（排队时长）", () => {
  test("pending 用 pendingAt 计时", () => {
    expect(queueWaitMs(T("pending", undefined, { pendingAt: NOW - 200_000 }), NOW)).toBe(200_000)
  })

  test("老任务无 pendingAt → 回落 createdAt", () => {
    expect(queueWaitMs(T("pending", undefined, { createdAt: NOW - 60_000 }), NOW)).toBe(60_000)
  })

  test("非 pending 状态返回 null（不显示排队时长）", () => {
    expect(queueWaitMs(T("analyzing", undefined, { pendingAt: NOW - 1000 }), NOW)).toBeNull()
    expect(queueWaitMs(T("done", undefined, { pendingAt: NOW - 1000 }), NOW)).toBeNull()
  })

  test("时钟回拨 / 未来时间 → 归零不显负数", () => {
    expect(queueWaitMs(T("pending", undefined, { pendingAt: NOW + 50_000 }), NOW)).toBe(0)
  })
})

describe("needsTicker（心跳开关）", () => {
  test("待领取任务需要心跳（排队时长逐秒递增）", () => {
    expect(needsTicker(T("pending"))).toBe(true)
  })

  test("有进行中计时段需要心跳", () => {
    expect(needsTicker(T("executing", { executing: { startedAt: 1 } }))).toBe(true)
  })

  test("终态任务无在途计时与排队 → 停摆", () => {
    expect(needsTicker(T("done"))).toBe(false)
    expect(needsTicker(T("analysis_confirm", { analyzing: { startedAt: 1, endedAt: 2 } }))).toBe(false)
  })
})

describe("summarizeSpans(分段计时汇总)", () => {
  const t = (spanLog?: Task["spanLog"], over: Partial<Task> = {}): Task => ({
    id: "task_x",
    title: "t",
    description: "",
    status: "analyzing",
    comments: [],
    createdAt: 500,
    updatedAt: 7000,
    ...(spanLog ? { spanLog } : {}),
    ...over,
  })

  test("多段:逐段行(中文标签/轮次/起止/耗时)+ 活跃合计 + 墙钟", () => {
    const s = summarizeSpans(
      t([
        { phase: "pending", round: 2, startedAt: 1000, endedAt: 2000 },
        { phase: "analyzing", round: 2, startedAt: 2000, endedAt: 4000 },
      ]),
      8000,
    )
    expect(s.rows).toEqual([
      { phase: "pending", label: "排队", round: 2, start: 1000, end: 2000, ms: 1000, running: false },
      { phase: "analyzing", label: "分析中", round: 2, start: 2000, end: 4000, ms: 2000, running: false },
    ])
    expect(s.activeTotal).toBe(3000)
    expect(s.wallClock).toBe(7500) // createdAt 500 → now 8000
  })

  test("进行中的段:耗时以 now 实时计算、end 为 null、running=true", () => {
    const s = summarizeSpans(t([{ phase: "analyzing", round: 1, startedAt: 2000 }]), 4500)
    expect(s.rows[0]).toEqual({
      phase: "analyzing", label: "分析中", round: 1, start: 2000, end: null, ms: 2500, running: true,
    })
    expect(s.activeTotal).toBe(2500)
  })

  test("阶段中文标签:排队/分析中/待确认/执行中", () => {
    const s = summarizeSpans(
      t([
        { phase: "pending", round: 1, startedAt: 1000, endedAt: 1100 },
        { phase: "analysis_confirm", round: 1, startedAt: 1100, endedAt: 1200 },
        { phase: "executing", round: 1, startedAt: 1200, endedAt: 1300 },
      ]),
      8000,
    )
    expect(s.rows.map((r) => r.label)).toEqual(["排队", "待确认", "执行中"])
  })

  test("空 spanLog(旧任务):rows 空、activeTotal null、墙钟仍可用", () => {
    const s = summarizeSpans(t(undefined), 8000)
    expect(s.rows).toEqual([])
    expect(s.activeTotal).toBeNull()
    expect(s.wallClock).toBe(7500)
  })

  test("终态任务(done)墙钟冻结于 updatedAt 而非 now", () => {
    const s = summarizeSpans(t([], { status: "done", updatedAt: 6000 }), 8000)
    expect(s.wallClock).toBe(5500) // createdAt 500 → updatedAt 6000
  })
})
