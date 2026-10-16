# 自动派发器（Auto-Dispatcher）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 待领取队列出现任务时，插件自动驱动一个持久 Agent 会话领取并完成闭环——无人值守、可控、可审计、可关停。

**Architecture:** 事件驱动：createServer 写成功 → emitSnapshot → 新增 onWrite 钩子 → dispatcher.evaluate（2s 尾节流）；派发链条靠写广播自我续接。单一持久 worker 会话（storage 持久 sessionID）。仅主实例派发。

**Tech Stack:** 既有插件链（Bun + TypeScript + bun test）；会话 API = `ctx.session`（SessionDomain，含 create/prompt/wait）。

## API 事实（已核实）

- `plugin/dist/promise/session.d.ts:143`：`SessionDomain = Pick<SessionApi, "create"|"get"|"prompt"|"wait"|"synthetic"|...>`
- `session.create(input?) → SessionInfo`（client.d.ts:35）；`prompt({sessionID, text, delivery?})`（:48）；`wait({sessionID}) → void`（:54）

## Global Constraints

- 派发守卫全过才派：primary → autoDispatch 开（默认关）→ 未 paused → pending>0 → worker 空闲 → 无冷却 → ≥10s 间隔 → 日计数 <100
- 失败判定：prompt 后 60s worker 名下无任何 claim → failStreak++，冷却 `nextBackoffMs`（60s 起指数翻倍，30min 封顶）；≥3 → paused；成功（出现 claim 或任务到 completion_confirm/done）→ 清零
- worker busy = 名下存在非 done claim（含停在 analysis_confirm）
- 一次只派一个任务；完成确认/分析确认关卡不绕过
- 提交格式 `<type>: <emoji> <subject>`；功能与文档同包提交

## Review Focus

1. settings PUT 必须改合并语义（现 setSettings 整体覆盖，新字段会被旧 PUT 抹掉）
2. 派发 evaluate 的并发：尾节流 + 单飞（evaluate 重入保护）
3. 60s claim 检查定时器必须在 dispose 清理
4. 仅主实例装配；次要实例 hooks.onWrite 不挂

---

### Task 1: Spike——会话 API 实证

- [ ] `.debug/playground/.opencode/plugins/dispatcher-spike.ts`：setup 内 `session.create({title})` → `prompt({sessionID,text})` → `wait` → `context` 数消息；结果写内存 + `/api/result`（端口 4393）
- [ ] 重启 playground 服务 + `opencode run` 触发加载；验证 Agent 实际执行（context 有 assistant 消息）
- [ ] 退路：prompt 不触发执行则逐个试 delivery；仍不行降级「提醒器」
- [ ] findings 记录到 spike-findings 文档

### Task 2: BoardSettings 扩展 autoDispatch（TDD，含合并语义修复）

- [ ] types.ts 加 `autoDispatch: boolean`
- [ ] store：readSettings 缺省 `{...{requireAnalysisConfirm, autoDispatch:false}, ...raw}`；setSettings(patch: Partial) 校验所给字段布尔、合并写入（修覆盖 bug）
- [ ] server PUT 透传 patch（不变）；server.test 补「PUT 只带一个字段不抹另一个」
- [ ] webapp：types/api/App 接线；Header 加「自动领取」开关
- [ ] 构建 + 全量测试；Commit `feat: ⚙️ 看板设置扩展 autoDispatch 与合并写入`

### Task 3: dispatcher 纯函数（TDD）

- [ ] `src/dispatcher.ts`：`shouldDispatch(state)`（8 守卫依次返回 reason：secondary/disabled/paused/empty/worker-busy/cooldown/interval/cap）+ `nextBackoffMs(failStreak)`（0→0，1→60s 指数翻倍封顶 30min）+ `DISPATCH_CAPS`
- [ ] `test/dispatcher.test.ts` 条件矩阵 + 退避序列；Commit `feat: 🧠 派发条件与退避纯函数`

### Task 4: dispatcher 接线

- [ ] server opts 加 `onWrite?`（emitSnapshot 末尾 `setTimeout(opts.onWrite, 0)`）；arbitrate 透传 hooks；index.ts 仅 primary 装配 `initDispatcher`，`hooks.onWrite = () => dispatcher.notifyWrite()`
- [ ] initDispatcher：尾节流 2s、单飞互斥、worker 会话（storage `${projectID}/settings/dispatcher-session`，get 失效重建）、busy 扫描、60s claim 检查定时器、日计数 storage、paused/冷却内存态、全部决策写 log
- [ ] buildDispatchPrompt（复用 buildClaimPrompt 骨架 + 只领一个即停）
- [ ] Commit `feat: 🚀 自动派发器接线`

### Task 5: UI 与命令输出

- [ ] registerCommands opts 加 `dispatcherText?: () => string`；`/taskboard` 输出追加「自动领取：…」；commands.test 补例
- [ ] Commit `feat: 💬 派发状态可见性`

### Task 6: 集成验收 + 终审

- [ ] `.debug/accept-dispatch.sh`：开开关 → pending 任务 → logs 见派发 → completion_confirm → 确认 done → 自动续链（第二个任务无需人工）→ 关开关不再派
- [ ] spec 补「自动派发」小节；findings 记录
- [ ] 终审子代理（本轮提交范围）+ 修复轮 + 台账
