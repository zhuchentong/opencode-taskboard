import { describe, expect, test } from "bun:test"
import { IdleReaper } from "../../src/terminal/idle"
import { createFakeClock } from "./helpers"

describe("终端空闲回收器", () => {
  test("客户端归零后开始计时，超时触发回收", () => {
    const clock = createFakeClock()
    const expired: string[] = []
    const reaper = new IdleReaper({
      timeoutMs: 1000,
      clock,
      onExpire: (id) => {
        expired.push(id)
      },
    })

    reaper.attach("ses_a")
    expect(reaper.clientCount("ses_a")).toBe(1)
    clock.advance(5000)
    expect(expired).toEqual([]) // 还有客户端，不回收

    reaper.detach("ses_a")
    expect(reaper.clientCount("ses_a")).toBe(0)
    clock.advance(999)
    expect(expired).toEqual([])
    clock.advance(1)
    expect(expired).toEqual(["ses_a"])
  })

  test("多客户端：归零前不计时", () => {
    const clock = createFakeClock()
    const expired: string[] = []
    const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => void expired.push(id) })

    reaper.attach("ses_a")
    reaper.attach("ses_a")
    reaper.detach("ses_a")
    clock.advance(2000)
    expect(expired).toEqual([])
    expect(reaper.clientCount("ses_a")).toBe(1)

    reaper.detach("ses_a")
    clock.advance(1000)
    expect(expired).toEqual(["ses_a"])
  })

  test("到期瞬间有客户端接入 → 本轮作废并重排", () => {
    const clock = createFakeClock()
    const expired: string[] = []
    const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => void expired.push(id) })

    reaper.attach("ses_a")
    // 到期那一刻刚好有人连上（先注册 → 同一时刻先于回收器触发）
    clock.setTimeout(() => reaper.attach("ses_a"), 1000)
    reaper.detach("ses_a")
    clock.advance(1000)
    expect(expired).toEqual([])

    // 新的空闲窗口重新计时
    reaper.detach("ses_a")
    clock.advance(1000)
    expect(expired).toEqual(["ses_a"])
  })

  test("timeoutMs=0 表示不回收", () => {
    const clock = createFakeClock()
    const expired: string[] = []
    const reaper = new IdleReaper({ timeoutMs: 0, clock, onExpire: (id) => void expired.push(id) })
    reaper.attach("ses_a")
    reaper.detach("ses_a")
    clock.advance(10_000_000)
    expect(expired).toEqual([])
  })

  test("dispose:清掉所有定时器", () => {
    const clock = createFakeClock()
    const expired: string[] = []
    const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => void expired.push(id) })
    reaper.attach("ses_a")
    reaper.detach("ses_a")
    reaper.dispose()
    clock.advance(5000)
    expect(expired).toEqual([])
    expect(clock.pending()).toBe(0)
  })
})
