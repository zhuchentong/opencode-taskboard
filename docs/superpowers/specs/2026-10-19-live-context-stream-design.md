# 实时上下文流（看板 client 化）设计规格

日期：2026-10-19
状态：待审查
前置：P0 交叉验证已完成（见 §2，探针位于 `.debug/spike-live*/`，gitignore，一次性）

## 1. 背景与目标

看板「上下文」标签当前只在挂载时拉一次快照（`GET /api/tasks/:id/context`，数据源为
`src/context.ts` 直读 opencode SQLite），worker 干活时用户必须手动重进标签页才能看到新消息。

目标：上下文标签页**实时跟随 worker 会话**——新消息即时出现、assistant 文本打字机式追加、
工具状态实时翻转。全程只读，不碰 store 写路径，不违反写者唯一约束。

非目标（范围外，见 §8）：替换 SQLite 直读、worker 忙/闲状态反哺任务卡片、TUI 交互。

## 2. 实证基础（P0 交叉验证，2026-10-19）

全部在本机 daemon v2.0.32 + 插件包 2.0.30 上实测：

| 假设 | 结论 |
|------|------|
| 插件进程内 `ctx.event.subscribe()` 可用 | ✅ 收到全链路事件（execution/delta/tool） |
| `session.text.delta` 载荷 | `{sessionID, assistantMessageID, ordinal, delta}`；**ordinal 是 part 索引不是 delta 序号**（实测两条 delta 同为 0） |
| 流式粒度 | 大块 chunk 流（~200ms 窗 1-3 块），非逐 token；合帧 100-200ms 后每观看会话 ~5-10 帧/s |
| `ctx.session.context()` 插件内可调用 | ✅ 返回裸数组（无 HTTP `{data}` 信封）；user `{id,time:{created},text,files,type}` / assistant `{id,time:{created,streamed,completed},type,agent,model,content:[{type:"text"\|"reasoning",text}]}` |
| 事件总线作用域 | **daemon 全局、跨 location**（探针收到其他 location 会话的事件） |
| `session.idle` | ⚠️ v2.0.32 实测**不触发**——生命周期一律用 `session.execution.started/succeeded/failed` |

由此确定的三处设计修正：生命周期用 `execution.*`；**不做** ordinal 空洞检测（一致性唯一
机制是快照收敛）；多实例降级只服务真多 daemon 边缘 case。

## 3. 架构与数据流

```
opencode daemon 总线（daemon 全局、跨 location）
      │ ctx.event.subscribe()  ← 每看板实例一条订阅，懒建立
      ▼
src/live.ts（新模块，纯读）
  ├─ 观看者注册表：taskID → refcount（归零 → 停转发、清缓冲）
  ├─ sessionID 过滤：只留被观看会话，其余事件零成本丢弃
  └─ 合帧缓冲：per 会话 150ms 定时 flush
      ▼
GET /api/tasks/:id/context/live（新增 SSE 端点，独立于 /api/events）
  ├─ frame: text-append  { messageID, text }     ← 追加到该 assistant 消息
  ├─ frame: part-update  { messageID, part }     ← 归一化 part（工具状态等）
  ├─ frame: message-end  { messageID }           ← 该消息流式结束
  └─ frame: ping                                        ← 25s 心跳
      ▼
ContextView.svelte：标签页激活时开 EventSource
  ├─ 正常：text 纯文本追加（流式期间不渲染 markdown），message-end 后整体切 markdown
  └─ 异常：EventSource onerror → 关流 → 重拉现有快照端点 → 2s 后重连（退避）
```

## 4. 组件设计

### 4.1 `src/live.ts` —— 订阅与合帧（服务端核心）

- **懒订阅**：观看者注册表从空到非空、或原订阅已死亡时，`ctx.event.subscribe()` 建立
  （一条订阅服务所有观看者）；最后一个观看者离开时只清注册表不关订阅（复用连接，
  live-only 契约下重连代价高）。插件卸载（cleanup）时整体取消。
- **观看者注册表**：`Map<sessionID, { viewers: Set<response>, buf: DeltaBuffer }>`.
  SSE 响应关闭（`request.signal` abort）即减 refcount。
- **合帧器**（纯函数，可单测）：`createDeltaBuffer(flushMs)`，`push(delta)` / `flush(): string | null`。
  按 `(messageID, ordinal)` 分桶拼文本；flush 产出 `text-append` 帧。
- **事件归一化**（纯函数，可单测）：总线事件 → 帧 | null。
  - `session.text.delta` → 拼 buffer（不立即发帧）
  - `session.tool.called/progress/success/failed` → `part-update`（复用 context.ts 的
    `normalizePart` 归一化 tool part，输出形态与快照一致）
  - `session.message.content.updated` → `message-end`（assistant 消息完整信号）
  - `session.execution.succeeded/failed` → `message-end`（无 content.updated 时的兜底）
  - 其余事件 → null
- **背压**：每帧 enqueue 前查 `controller.desiredSize`，< 0 则丢弃该帧并标记该观看者
  「脏」，其下次重连时靠快照收敛（不累积队列）。

### 4.2 `src/server.ts` —— 新增 SSE 路由

`GET /api/tasks/:id/context/live`：查任务拿 `sessionID`（无会话 → 200 + 立即 `message-end`
+ 关流，前端不重试）；注册观看者；返回 `text/event-stream`（同现有 `/api/events` 的响应头
与帧编码）。**不**走 `emitSnapshot`（纯读路径，无 store 写）。连接关闭时反注册。

鉴权沿用现状：读路径无鉴权属既有知情决策（127.0.0.1 绑定 + 写凭 token）。

### 4.3 前端 `webapp/src` —— 订阅、应用与降级

- `lib/live-context.ts`（纯函数 + 事件应用逻辑，进 `webapp/test/`）：
  - `applyFrame(messages, frame)` → 新 messages：`text-append` 找到目标 assistant 消息的
    text part 追加（无则创建流式占位 part）；`part-update` 按 part 身份替换/插入；
    `message-end` 给消息打「可渲染 markdown」标记。
  - 流式中的 text part 渲染为纯文本 + 光标态；`message-end` 后才走 `Markdown.svelte`
    （避免逐帧 markdown 解析；实测 chunk 粒度下每秒 ≤10 帧纯文本追加，无压力）。
- `ContextView.svelte`：标签页激活 → 先拉现有快照 → 开 EventSource 应用增量；
  `onerror` → 关流、重拉快照、指数退避重连（1s/2s/4s，封顶 10s）；任务切换/标签页
  离开 → 关流。**降级**：连续 3 次重连失败 → 停用实时，仅保留手动「刷新」按钮 +
  快照（行为与现状一致，不劣化）。

### 4.4 多实例

事件总线 daemon 全局，通常主/次实例都能看到 worker 会话事件，各自独立服务本实例的
观看者，无需协调。真多 daemon（`--standalone` 等）下本实例总线无该会话事件 → SSE 静默
（无帧）→ 前端心跳超时（>30s 无任何帧）→ 走重连/降级路径。不为此做跨实例转发（YAGNI）。

## 5. 数据适配（快照 vs 增量的一致性）

快照端点（现有，SQLite 直读）产出 `ContextMessage {id, role, time, parts}`；增量帧的
`messageID` 即快照消息 `id`（同源 msg_ 前缀），对齐关系：

- assistant 消息的 text/reasoning：增量只追加到**最后一个** text/reasoning part；
  `part-update` 的归一化 part 形态与快照 parts 完全一致（同一 `normalizePart`）。
- 两侧的截断策略：增量文本在**前端**追加不受 8KB 截断影响，`message-end` 后下一次
  快照重拉会重新截断——可接受（截断是展示层语义）。
- 用户的 `message-end` 兜底可能早于 SQLite 落库（两侧时钟差毫秒级）：重拉快照以
  `total`/消息数对比，无变化不重渲染（keyed each 已保证）。

## 6. 错误处理

| 故障 | 行为 |
|------|------|
| `ctx.event.subscribe()` 建立失败 | 服务端：该观看者的 SSE 立即 `message-end` 后关流；前端自然走重连→降级 |
| 订阅流中途结束/异常（live-only 契约） | 服务端：log + 给所有活跃观看者发 `message-end`；下一观看者到来时重订阅 |
| 慢消费者（desiredSize < 0） | 丢帧 + 标脏，靠快照收敛，绝不累积队列 |
| SSE 断开 | 前端重拉快照 + 退避重连（§4.3） |
| 任务无会话 / 会话已回收 | 立即 `message-end` 关流，前端不重试 |
| 插件卸载 | cleanup：关订阅、清注册表、停所有 SSE |

日志统一 `[taskboard]` 前缀进环形缓冲（沿项目惯例）。

## 7. 测试

- `test/live.test.ts`：合帧器（分桶/flush/清空）、事件归一化（每类事件 → 期望帧）、
  refcount（多观看者/归零清理）、背压丢帧标记。
- `webapp/test/live-context.test.ts`：`applyFrame`（append 到既有/占位 part、part-update
  替换、message-end 切渲染态）、重连降级状态机（3 次失败 → 降级）。
- wiring：仿 `dispatcher-wiring.test.ts` 验证路由注册与模块装配。
- 手工验收：真跑一轮 worker 任务，上下文标签页观察打字机与工具翻转；杀 SSE 重连收敛。
- `bun test` 为唯一验收门；改 `webapp/` 连带 `bun run build:web` 产物入库。

## 8. 范围外（后续独立评审）

1. `ctx.session.context()` 替换 `src/context.ts` SQLite 直读（消灭 DB 路径/channel/schema
   耦合；实测返回裸数组，适配层与本方案共用）。
2. `session.execution.*` 反哺任务卡片（worker 忙/闲标识、span 计时精化）。
3. 多 daemon 跨实例事件转发（当前靠快照降级覆盖，YAGNI）。

## 9. 风险登记

| 风险 | 缓解 |
|------|------|
| 插件内自订阅无项目先例 | P0 已实证（本规格 §2）；失败路径全程可降级 |
| opencode 版本升级事件语义漂移 | 仓库钉死版本锁死风险；升级时过一遍 §2 实证清单 |
| delta 高频（推理型模型 chunk 更碎） | 合帧 + 背压丢帧 + 前端纯文本追加，三重护栏 |
| SSE 帧把 `/api/events` 语义搅浑 | 独立端点独立帧类型，不复用快照通道 |
