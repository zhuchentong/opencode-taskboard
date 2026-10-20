import { test } from "node:test"
import assert from "node:assert/strict"

import { IdleReaper } from "../../src/idle.js"
import { createFakeClock } from "../helpers.mjs"

test("IdleReaper：客户端归零后开始计时，超时触发回收", async () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({
    timeoutMs: 1000,
    clock,
    onExpire: (id) => expired.push(id),
  })

  reaper.attach("ses_a")
  assert.equal(reaper.clientCount("ses_a"), 1)
  reaper.detach("ses_a")
  assert.equal(reaper.clientCount("ses_a"), 0)

  clock.advance(999)
  assert.deepEqual(expired, [])

  clock.advance(1)
  assert.deepEqual(expired, ["ses_a"])
})

test("IdleReaper：超时前重新接入则取消计时", async () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => expired.push(id) })

  reaper.attach("ses_a")
  reaper.detach("ses_a")
  reaper.attach("ses_a")
  clock.advance(5000)
  assert.deepEqual(expired, [])

  reaper.detach("ses_a")
  clock.advance(1000)
  assert.deepEqual(expired, ["ses_a"])
})

test("IdleReaper：多个客户端时最后一个断开才开始计时", async () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => expired.push(id) })

  reaper.attach("ses_a")
  reaper.attach("ses_a")
  assert.equal(reaper.clientCount("ses_a"), 2)
  reaper.detach("ses_a")
  clock.advance(2000)
  assert.deepEqual(expired, [])

  reaper.detach("ses_a")
  clock.advance(1000)
  assert.deepEqual(expired, ["ses_a"])
})

test("IdleReaper：超时为 0 表示不回收", () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({ timeoutMs: 0, clock, onExpire: (id) => expired.push(id) })
  reaper.attach("ses_a")
  reaper.detach("ses_a")
  clock.advance(100000)
  assert.deepEqual(expired, [])
})

test("IdleReaper：dispose 清掉所有定时器", () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => expired.push(id) })
  reaper.attach("ses_a")
  reaper.detach("ses_a")
  reaper.dispose()
  clock.advance(5000)
  assert.deepEqual(expired, [])
})

test("IdleReaper：到期瞬间有客户端接入 → 本轮作废并重排，不误杀", () => {
  const clock = createFakeClock()
  const expired = []
  const reaper = new IdleReaper({ timeoutMs: 1000, clock, onExpire: (id) => expired.push(id) })
  reaper.attach("ses_a")
  reaper.detach("ses_a")

  // 模拟竞态：定时器到期的同一瞬间有客户端接进来（绕过 attach 直接改计数）
  reaper.clients.set("ses_a", 1)
  clock.advance(1000)
  assert.deepEqual(expired, [])

  // 客户端又走了 → 重新计时，到期后正常回收
  reaper.clients.set("ses_a", 0)
  clock.advance(1000)
  assert.deepEqual(expired, ["ses_a"])
})
