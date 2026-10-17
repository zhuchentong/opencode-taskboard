# 派发器沿驱动重构(一期)实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 subagent-driven-development(推荐)或 executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** 将 `src/dispatcher.ts` 重构为 `src/dispatcher/` 沿驱动模块化架构,修复填槽死代码、退避串味、多轮卡死、拖回无唤醒四个实锤缺陷,根治人工拖拽在途会话泄漏,并落地 spanLog 分段计时采集。

**架构:** 转移沿(`TaskTransition{taskID,from,to,seq}`)成为派发器内部一等公民:`onWrite` 带全量任务快照 → 实时沿 diff → 规则表消费(唤醒)→ 防抖评估(派发决策);状态收敛为显式容器(全局态 + 任务表 + 在途表);spanLog 由 `transitionSpans` 双写、metrics 订阅沿流刷新 token。

**技术栈:** Bun + TypeScript + bun test(唯一验收门);无新依赖。

**规格:** `docs/superpowers/specs/2026-10-17-dispatcher-along-driven-design.md`(执行者两份都读;本计划的论证依据全部来自规格)

## 全局约束

- 注释/日志/测试描述/提交信息一律中文;约定式提交带 emoji(如 `feat: 🧠 …`)。
- `initDispatcher(ctx, deps) → { notifyWrite, dispose, status }` 签名不变;`status()` 只增不改;`timeoutStreak` 保留为全局观测口径,任务级退避走 `taskCooldowns` 新字段。
- 仅主实例装配派发器(现状不变,`src/index.ts` 的 `arb.primary` 分支)。
- 一期零新 Store 方法;spanLog 全部经 `transitionSpans`(store 写路径)维护;token 刷新只调现有 `recordUsage`。
- storage key 前置 `${projectID}/dispatcher/`,每张表一个 JSON blob key(接口仅 get/set)。
- 解析顺序:旧 `src/dispatcher.ts` 未删除前,`"./dispatcher"` 解析到旧文件;新模块测试一律用精确路径 `../src/dispatcher/<mod>`;任务 8 删除旧文件后 3 处既有 import 自动落到 `dispatcher/index.ts`。
- 工作区有其他进行中的工作(webapp/、primes),提交时**只 add 本计划任务产出的文件**,绝不 `git add -A`。

## 审查重点(Review Focus)

规格隐含、且无任务测试直接覆盖、最可能伤到使用者的五类输入/失败模式(每条已钉进负责任务的测试步骤):

1. `ctx.session.prompt` 阻塞返回(非立即返回)时,排空循环不得死锁、dirty 不得丢失——prompt 返回后剩余 dirty 必须续跑 → 任务 3 测试「prompt 延迟返回不丢 dirty」。
2. 重启后沿 seq 计数器回退,导致新沿被误判「已处理」而被跳过 → 持久化 blob 必须含 `seqCounter`,任务 7 测试「重启后 seq 从 max+1 续接」。
3. 任务在评估间隙被删除后,lastSeen/lastActedSeq/rounds/tasks 的残留键导致键空间泄漏与幽灵沿 → 任务 4 测试「任务消失清理全部关联键」。
4. 首次观测到的新任务(装载后 lastSeen 无此任务)被误提沿、误唤醒 → 提取规则「unknown → 只记录不提沿」,任务 2 测试钉死。
5. `dispatch` 递归触发评估造成无限循环(dispatch 内 scheduleEvaluate → evaluate → dispatch → …)→ 排空循环有界:每轮循环至多派发一个任务,任务 3 测试钉死。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/dispatcher/types.ts` | 全部契约:`TaskTransition`/`SpanRecord`/`GlobalPhase`/`TaskBackoff`/`Guard`/`CandidateSelector`/`AdvanceRule`/`DispatcherStatus`(扩展)/`DispatcherSession`(补注释) |
| 创建 `src/dispatcher/policy.ts` | 纯决策:守卫链、退避曲线、`countActive`、`DISPATCH_CAPS`——从旧文件迁移,行为不变 |
| 创建 `src/dispatcher/state.ts` | 沿提取(`extractTransitions`)、幂等判定(`shouldAct`/`markActed`)、沿状态 blob 的序列化/装载 |
| 创建 `src/dispatcher/trigger.ts` | 合并-排空触发源:`createTrigger({ evaluate, externalDebounceMs, tickMs })` |
| 创建 `src/dispatcher/session-pool.ts` | 会话建/收/超时回收、在途表(taskID 索引)、统一清理入口 `releaseEntry` |
| 创建 `src/dispatcher/advance.ts` | 推进规则表执行器 + 两条内置规则 |
| 创建 `src/dispatcher/metrics.ts` | 沿流订阅:token 刷新(现有 `recordUsage`)、终结清理、pollUsage/flushUsage 并入 |
| 创建 `src/dispatcher/engine.ts` | 装配:`initDispatcher` 实现、持久化装载、主循环 |
| 创建 `src/dispatcher/prompt.ts` | `buildDispatchPrompt`/`buildNudgePrompt` 迁移与参数化 |
| 创建 `src/dispatcher/index.ts` | 门面:re-export `initDispatcher`/`DISPATCH_CAPS`/类型 |
| 修改 `src/spans.ts` | `transitionSpans` 双写 spanLog(旧 `spans` 逻辑一行不动) |
| 修改 `src/server.ts:59-60,109-112` | `onWrite?: (tasks: Task[]) => void`,emitSnapshot 传载荷 |
| 修改 `src/index.ts:53,64,158-179` | hooks 类型/转发带载荷;dispatcher deps 传新参 |
| 修改 `src/types.ts:39-56` | `Task` 增加 `spanLog?: SpanRecord[]` |
| 删除 `src/dispatcher.ts` | 任务 8;3 处既有 import 自动落到 `dispatcher/index.ts` |
| 测试 `test/dispatcher/{policy,state,trigger,session-pool,advance,metrics,engine}.test.ts` | 各模块单元测试 |
| 修改 `test/dispatcher.test.ts` | import 迁到 `../src/dispatcher/policy`(断言不变) |
| 修改 `test/dispatcher-wiring.test.ts` | import 迁门面;nudge 测试重写为沿驱动语义;harness 其余不动 |

---

### 任务 1:types + policy(纯决策层迁移,守卫链化)

**文件:**
- 创建:`src/dispatcher/types.ts`、`src/dispatcher/policy.ts`、`src/dispatcher/index.ts`(暂只 re-export policy)
- 测试:`test/dispatcher/policy.test.ts`
- 修改:`test/dispatcher.test.ts`(import 路径改为 `../src/dispatcher/policy`,断言原样)

- [ ] **步骤 1:编写失败测试** `test/dispatcher/policy.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { DISPATCH_CAPS, GUARDS, nextBackoffMs, nextTimeoutBackoffMs, shouldDispatch, shouldPauseGlobal, shouldPauseWorker, countActive } from "../../src/dispatcher/policy"
import type { DispatchContext, GuardName } from "../../src/dispatcher/types"

describe("守卫链", () => {
  test("GUARDS 顺序钉死:primary→enabled→paused→empty→concurrency→cooldown→interval→cap", () => {
    expect(GUARDS.map((g) => g.name)).toEqual([
      "secondary", "disabled", "paused", "empty",
      "concurrency-full", "cooldown", "interval", "cap",
    ] satisfies GuardName[])
  })

  test("shouldDispatch 行为与守卫链一致:任一 guard 拒绝即返回其 reason", () => {
    const base: DispatchContext = {
      primary: true, enabled: true, paused: false, pendingCount: 1,
      activeCount: 0, inCooldown: false, lastDispatchAgeMs: null, todayCount: 0,
    }
    expect(shouldDispatch(base)).toEqual({ ok: true, reason: "" })
    expect(shouldDispatch({ ...base, pendingCount: 0 })).toEqual({ ok: false, reason: "empty" })
    expect(shouldDispatch({ ...base, activeCount: DISPATCH_CAPS.maxConcurrent }))
      .toEqual({ ok: false, reason: "concurrency-full" })
    // …其余 reason 逐个:secondary/disabled/paused/cooldown/interval/cap(照旧 test/dispatcher.test.ts 的条件矩阵)
  })

  test("插入自定义 guard 会追加在链尾并被 shouldDispatch 执行", () => {
    // GUARDS 可扩展性:registry.push 后 shouldDispatch 尊重新 guard
  })
})

describe("退避曲线(行为不变,断言照旧)", () => {
  test("nextBackoffMs / nextTimeoutBackoffMs / shouldPauseGlobal / shouldPauseWorker / countActive")
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/policy.test.ts` → FAIL(模块不存在)。
- [ ] **步骤 3:实现**——`policy.ts` 从旧 `src/dispatcher.ts:12-128` 迁移全部纯函数与 `DISPATCH_CAPS`(行为零变化);`shouldDispatch` 改为遍历 `GUARDS: Guard[]`(`{ name: GuardName; check(ctx: DispatchContext, caps): string | null }`,返回 null 放行);`DISPATCH_CAPS` 增加 `evaluateMs: 500`、`createFailPause: 3`、`createFailCapMs: 300_000`(建会话失败退避封顶 5 分钟);`types.ts` 按文件结构表定义全部契约,其中 `DispatcherSession.prompt` 注释必须写明「实现须在触发回合后立即返回,不得等待回合结束——否则评估排空循环将长时间阻塞」;`index.ts` 暂为 `export * from "./policy"`。
- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/policy.test.ts test/dispatcher.test.ts` → 全 PASS(旧矩阵原样通过证明行为不变)。
- [ ] **步骤 5:Commit** `git add src/dispatcher test/dispatcher/policy.test.ts test/dispatcher.test.ts && git commit -m "feat: 🧠 派发器契约与守卫链纯决策层——行为不变的模块化第一步"`

### 任务 2:沿提取与 seq 幂等(state.ts)

**文件:**
- 创建:`src/dispatcher/state.ts`
- 测试:`test/dispatcher/state.test.ts`

- [ ] **步骤 1:编写失败测试** `test/dispatcher/state.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

describe("extractTransitions(lastSeen, tasks, takeSeq)", () => {
  test("首次观测的新任务:只记录 lastSeen,不提沿(防重启/新任务误触发)", () => { /* lastSeen 无 t1,tasks=[t1(executing)] → 沿=[] 且 lastSeen.has(t1) */ })
  test("单步沿:lastSeen=pending → 本轮 analysis_confirm,提 1 条沿并推进 lastSeen", () => { /* {taskID,from:"pending",to:"analysis_confirm",seq:1} */ })
  test("链式多轮:analyzing→analysis_confirm→analyzing 分两轮观测,各提一条沿", () => { /* 每轮 diff 只对上一轮 lastSeen */ })
  test("seq 严格递增:同一批多任务各自提沿,seq 单调不重复", () => { /* takeSeq() 计数器 */ })
  test("同状态无沿:lastSeen==status → 零沿、lastSeen 不变", () => {})
})

describe("沿幂等", () => {
  test("shouldAct:seq > lastActedSeq 时 true,否则 false(未知任务视为 0)", () => {})
  test("markActed 后同沿 shouldAct 为 false", () => {})
  test("act 失败不 markActed:同沿下轮仍应 act", () => { /* 语义由调用方保证,此处只测 markActed 未调用的可重入性 */ })
})

describe("沿状态 blob 序列化", () => {
  test("serializeAlongState/loadAlongState 往返一致:含 lastSeen/lastActedSeq/rounds/taskBackoff/seqCounter", () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/state.test.ts` → FAIL。
- [ ] **步骤 3:实现**——签名:

```ts
export function extractTransitions(
  lastSeen: Map<string, Status>,
  tasks: Task[],
  takeSeq: () => number,
): TaskTransition[]
// 规则:lastSeen 无此任务 → 只 setLastSeen 不提沿;有且 status 变化 → 提沿 {from: lastSeen.get, to: 当前}
export function shouldAct(lastActed: Map<string, number>, t: TaskTransition): boolean
export function markActed(lastActed: Map<string, number>, t: TaskTransition): void
export function serializeAlongState(s: AlongState): string   // JSON blob
export function loadAlongState(raw: unknown): AlongState     // 容错:结构不认得返回空态(宁可重学,不可用假数据)
```

- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/state.test.ts` → PASS。
- [ ] **步骤 5:Commit** `git add src/dispatcher/state.ts src/dispatcher/types.ts test/dispatcher/state.test.ts && git commit -m "feat: ⚡ 任务状态转移沿提取与 seq 幂等纯函数"`

### 任务 3:trigger 合并-排空触发源

**文件:**
- 创建:`src/dispatcher/trigger.ts`
- 测试:`test/dispatcher/trigger.test.ts`

- [ ] **步骤 1:编写失败测试** `test/dispatcher/trigger.test.ts`(风格与现 harness 一致:真实短 sleep,不引 timer mock):

```ts
describe("createTrigger({ evaluate, externalDebounceMs, tickMs })", () => {
  test("重入不丢:evaluate 进行中到达的 request,在当前轮结束后必须再跑一轮(死代码回归钉子)", async () => {
    // evaluate 首轮内部同步调用 trigger.request("internal")(模拟 dispatch 完成续跑)
    // 断言 evaluate 被调用 ≥2 次,且第二轮发生在首轮结束后立即(无防抖延迟)
  })
  test("外部 request 走防抖:窗口内多次合并为一次 evaluate", async () => { /* 3 次 request → 1 次 evaluate */ })
  test("prompt 延迟返回不丢 dirty(审查重点 1):evaluate 返回慢 promise 期间的新 request 不丢", async () => {})
  test("排空循环有界(审查重点 5):evaluate 每轮最多派发一个任务由调用方保证,循环在 dirty 清空后停止", async () => {})
  test("tickMs>0 时兜底周期触发;dispose 后全部停止", async () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/trigger.test.ts` → FAIL。
- [ ] **步骤 3:实现**——签名:

```ts
export interface Trigger {
  /** 外部写事件:走 externalDebounceMs 防抖 */
  requestExternal(): void
  /** 内部沿结算/派发完成:零延迟置 dirty,排空循环续跑 */
  requestInternal(reason: string): void
  dispose(): void
}
export function createTrigger(opts: {
  evaluate: () => Promise<void>
  externalDebounceMs: number
  tickMs: number   // 0 关闭兜底
  log: (m: string) => void
}): Trigger
// 结构:dirty 标志 + running 标志;排空循环 while(dirty){ dirty=false; await evaluate() } —— 每轮至多派发一个任务由 evaluate 自身保证
```

- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/trigger.test.ts` → PASS。
- [ ] **步骤 5:Commit** `git add src/dispatcher/trigger.ts test/dispatcher/trigger.test.ts && git commit -m "feat: 🔁 合并-排空评估循环——重入不再丢弃,即时填槽接通"`

### 任务 4:session-pool(在途表 + taskID 结算 + 统一清理)

**文件:**
- 创建:`src/dispatcher/session-pool.ts`
- 测试:`test/dispatcher/session-pool.test.ts`

- [ ] **步骤 1:编写失败测试** `test/dispatcher/session-pool.test.ts`(复用 dispatcher-wiring.test.ts:20-50 的 fakeSession 模式):

```ts
describe("session-pool", () => {
  test("派发:建会话带 location.directory 与标题,记录在途(taskID 索引)", async () => {})
  test("超时回收:先撤任务再回收会话;任务冷却按任务写入 taskBackoff", async () => {})
  test("超时但任务已被 worker 领取(invalid_transition):保留会话不计败", async () => {})
  test("超时但任务已删除(not_found):回收会话不计败不冷却", async () => {})
  test("拖拽盲区根治:human claim(sessionID 为空串)按 taskID 结算——在途条目即时释放、会话保留、不计超时败(现存 bug 回归)", async () => {
    // 在途 {taskID:t1, sessionID:ses_w1};沿载荷报告 t1 已 analyzing 且 claim={sessionID:"",agent:"human"}
    // 调 settleByTask("t1") → 在途删除、ses_w1 不进 removed
  })
  test("统一清理入口:releaseEntry 幂等(重复调用不再清 timer/删条目/重复日志)", () => {})
  test("建会话失败:不计名额、走独立 createFail 计数与低上限退避(封顶 createFailCapMs),不进 paused", async () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/session-pool.test.ts` → FAIL。
- [ ] **步骤 3:实现**——签名:

```ts
export interface SessionPoolDeps {
  session: DispatcherSession
  directory: string
  claimWaitMs: number
  backoffBaseMs: number
  onSettled: (taskID: string) => void      // 结算后触发 trigger.requestInternal
  onTimeout: (taskID: string, backoffMs: number) => void
  log: (m: string) => void
}
export function createSessionPool(deps: SessionPoolDeps) {
  return {
    dispatch(task: Task, workerName: string): Promise<void>   // 建/发/登记在途
    settleByTask(taskID: string): void                        // taskID 结算(沿驱动零延迟前置)
    sweep(): void                                             // 收敛兜底:对快照核对在途(迁旧 493-509,含 timeoutStreak 归零与「派发→领取」日志)
    releaseEntry(taskID: string, why: string): void           // 统一清理(clearTimeout+delete,幂等)
    inFlightCount(): number
    inFlightTaskIDs(): Set<string>
    dispose(): void
  }
}
```

超时回收语义照旧迁移(dispatcher.ts:375-414:先 `store.patch(taskID,{status:"pending"})` 再 `dropSession`;`invalid_transition` 保留会话不计败;`not_found` 回收会话不计败)。

- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/session-pool.test.ts` → PASS。
- [ ] **步骤 5:Commit** `git add src/dispatcher/session-pool.ts test/dispatcher/session-pool.test.ts && git commit -m "feat: 🏊 会话池 taskID 结算——根治人工拖拽在途会话泄漏"`

### 任务 5:advance 推进规则表

**文件:**
- 创建:`src/dispatcher/advance.ts`、`src/dispatcher/prompt.ts`
- 测试:`test/dispatcher/advance.test.ts`

- [ ] **步骤 1:编写失败测试** `test/dispatcher/advance.test.ts`:

```ts
describe("runAdvance(rules, transition, task, deps)", () => {
  test("钉子:打回重做第二轮放行必唤醒(缺陷 3 回归)", async () => {
    // 任务 t1 第一轮:analysis_confirm→executing 沿 → 唤醒 ses_w1;
    // 打回 pending→重派→新会话 ses_w2→analysis_confirm→executing 沿(seq 更大) → 必须再唤醒 ses_w2
  })
  test("拖回必唤醒(缺陷 4 回归):analysis_confirm→analyzing 沿 → 提示词含最近用户评论", async () => {})
  test("幂等:同一 seq 的沿只 act 一次;act 失败( prompt 抛错)不 markActed、下轮重发成功", async () => {})
  test("未知沿(如 completion_confirm→pending)无匹配规则 → 静默忽略", async () => {})
  test("重析唤醒无评论时提示词不含「评论」占位空段", async () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/advance.test.ts` → FAIL。
- [ ] **步骤 3:实现**——`prompt.ts` 迁移 `buildDispatchPrompt`(旧 197-212 原文),新增:

```ts
export function buildExecuteNudgePrompt(task: { title: string }): string
// 文案沿用旧 541 行:「看板任务「X」已放行进入执行。请继续完成它并用 taskboard_complete 提交;完成后停止。」
export function buildReanalyzePrompt(task: { title: string }, latestComment: string | null): string
// 「看板任务「X」已退回分析中。请根据用户反馈继续分析:{latestComment ?? "(无评论,请复查分析)"};完成后用 taskboard_analyze 再次提交并等待确认。」
export interface AdvanceRule {
  name: string
  on: { from?: Status | "*"; to: Status }
  act: (task: Task, log: (m: string) => void) => Promise<void>
}
export const BUILTIN_RULES: AdvanceRule[]   // execute-nudge / reanalyze-nudge
export async function runAdvance(
  rules: AdvanceRule[], t: TaskTransition, task: Task,
  ctx: { shouldAct(t): boolean; markActed(t): void; log(m): void },
): Promise<void>
// 匹配 on(from/to);先 shouldAct 再 act,成功后 markActed
```

- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/advance.test.ts` → PASS。
- [ ] **步骤 5:Commit** `git add src/dispatcher/advance.ts src/dispatcher/prompt.ts test/dispatcher/advance.test.ts && git commit -m "feat: 📣 转移沿推进规则表——多轮放行与拖回都能唤醒同会话"`

### 任务 6:spans 双写 + metrics

**文件:**
- 修改:`src/spans.ts`、`src/types.ts`(`Task` 加 `spanLog?: SpanRecord[]`)、`webapp/src/lib/types.ts`(前端类型副本手动同步,同加 `spanLog?`——该文件当前无未提交改动,可安全修改)
- 创建:`src/dispatcher/metrics.ts`
- 测试:`test/dispatcher/metrics.test.ts`、`test/spans.test.ts`(追加用例;若已有该文件则在原文件追加)

- [ ] **步骤 1:编写失败测试**(先 `test/spans.test.ts` 追加):

```ts
describe("transitionSpans 双写 spanLog", () => {
  test("多段留存不覆盖:analyzing→analysis_confirm→analyzing→… 各段全部留存(问答循环数据不丢)", () => {})
  test("spanLog 段带 round 与 sessionID(从 task.claim 拷贝;human claim 为 undefined)", () => {})
  test("封口段从 task.usage 拷贝累计快照;无 usage 则缺省", () => {})
  test("回 pending:旧 spans 作废语义不变;spanLog 历史段保留", () => {})
  test("旧 spans 结构行为逐条不变(现有 spans 用例全部原样通过)", () => {})
})
```

`test/dispatcher/metrics.test.ts`:

```ts
describe("metrics.applyTransition(沿驱动 token 刷新)", () => {
  test("进入/离开 analyzing·executing 的沿调 recordUsage(现有 Store 方法),并 broadcast", async () => {})
  test("终结沿(completion_confirm/done)flush:读会话累计回写 + 清理沿状态键", async () => {})
  test("无会话的 claim(human)跳过 token 刷新,不抛错", async () => {})
  test("pollUsage 并入:活跃任务周期刷新(照旧 dispatcher-wiring 437-447 语义)", async () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/spans.test.ts test/dispatcher/metrics.test.ts` → FAIL。
- [ ] **步骤 3:实现**——`types.ts` 的 `Task` 增 `spanLog?: SpanRecord[]`(从 `../dispatcher/types` import 类型会造成 store→dispatcher 反向依赖,因此 `SpanRecord` 定义在 `src/types.ts`,`dispatcher/types.ts` re-export);`transitionSpans` 在现有逻辑后追加 spanLog 维护(封口 `endedAt ??= now` 时同步给 spanLog 尾段封口并拷贝 `task.usage`;开段 push 新记录;回 pending 只清 `next.spans`,spanLog 不动;prevPhase===nextPhase 早退分支不动)。`metrics.ts` 签名:

```ts
export interface MetricsDeps {
  store: Store
  session: DispatcherSession
  broadcast?: () => Promise<void> | void
  usagePollMs: number
  log: (m: string) => void
}
export function createMetrics(deps: MetricsDeps) {
  return {
    applyTransition(t: TaskTransition, task: Task): Promise<void>  // 沿边界刷新 usage
    flushTerminal(tasks: Task[]): Promise<void>                    // 迁旧 flushUsage(302-313)
    startPoll(): void; dispose(): void                             // 迁旧 pollUsage 定时器
  }
}
```

- [ ] **步骤 4:运行验证通过**:`bun test test/spans.test.ts test/dispatcher/metrics.test.ts` → PASS。
- [ ] **步骤 5:Commit** `git add src/spans.ts src/types.ts src/dispatcher/metrics.ts src/dispatcher/types.ts webapp/src/lib/types.ts test/spans.test.ts test/dispatcher/metrics.test.ts && git commit -m "feat: 📊 spanLog 分段计时双写与沿驱动消耗刷新——问答循环每段时长不再丢失"`

### 任务 7:engine 装配 + 持久化 + wiring 迁移

**文件:**
- 创建:`src/dispatcher/engine.ts`
- 测试:`test/dispatcher/engine.test.ts`
- 修改:`test/dispatcher-wiring.test.ts`(import 改 `../src/dispatcher`;harness 的 `fire` 改为携带任务快照 `fire(tasks?)`——默认 `store.list()`;nudge 测试重写)

- [ ] **步骤 1:编写失败测试** `test/dispatcher/engine.test.ts`:

```ts
describe("initDispatcher(engine 装配)", () => {
  test("死代码回归钉子:连续 pending 两个任务、无写事件无 tick,首轮评估后 trigger 排空自动派完两单(即时填槽)", async () => {})
  test("超时退避任务级隔离:A 连续超时 2 次进冷却,B 首次超时退避仍是第 1 档", async () => {})
  test("status() 只增:含旧字段 state/failStreak/todayCount/cooldownRemainMs/activeCount/inFlight/timeoutStreak/queuedCooldownCount + 新字段 lastSkipReason/taskCooldowns", () => {})
  test("沿驱动唤醒接线:analysis_confirm→executing 沿(经 fire 快照)触发执行唤醒一次", async () => {})
  test("重启装载:预置 along-state blob 后重启,状态无变化 → 零沿零唤醒;状态变化 → 正常提沿", async () => {})
  test("重启后 seq 从持久化 seqCounter+1 续接(审查重点 2)", async () => {})
  test("任务删除:沿状态键全部清理(审查重点 3)", async () => {})
  test("关开复位:paused/退避/冷却全清且落盘(旧用例⑤语义,加落盘断言)", async () => {})
})
```

- [ ] **步骤 2:运行验证失败**:`bun test test/dispatcher/engine.test.ts` → FAIL(模块不存在)。
- [ ] **步骤 3:实现**——`engine.ts` 内 `initDispatcher` 签名与旧完全一致(ctx/deps 形参不变,deps 增加可选注入沿用旧名:`evaluateMs/claimWaitMs/backoffBaseMs/minIntervalMs/usagePollMs/evaluateTickMs`);内部:

```ts
// 装载:storage.get(`${projectID}/dispatcher/along-state`) → loadAlongState(blob 含 seqCounter)
// 订阅:deps.onWrite(fn) 的 fn 从 server 收 (tasks: Task[]) => void(本任务先按新签名接线)
// 主循环(trigger.evaluate):沿 diff(实时,evaluate 开头) → metrics.applyTransition → runAdvance(逐沿)
//   → sessionPool.sweep()(收敛兜底) → settings/日计数 → 派发决策(守卫链,每轮至多 1 单)
// nudge 旧代码(526-548)删除,由 advance 规则取代;旧 runEvaluate 的收敛循环迁入 sessionPool.sweep
// 状态复位(关开 autoDispatch):清全局态/任务表/lastActedSeq 并同步落盘
```

- [ ] **步骤 4:运行验证通过**:`bun test test/dispatcher/engine.test.ts` → PASS。
- [ ] **步骤 5:迁移 wiring 测试**:`test/dispatcher-wiring.test.ts` import 改 `../src/dispatcher`;`harness` 的 `fire` 改 `(tasks?: Task[]) => registered?.(tasks ?? 同步 list())` 并让 deps.onWrite 收载荷;重写 nudge 用例(326-349)为「沿驱动:第一轮放行唤醒一次;打回再放行(第二轮)再唤醒一次」;其余 19 个用例断言原样。运行 `bun test test/dispatcher-wiring.test.ts` → 全 PASS(nudge 除外先跑通)。
- [ ] **步骤 6:Commit** `git add src/dispatcher/engine.ts test/dispatcher/engine.test.ts test/dispatcher-wiring.test.ts && git commit -m "feat: 🏗️ 沿驱动引擎装配——即时填槽接通、任务级退避、持久化装载"`

### 任务 8:接线收尾 + 删旧文件 + 全量验收

**文件:**
- 修改:`src/server.ts:59-60,109-112`、`src/index.ts:53,64,158-179`
- 删除:`src/dispatcher.ts`
- 测试:全量 `bun test`

- [ ] **步骤 1:server.ts 载荷**——`onWrite?: (tasks: Task[]) => void`;`emitSnapshot` 末尾 `setTimeout(() => opts.onWrite?.(tasks), 0)`(tasks 即 110 行已取的快照);`index.ts` 的 `hooks: { onWrite?: (tasks: Task[]) => void }` 与 arbitrate 转发同步带载荷。
- [ ] **步骤 2:删旧文件**——`git rm src/dispatcher.ts`;确认 3 处 import(`src/index.ts:7`、`test/dispatcher-wiring.test.ts:2`、`test/dispatcher.test.ts:2`)解析到 `src/dispatcher/index.ts`,`index.ts` 门面 re-export `initDispatcher`/`DISPATCH_CAPS`/`DispatcherStatus`/`DispatcherSession` 及 policy 全部纯函数(保旧测试 import 兼容)。
- [ ] **步骤 3:命令文案核对**——`src/index.ts:187-194` dispatcherText 只读旧字段,无需改;跑 `bun test test/commands.test.ts` 确认。
- [ ] **步骤 4:全量验收**:`bun test` → 全 PASS(0 fail)。若输出含 `Cannot find package 'markdown-it'` 先 `cd webapp && bun install`。
- [ ] **步骤 5:集成手验(可选,不阻塞)**:`bun run dev` 起内存看板,建两个 pending 任务开自动领取,观察 `/api/logs` 出现两次「派发 →」且间隔 < 1s(即时填槽实证)。
- [ ] **步骤 6:Commit** `git add src/server.ts src/index.ts src/dispatcher/index.ts && git rm src/dispatcher.ts && git commit -m "refactor: ♻️ 派发器沿驱动重构收尾——写事件带快照载荷,旧单体退役"`
