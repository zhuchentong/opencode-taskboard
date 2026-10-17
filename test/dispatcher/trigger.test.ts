import { describe, expect, test } from "bun:test"
import { createTrigger, type Trigger } from "../../src/dispatcher/trigger"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("createTrigger(合并-排空评估循环)", () => {
  test("死代码回归钉子:evaluate 进行中到达的 requestInternal,当前轮结束后必须再跑一轮", async () => {
    let calls = 0
    let trigger!: Trigger
    trigger = createTrigger({
      evaluate: async () => {
        calls++
        // 模拟 dispatch 完成后的「还剩空槽立即续跑」——在评估运行中触发
        if (calls === 1) trigger.requestInternal("chain")
      },
      externalDebounceMs: 5,
      tickMs: 0,
      log: () => {},
    })
    trigger.requestInternal("first")
    await sleep(40)
    expect(calls).toBeGreaterThanOrEqual(2)
    trigger.dispose()
  })

  test("外部 request 走防抖:窗口内多次合并为一次 evaluate", async () => {
    let calls = 0
    const trigger = createTrigger({
      evaluate: async () => {
        calls++
      },
      externalDebounceMs: 25,
      tickMs: 0,
      log: () => {},
    })
    trigger.requestExternal()
    trigger.requestExternal()
    trigger.requestExternal()
    await sleep(10)
    expect(calls).toBe(0) // 防抖窗口内不跑
    await sleep(40)
    expect(calls).toBe(1) // 窗口过后合并为一次
    trigger.dispose()
  })

  test("prompt 延迟返回不丢 dirty:慢 evaluate 运行期间的新 request 在其结束后续跑", async () => {
    let calls = 0
    const trigger = createTrigger({
      evaluate: async () => {
        calls++
        if (calls === 1) await sleep(30) // 模拟 dispatch 内部 await session.prompt
      },
      externalDebounceMs: 5,
      tickMs: 0,
      log: () => {},
    })
    trigger.requestInternal("first")
    await sleep(5) // 首轮已开始并进入慢 promise
    trigger.requestInternal("during")
    await sleep(60)
    expect(calls).toBeGreaterThanOrEqual(2)
    trigger.dispose()
  })

  test("排空循环有界:dirty 清空后停止,不再空转", async () => {
    let calls = 0
    const trigger = createTrigger({
      evaluate: async () => {
        calls++
      },
      externalDebounceMs: 5,
      tickMs: 0,
      log: () => {},
    })
    trigger.requestInternal("once")
    await sleep(40)
    const stable = calls
    expect(stable).toBe(1)
    await sleep(40)
    expect(calls).toBe(stable) // 无新 request 不再触发
    trigger.dispose()
  })

  test("tickMs>0 兜底周期触发;dispose 后全部停止", async () => {
    let calls = 0
    const trigger = createTrigger({
      evaluate: async () => {
        calls++
      },
      externalDebounceMs: 5,
      tickMs: 15,
      log: () => {},
    })
    await sleep(50)
    expect(calls).toBeGreaterThanOrEqual(1) // 兜底 tick 自行恢复
    trigger.dispose()
    const after = calls
    await sleep(40)
    expect(calls).toBe(after) // dispose 后不再触发
  })
})
