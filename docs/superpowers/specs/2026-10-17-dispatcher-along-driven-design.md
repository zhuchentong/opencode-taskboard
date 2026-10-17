# 派发器沿驱动重构与多问题问答交互设计

> 日期:2026-10-17
> 状态:已批准(对话内规格经交叉验证后修订,用户批准执行)
> 前置:`docs/superpowers/plans/2026-10-16-auto-dispatcher.md`(现派发器实施计划,本文取代其派发器部分)

## 1. 背景与诊断

当前 `src/dispatcher.ts` 为「纯决策函数 + 单体接线」结构。实锤缺陷(均已读码证实):

| # | 缺陷 | 证据 |
|---|------|------|
| 1 | **即时填槽死代码**:`runEvaluate` 内 `await dispatch(...)`,`dispatch` 末尾 `scheduleEvaluate()` 被 `if (evaluating) return` 必然丢弃——填槽退化到写事件防抖/30s 兜底 tick | dispatcher.ts:366-369, 461, 576 |
| 2 | **超时退避串味**:`timeoutStreak` 全局计数,冷却却绑定单任务;A 攒的连败抬高 B 的首次退避,任一任务领取清零全局 | dispatcher.ts:252, 384, 397-399, 501 |
| 3 | **多轮卡死**:`nudgedTaskIDs`「一任务一次」语义——打回重做(pending→重新派发→analysis_confirm→放行)第二轮放行不唤醒,worker 永久停在等放行 | dispatcher.ts:262, 543 |
| 4 | **拖回无唤醒**:人工把 analysis_confirm 拖回 analyzing(claim 保留,`applyDragClaim` store.ts:135-142)无任何推进器通知 worker,同会话停滞 | dispatcher.ts:526-548 仅覆盖 `→ executing` |
| 5 | **单体难维护**:`runEvaluate` 115 行六事纠缠(复位/翻日/消耗/收敛/唤醒/派发);五个状态变量散落;`activeCount` 双语义(增量写 vs 绝对值写) | dispatcher.ts:464-579 |
| 6 | 建会话失败无退避,30s 一次无限重试 | dispatcher.ts:420-424 |
| 7 | 可观测性弱:`status()` 粒度粗,`lastSkipReason`/冷却明细不可见 | dispatcher.ts:607-618 |
| 8 | `ctx.session.prompt` 立即返回假设未在接口注释声明;`deps` 注释「默认 2s」过期(实际 500ms) | dispatcher.ts:237-238 |

**交叉验证发现的现存 bug(本设计顺带根治)**:人工拖拽盲区——人类把 pending 拖进 analyzing 时 `claim = { sessionID: "", agent: "human" }`(store.ts:140),在途收敛条件 `t.claim?.sessionID === sessionID`(dispatcher.ts:498)永不匹配;在途条目只能等超时 → `releaseStalled` → patch 撞 `invalid_transition` → 被**误判为「worker 抢先领取」保留会话**,会话泄漏烧 token。

**产品需求**:同一 claim 内分析↔分析确认多次往复(多问题问答循环)、打回整轮重做多次;为未来复杂队列/流程留架构冗余;每轮分析/执行单独计时与统计。

## 2. 关键决策记录

### 2.1 方案 A(状态 diff)vs B(store 订阅)——选 A

- **沿完整性等价**:链式 diff 的净变化语义数学保证「只要任务停在需要唤醒的状态,进入沿必被提出」——多跳合并只丢「已离开状态」的沿,后果自洽(到达即离开 = 无需唤醒或用户撤销)。与 B 的逐写原子事件在「不卡死」硬指标上等价。
- B 的增量价值仅 2s 级收敛实时性(经节拍参数化进一步压缩到无感);成本是 Store 接口四处同步 + 三个新出错面(事件循环抑制、serialized() 互斥链交互、订阅生命周期)。
- B 的真实适用边界(命中才迁移):① 看板需精确事件流水(审计/回放);② 唤醒延迟要求亚秒级;③ 多消费方独立订阅写事件。当前一条不占。
- **方案无关的架构冗余落在沿的消费侧**:`TaskTransition` 契约、`lastActedSeq` 幂等、推进规则表在 A/B 下逐字相同。未来命中边界时 `trigger.ts` 换事件源实现,engine/advance/policy 原样保留。

### 2.2 交付分期

- **一期(本设计实施范围,纯后端)**:dispatcher 沿驱动重构 + 分段统计采集。确认交互用现有「拖回分析中 + 评论」(claim 保留已读码证实)。
- **二期(单独设计后实施)**:ask-question 问答交互(仅分析期)+ 前端展示。

## 3. 一期:dispatcher 沿驱动重构 + 分段统计

### 3.1 模块结构

`src/dispatcher.ts` → `src/dispatcher/` 目录,只经 `index.ts` 门面对外。已验证:全仓库 3 处 import(`src/index.ts:7`、`test/dispatcher-wiring.test.ts:2`、`test/dispatcher.test.ts:2`)落到目录索引 `dispatcher/index.ts` **一行不改**;`initDispatcher(ctx, deps) → { notifyWrite, dispose, status }` 签名不变,`status()` 只增不改。

```
src/dispatcher/
  types.ts          契约:DispatchState / TaskTransition / SpanRecord / DispatcherStatus(只增) / 内部事件
  policy.ts         纯决策:守卫链(8 个)/ 退避曲线 / 候选排序 —— 无 IO,同步可测
  state.ts          唯一可变状态归属:全局态 + 任务表 + 在途表
  trigger.ts        触发源:dirty 标志 + 排空循环;写事件防抖 + 30s 兜底 tick
  session-pool.ts   会话生命周期:建/收/超时回收/在途跟踪
  advance.ts        推进规则表
  metrics.ts        沿流订阅:spanLog 开段/封口;并入 flushUsage/pollUsage
  engine.ts         装配:主循环 = 沿diff → metrics → advance → 收敛(兜底) → 派发决策(防抖)
  prompt.ts         派发/唤醒提示词模板
  index.ts          门面:initDispatcher 签名兼容
```

依赖方向单向:`types ← 其余模块 ← engine ← index`;模块间不横向 import 实现。

### 3.2 数据模型(types.ts 纯加法)

```ts
/** 任务状态转移沿:seq 全局严格递增,幂等消费的原子单位 */
interface TaskTransition {
  taskID: string
  from: Status
  to: Status
  seq: number
}

/** 分段计时记录:只追加,回 pending 不作废历史段 */
interface SpanRecord {
  phase: "analyzing" | "executing" | "analysis_confirm"  // 等待段记时长不记 token
  round: number              // 第几轮(进 pending 次数,与 state 任务表 round 同源;首轮为 1)
  sessionID?: string         // 归因到会话;人工操作段(human claim)无会话
  startedAt: number
  endedAt?: number
  usage?: TaskUsage          // 封口时从 task.usage 拷贝的累计快照(段消耗二期展示层做差)
}

// Task 新增字段
spanLog?: SpanRecord[]
```

前端类型副本 `webapp/src/lib/types.ts` 手动同步(运行时无害,防类型漂移)。

### 3.3 核心机制

#### 沿驱动引擎

- `onWrite` 钩子升级为**全量列表载荷** `onWrite?: (tasks: Task[]) => void`。`emitSnapshot`(server.ts:109-112)处列表现成,改动量:server.ts 一行 + `src/index.ts` 类型与转发 + dispatcher deps 类型 + 测试 harness,4 文件机械修改。
- 沿 diff **实时做**(不防抖);`lastSeenStatus` 链式推进(每轮更新,非对比初始快照);`seq` 严格递增。
- 幂等:per-task `lastActedSeq`,act **成功才推进**;失败下轮自动重发。
- SSE hello 触发(server.ts:145)、settings PUT 无任务载荷:沿 diff 幂等,无害,代码注释声明。

#### 触发模型(修死代码)

dirty 标志 + 排空循环(合并-排空模式):重入不再丢弃,`dispatch` 完成必续跑下一轮,秒级填满并发槽。评估防抖参数化(默认 2000ms → 500ms,写风暴靠排空循环合并);30s 兜底 tick 保留。

#### 收敛与清理

- `awaitingClaims` 结算键从 sessionID 扩展为 **taskID 索引**(沿载荷含任务快照后可行),沿到达零延迟结算——**根治拖拽盲区**(human claim 按 taskID 正常结算,不再等超时误判保留会话)。
- `runEvaluate` 现有收敛循环**保留为兜底**(承担 streak 归零、观测日志「派发→领取」、竞态防线、盲区兜底);30s 兜底 tick 保留。
- **三处清理入口统一**(`runEvaluate` 收敛 / `releaseStalled` finally / 沿结算):收敛为单一清理函数(clearTimeout + delete + 归零 + 日志),防 streak 读写重复。

#### 退避与熔断修正

- 超时退避**按任务隔离**(任务表 `cooldownUntil` + 每任务 streak);任务被领取只清**本任务** streak。
- `status().timeoutStreak` **保留为全局观测口径**(状态灯/日志),新增 `taskCooldowns` 明细字段——status 只增成立,现有断言原样通过。
- 建会话失败独立计数退避(低上限,不进 paused),不再 30s 无限重试。
- 全局熔断(派发异常 3 连败 → paused)语义不变。

#### 推进规则表(advance.ts)

```ts
interface AdvanceRule {
  name: string
  on: { from?: Status | "*"; to: Status }
  act: (task: Task) => Promise<void>
}
```

首发两条:**执行唤醒**(`* → executing`,每次放行都触发,修复多轮卡死)、**重析唤醒**(`analysis_confirm → analyzing`,同会话续用,提示词携带该任务最近用户评论作为答复)。

future 注册位(引擎不动,只加规则):轮次上限熔断、完成打回提示(`completion_confirm → pending`)、卡死自愈(有 claim 停滞超阈值告警/补唤醒)、执行期问答、worker 撤回 ask。

#### metrics / spanLog(一期零新 Store 方法)

- 时长段由 `transitionSpans`(spans.ts)在 store 写路径顺带维护:**旧 `spans` 逻辑一行不动**(前端两段计时不破坏),新 spanLog 只追加;回 pending 时旧 spans 作废语义不变,spanLog 历史段留存。
- 已验证:store 无全量覆盖路径(patch/claim/analyze/complete/release/recordUsage 全部 `{...task, ...}` 起步),前端字段级读取免疫(`webapp/src/lib/duration.ts`、`usage.ts`、`optimistic.ts` 透传未知字段)。
- token 链路:metrics 在沿边界调**现有** `recordUsage` 刷新 `task.usage`;段封口时从 `task.usage` 拷贝累计快照进 `SpanRecord.usage`,段消耗二期展示层做差。精确差分(封口沿主动读会话、新轻量 Store 方法四处同步)留二期。
- `flushUsage`(终结补记)/ `pollUsage`(120s 活跃刷新)并入 metrics。

#### 持久化(四约束)

`${projectID}/dispatcher/` 下(与现有 dailyKey 同构,符合「storage key 必须前置 projectID」):

1. 每张表(lastSeenStatus / lastActedSeq / round / 冷却表)一个 JSON blob key——`DispatcherStorage` 仅 get/set,不扩接口;
2. **initDispatcher 时同步装载**全部表(防重启首轮把所有任务当「未见过的」误触发唤醒);
3. 关开 autoDispatch 复位时同步落盘;
4. 任务删除时,收敛循环发现任务消失顺带清理 lastSeen 键(防键空间泄漏)。

#### 可观测性

`status()` 只增:`lastSkipReason`、`taskCooldowns` 明细、per-task `round` 与停滞时长;转移沿进结构化日志(「任务 X:analysis_confirm→executing(第 N 轮)」);`prompt` 立即返回假设写入 `DispatcherSession` 接口注释;顺手修 deps 注释「默认 2s」过期文案。

### 3.4 测试策略

- 现有 20 个测试:**必改 1 个**(nudge「一任务一次」→ 沿驱动语义,重写为钉子);harness 不动;minIntervalMs / evaluateMs 默认值变化实测不破任何用例。
- 新增钉子测试:
  - 打回重做第二轮放行必唤醒(缺陷 3 回归);
  - 拖回必唤醒(缺陷 4 回归);
  - 拖拽盲区:human claim 在途条目即时结算、会话不泄漏(现存 bug 回归);
  - 触发重入不丢(死代码回归):dispatch 完成后续跑下一轮;
  - 任务级退避隔离:A 连败不抬 B 首次退避;
  - 净变化语义:停在等待态必提沿;
  - 重启装载不误触发;
  - spanLog 多段留存不覆盖、round 标注、封口快照拷贝。
- `bun test` 唯一验收门。

### 3.5 实施顺序

| # | 任务 | 验收 |
|---|------|------|
| 1 | types + policy/state 纯转移函数(TDD) | 条件矩阵、退避序列、状态转移 |
| 2 | 沿提取与 seq 幂等(纯函数,TDD) | 往返/跨窗口/净变化语义 |
| 3 | trigger 合并-排空(TDD) | 重入不丢(死代码回归) |
| 4 | session-pool 迁移 + 统一清理函数 + taskID 结算 | 超时/回收/not_found/盲区 |
| 5 | advance 规则表(TDD) | 多轮放行必唤醒、失败重发 |
| 6 | metrics + spanLog 双写(TDD) | 多段留存、round 标注、快照拷贝 |
| 7 | engine 装配 + 持久化装载 | 现有测试迁移跑绿 |
| 8 | 接线(onWrite 载荷 4 文件)+ 门面验证 | 集成手验 |

## 4. 二期:ask-question 问答交互(仅分析期,单独设计后实施)

1. **Store 四处同步**(接口/store/client/server):
   - `ask`(worker,analyzing 态 → analysis_confirm):**仅 `requireAnalysisConfirm=true` 模式暴露**——false 时 analyze 直落 executing(tools.ts:90-92 提示词),ask 不可达且语义矛盾;
   - `answer`(user,analysis_confirm → analyzing):**独立 store 方法,保留 claim**——不能走 patch 拖拽分支(`applyDragClaim` 在目标离开 CLAIM_STATES 时清 claim);
   - 数据:`task.question = { text, options[], askedAt, answer?: { choice, note?, at } }`,一次一题。
   - 已验证:analyzing→analysis_confirm 当前唯一产生点是 analyze(store.ts:301),ask 成为第二产生者无守卫冲突;answer→analyzing 后 worker 再 analyze 路径通(requireOwned:claim 在 + agent≠human + sessionID 相等)。
2. **工具**:`taskboard_ask`(第 8 个,**更新 AGENTS.md 不变量**);dispatch/nudge 提示词教「有问题提问题,等答案,不自作主张」。
3. **前端**:详情抽屉问答 UI + 选项按钮 + 卡片「待应答」标记;spanLog 分段时长表/轮次成本对比;webapp 产物重建入库。
4. **dispatcher 零改动**:answer 只是 `analysis_confirm → analyzing` 沿的新产生方式,唤醒答复来源从评论升级为结构化答案。

## 5. 不变量(全程守护)

- `initDispatcher` 签名兼容,`status()` 只增;
- Agent 不能标记完成(`taskboard_complete` 只到 completion_confirm);
- 仅主实例装配派发器;
- 写路由必 `await emitSnapshot()`;
- storage key 前置 projectID;
- 产物入库纪律(一期无前端改动,不触发 build:web);
- `bun test` 唯一验收门;
- 注释/日志/UI 文案/提交信息一律中文;约定式提交带 emoji。

## 6. 交叉验证修订对照

| # | 修订 | 来源 |
|---|------|------|
| ① | timeoutStreak 保留全局观测 + taskCooldowns 只增 | status 只增冲突 |
| ② | onWrite 全量列表载荷,4 文件机械改动,幂等容忍 | 「一行」低估 |
| ③ | 测试必改精确为 1 个;收敛循环/兜底 tick 保留为兜底 | 测试兼容核查 |
| ④ | 三处清理入口统一;taskID 结算根治拖拽盲区 | 现存 bug 发现 |
| ⑤ | spanLog 一期零新 Store 方法(封口快照拷贝闭环) | 写通道核查 |
| ⑥ | ask 模式限定 / answer 独立方法保留 claim / 撤回 future | 二期预检 |
| ⑦ | 持久化四约束(blob/init 装载/复位落盘/键清理) | 持久化核查 |
