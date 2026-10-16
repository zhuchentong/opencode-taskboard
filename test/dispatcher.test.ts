import { describe, expect, test } from "bun:test"
import { DISPATCH_CAPS, nextBackoffMs, shouldDispatch, type DispatchState } from "../src/dispatcher"

const base: DispatchState = {
  primary: true,
  enabled: true,
  paused: false,
  pendingCount: 1,
  workerBusy: false,
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

  test("worker 忙碌不派", () => {
    expect(shouldDispatch({ ...base, workerBusy: true }).reason).toBe("worker-busy")
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
