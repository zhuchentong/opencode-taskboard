import { describe, expect, test } from "bun:test"
import {
  countActive,
  DISPATCH_CAPS,
  GUARDS,
  nextBackoffMs,
  nextTimeoutBackoffMs,
  shouldDispatch,
  shouldPauseGlobal,
  shouldPauseWorker,
} from "../../src/dispatcher/policy"
import type { DispatchContext, GuardName } from "../../src/dispatcher/types"

const base: DispatchContext = {
  primary: true,
  enabled: true,
  paused: false,
  pendingCount: 1,
  activeCount: 0,
  inCooldown: false,
  lastDispatchAgeMs: null,
  todayCount: 0,
}

describe("守卫链", () => {
  test("GUARDS 顺序钉死:primary→enabled→paused→empty→concurrency→cooldown→interval(cap 已移除)", () => {
    expect(GUARDS.map((g) => g.name)).toEqual([
      "secondary",
      "disabled",
      "paused",
      "empty",
      "concurrency-full",
      "cooldown",
      "interval",
    ] satisfies GuardName[])
  })

  test("shouldDispatch 行为与守卫链一致:8 个 reason 逐一命中、全过返回 ok", () => {
    expect(shouldDispatch(base)).toEqual({ ok: true, reason: "" })
    expect(shouldDispatch({ ...base, primary: false }).reason).toBe("secondary")
    expect(shouldDispatch({ ...base, enabled: false }).reason).toBe("disabled")
    expect(shouldDispatch({ ...base, paused: true }).reason).toBe("paused")
    expect(shouldDispatch({ ...base, pendingCount: 0 }).reason).toBe("empty")
    expect(shouldDispatch({ ...base, activeCount: DISPATCH_CAPS.maxConcurrent }).reason).toBe(
      "concurrency-full",
    )
    expect(shouldDispatch({ ...base, inCooldown: true }).reason).toBe("cooldown")
    expect(shouldDispatch({ ...base, lastDispatchAgeMs: DISPATCH_CAPS.minIntervalMs - 1 }).reason).toBe(
      "interval",
    )
  })

  test("插入自定义 guard 追加在链尾并被 shouldDispatch 执行;测试后恢复链原状", () => {
    GUARDS.push({ name: "test-guard" as GuardName, check: () => "test-blocked" })
    try {
      const v = shouldDispatch(base)
      expect(v.ok).toBe(false)
      expect(v.reason).toBe("test-blocked")
    } finally {
      GUARDS.pop()
    }
    expect(shouldDispatch(base).ok).toBe(true)
  })

  test("守卫按序短路:链首拒绝时链尾自定义 guard 不再看得到", () => {
    GUARDS.push({ name: "test-guard" as GuardName, check: () => "test-blocked" })
    try {
      expect(shouldDispatch({ ...base, primary: false }).reason).toBe("secondary")
    } finally {
      GUARDS.pop()
    }
  })
})

describe("新增派发参数契约(沿驱动一期)", () => {
  test("评估防抖默认 500ms(修死代码配套:写事件节拍收紧)", () => {
    expect(DISPATCH_CAPS.evaluateMs).toBe(500)
  })

  test("建会话失败独立退避参数:连败阈值 3、封顶 5 分钟", () => {
    expect(DISPATCH_CAPS.createFailPause).toBe(3)
    expect(DISPATCH_CAPS.createFailCapMs).toBe(300_000)
  })
})

describe("退避曲线冒烟(全矩阵见 test/dispatcher.test.ts)", () => {
  test("无失败 → 0;1 档 60s;封顶 backoffCapMs", () => {
    expect(nextBackoffMs(0)).toBe(0)
    expect(nextBackoffMs(1)).toBe(60_000)
    expect(nextBackoffMs(20)).toBe(DISPATCH_CAPS.backoffCapMs)
  })

  test("超时退避复用同一曲线", () => {
    expect(nextTimeoutBackoffMs(3)).toBe(nextBackoffMs(3))
  })

  test("双熔断阈值独立且都为 3", () => {
    expect(shouldPauseGlobal(2)).toBe(false)
    expect(shouldPauseGlobal(3)).toBe(true)
    expect(shouldPauseWorker(2)).toBe(false)
    expect(shouldPauseWorker(3)).toBe(true)
  })

  test("countActive 只认 analyzing/executing(回归守护:claim 缺省也算)", () => {
    expect(countActive([{ status: "executing" }])).toBe(1)
    expect(countActive([{ status: "analysis_confirm" }])).toBe(0)
  })
})

describe("日派发上限已移除(产品决策:派发不受日配额拒绝)", () => {
  test("todayCount 超过旧上限(100)乃至任意大,仍放行", () => {
    expect(shouldDispatch({ ...base, todayCount: 100 }).ok).toBe(true)
    expect(shouldDispatch({ ...base, todayCount: 100_000 }).ok).toBe(true)
  })
})
