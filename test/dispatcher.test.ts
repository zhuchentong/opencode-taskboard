import { describe, expect, test } from "bun:test"
import {
  countActive,
  DISPATCH_CAPS,
  nextBackoffMs,
  nextTimeoutBackoffMs,
  shouldDispatch,
  shouldPauseGlobal,
  shouldPauseWorker,
  type DispatchState,
} from "../src/dispatcher"

const base: DispatchState = {
  primary: true,
  enabled: true,
  paused: false,
  pendingCount: 1,
  activeCount: 0,
  inCooldown: false,
  lastDispatchAgeMs: null,
  todayCount: 0,
}

describe("shouldDispatch（派发条件矩阵）", () => {
  test("全部满足 → ok", () => {
    expect(shouldDispatch(base)).toEqual({ ok: true, reason: "" })
  })

  test("非主实例不派", () => {
    expect(shouldDispatch({ ...base, primary: false }).reason).toBe("secondary")
  })

  test("开关关闭不派", () => {
    expect(shouldDispatch({ ...base, enabled: false }).reason).toBe("disabled")
  })

  test("已暂停不派", () => {
    expect(shouldDispatch({ ...base, paused: true }).reason).toBe("paused")
  })

  test("无待领取任务不派", () => {
    expect(shouldDispatch({ ...base, pendingCount: 0 }).reason).toBe("empty")
  })

  test("并发已满不派（activeCount ≥ maxConcurrent）", () => {
    expect(shouldDispatch({ ...base, activeCount: DISPATCH_CAPS.maxConcurrent }).reason).toBe("concurrency-full")
    expect(shouldDispatch({ ...base, activeCount: DISPATCH_CAPS.maxConcurrent + 3 }).reason).toBe("concurrency-full")
  })

  test("并发差一位仍可派", () => {
    expect(shouldDispatch({ ...base, activeCount: DISPATCH_CAPS.maxConcurrent - 1 }).ok).toBe(true)
    // 注入更低的并发上限时同样按槽位判定：2 个在跑、上限 3 → 仍有余量
    expect(shouldDispatch({ ...base, activeCount: 2 }, { maxConcurrent: 3 }).ok).toBe(true)
  })

  test("冷却中不派", () => {
    expect(shouldDispatch({ ...base, inCooldown: true }).reason).toBe("cooldown")
  })

  test("距上次派发不足最小间隔不派；从未派发过不受限", () => {
    expect(shouldDispatch({ ...base, lastDispatchAgeMs: DISPATCH_CAPS.minIntervalMs - 1 }).reason).toBe("interval")
    expect(shouldDispatch({ ...base, lastDispatchAgeMs: DISPATCH_CAPS.minIntervalMs }).ok).toBe(true)
  })

  test("日计数达上限不派", () => {
    expect(shouldDispatch({ ...base, todayCount: DISPATCH_CAPS.dailyCap }).reason).toBe("cap")
  })

  test("判定顺序：并发满先于冷却、间隔与日上限", () => {
    const full = {
      ...base,
      activeCount: DISPATCH_CAPS.maxConcurrent,
      inCooldown: true,
      lastDispatchAgeMs: 0,
      todayCount: DISPATCH_CAPS.dailyCap,
    }
    expect(shouldDispatch(full).reason).toBe("concurrency-full")
    expect(shouldDispatch({ ...full, activeCount: 0 }).reason).toBe("cooldown")
    expect(shouldDispatch({ ...full, activeCount: 0, inCooldown: false }).reason).toBe("interval")
    expect(shouldDispatch({ ...full, activeCount: 0, inCooldown: false, lastDispatchAgeMs: null }).reason).toBe("cap")
  })

  test("并发上限可注入覆盖（接线/测试）", () => {
    expect(shouldDispatch({ ...base, activeCount: 2 }, { maxConcurrent: 2 }).reason).toBe("concurrency-full")
    expect(shouldDispatch({ ...base, activeCount: 2 }, { maxConcurrent: 3 }).ok).toBe(true)
  })
})

describe("countActive（并发计数：按状态而非 claim）", () => {
  test("analyzing / executing 各算 1", () => {
    const claim = { sessionID: "ses_w1", agent: "build", claimedAt: 0 }
    expect(countActive([{ status: "analyzing", claim }])).toBe(1)
    expect(countActive([{ status: "executing", claim }])).toBe(1)
    expect(
      countActive([
        { status: "analyzing", claim },
        { status: "executing", claim },
        { status: "executing", claim },
      ]),
    ).toBe(3)
  })

  test("pending / analysis_confirm / completion_confirm / done / planning 不算", () => {
    const claim = { sessionID: "ses_w1", agent: "build", claimedAt: 0 }
    expect(
      countActive([
        { status: "planning" },
        { status: "pending" },
        { status: "analysis_confirm", claim },
        { status: "completion_confirm", claim },
        { status: "done", claim },
      ]),
    ).toBe(0)
  })

  test("回归守护：executing 但 claim 为 undefined 仍要算（人工拖到 analysis_confirm → confirm 清空 claim）", () => {
    expect(countActive([{ status: "executing" }])).toBe(1)
    expect(countActive([{ status: "executing", claim: undefined }])).toBe(1)
    expect(countActive([{ status: "analyzing" }, { status: "executing" }])).toBe(2)
  })

  test("空看板 → 0", () => {
    expect(countActive([])).toBe(0)
  })
})

describe("nextBackoffMs（失败退避）", () => {
  test("无失败 → 0（无冷却）", () => {
    expect(nextBackoffMs(0)).toBe(0)
  })

  test("从 60s 起指数翻倍", () => {
    expect(nextBackoffMs(1)).toBe(60_000)
    expect(nextBackoffMs(2)).toBe(120_000)
    expect(nextBackoffMs(3)).toBe(240_000)
  })

  test("封顶 30 分钟", () => {
    expect(nextBackoffMs(6)).toBe(DISPATCH_CAPS.backoffCapMs)
    expect(nextBackoffMs(20)).toBe(DISPATCH_CAPS.backoffCapMs)
  })
})

describe("双熔断隔离（全局派发异常 vs 单 worker 未领取超时）", () => {
  test("两个阈值各自独立取值", () => {
    expect(DISPATCH_CAPS.failPause).toBe(3)
    expect(DISPATCH_CAPS.timeoutPause).toBe(3)
  })

  test("派发异常连败达 failPause → 全局暂停；不牵连单 worker 超时计数", () => {
    expect(shouldPauseGlobal(DISPATCH_CAPS.failPause - 1)).toBe(false)
    expect(shouldPauseGlobal(DISPATCH_CAPS.failPause)).toBe(true)
    // 超时计数为 0 时不产生任何 worker 级暂停
    expect(shouldPauseWorker(0)).toBe(false)
  })

  test("单 worker 超时连败达 timeoutPause → 只冷却该 worker，不触发全局暂停", () => {
    expect(shouldPauseWorker(DISPATCH_CAPS.timeoutPause - 1)).toBe(false)
    expect(shouldPauseWorker(DISPATCH_CAPS.timeoutPause)).toBe(true)
    // 关键边界：超时熔断不置全局 paused（paused 只由 shouldPauseGlobal 决定），
    // 因此一个慢 worker 超时不会阻塞其他 worker 的派发
    expect(shouldPauseGlobal(DISPATCH_CAPS.failPause - 1)).toBe(false)
    expect(shouldDispatch({ ...base, paused: false }).ok).toBe(true)
  })

  test("未领取超时退避复用同一曲线（仅 streak 语义不同）", () => {
    expect(nextTimeoutBackoffMs(0)).toBe(0)
    expect(nextTimeoutBackoffMs(1)).toBe(nextBackoffMs(1))
    expect(nextTimeoutBackoffMs(2)).toBe(nextBackoffMs(2))
    expect(nextTimeoutBackoffMs(20)).toBe(DISPATCH_CAPS.backoffCapMs)
  })

  test("超时退避可注入更短基数（接线/测试）", () => {
    expect(nextTimeoutBackoffMs(1, 10)).toBe(10)
    expect(nextBackoffMs(1, 10)).toBe(10)
  })
})
