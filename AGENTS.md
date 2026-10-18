# AGENTS.md

面向 OpenCode 会话的仓库指南。权威口径看设计规格 `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（§5 状态机、§9 并发与实例模型、§11 开发工作流），实施计划与验收记录在 `docs/superpowers/plans/`。

## 项目是什么

OpenCode V2 插件：七阶段任务看板（planning → pending → analyzing → analysis_confirm → executing → completion_confirm → done）。Agent 用 `taskboard_*` 工具领取、分析、提交完成，用户在网页看板（基准端口 4370）上规划、放行、验收。

- `src/` —— 插件运行时（TypeScript，Bun 跑；唯一依赖 `@opencode/plugin`，与 `package.json` 钉死的 opencode 版本一致）。入口 `index.ts`（端口仲裁 + 装配）；`store.ts` 本地存储、`client.ts` HTTP 代理实现、`server.ts` HTTP 服务 + SSE、`tools.ts` Agent 工具、`commands.ts` `/taskboard` 与 `/taskboard-claim` 命令、`dispatcher/` 自动派发器（沿驱动模块目录，见下）、`spans.ts` 阶段计时（含 spanLog 双写）、`dev.ts` Mock 模式
- `webapp/` —— 前端源码（Svelte 5 + Vite，仅开发前端时需要）
- `src/web/` —— **前端构建产物，已提交入库**（见下方「产物必须入库」）
- `test/`（服务端）、`webapp/test/`（前端纯函数）—— 全部进 `bun test`

## 命令

```bash
bun install                        # 根依赖（只有 @opencode/plugin）
cd webapp && bun install           # 单独重装前端依赖（正常由根 bun install 的 postinstall 自动完成）
bun test                           # 唯一验收门（webapp 依赖由根 postinstall 自动装；报 Cannot find package 'markdown-it' 时先 cd webapp && bun install）
bun test test/store.test.ts        # 单文件；bun test -t "关键字" 按用例名过滤
bun run dev                        # Mock 模式：内存后端 + 真实服务，免 OpenCode；token 固定 dev，TASKBOARD_PORT 可换端口
bun run dev:web                    # 前端 HMR（/api 代理到 4370，token 兜底 dev，配合 bun run dev 使用）
bun run build:web                  # 重建产物到 src/web/（必须与 webapp/ 改动一起提交）
bun run watch:web                  # 构建产物 watch 模式
```

**没有 lint、没有格式化器、没有 CI、没有可用的 typecheck。** `tsconfig.json` 要求 `bun-types` 但该包未安装，`tsc --noEmit` 直接报 TS2688。别声称 typecheck 通过，`bun test` 是唯一验证手段。

## 硬约束（改代码前必须知道）

- **产物必须入库**：`src/web/` 是给用户安装用的（用户只拷 `src/`，无需 Node 工具链）。改了 `webapp/` 就必须跑 `bun run build:web` 并提交产物。`webapp/vite.config.ts` 把产物文件名钉死为 `assets/board.js` / `assets/board.[ext]`（无 hash、`emptyOutDir`），别「修」这个反直觉配置。`server.proxy` 把 `/api` 代理到 4370、`webapp/index.html` 的 token 占位符带 dev 兜底（未被服务端替换时回落 `"dev"`），dev:web HMR 因此可直接用。
- **Store 有两份实现**：`src/store.ts`（本地）与 `src/client.ts`（HTTP 代理）。新增 Store 方法要四处同步：接口类型、`store.ts` 本地实现、`client.ts` 代理实现、`server.ts` 路由（写路由必须 `await emitSnapshot()`，见下）。
- **写者唯一 + 四向端口仲裁**（`src/index.ts` `arbitrate`，已导出可测）：① 绑上基准端口 4370 → 主实例（唯一写者，写全走 `store.ts` 的 `serialized()` 全局互斥链，比 spec §9 的「每任务锁」更强）；② 基准端口被**同项目**主实例占用（`/api/health` 的 projectID 相同）→ 降级次要实例，整个 Store 读写全量代理到主实例；③ 被其他服务占用 → **上移扫描，绑不上的忙端口先做 health 探测（2s 超时），发现同项目主实例（可能它自己也曾上移）就降级代理到它，绝不第二个当主**，否则上移自己当主。破坏写者唯一 = 同项目双主 split-brain、并发写坏数据。代理请求统一 10s 超时，网络层错误归一为 `unreachable`（Agent 收到「看板服务不可达」文案）；`forbidden` 保留 403 语义提示令牌失配。读路径（tasks/logs/SSE）无鉴权属**知情决策**（127.0.0.1 绑定 + 写凭 token）。
- **自动派发器只装配在主实例**（`src/index.ts` 只在 `arb.primary` 时 `initDispatcher`），次要实例也装会双派发。派发器在 `src/dispatcher/` 目录（对外只经 `index.ts` 门面），沿驱动架构（规格 `docs/superpowers/specs/2026-10-17-dispatcher-along-driven-design.md`）：**一任务一会话**（任务终结后会话不复用）、**转移沿驱动**（server 写事件带全量任务快照 `onWrite(tasks)` → 沿 diff 实时做、派发评估走 500ms 防抖 + 30s 兜底 tick，`trigger.ts` 合并-排空循环——重入不丢弃，dispatch 完成必续跑）、即时填槽、全局最小间隔节流 + 日派发上限；派发异常连败 → 全局 paused 熔断，未领取超时按**任务**独立退避（`timeoutStreak` 仅全局观测口径），建会话失败独立低上限退避（成功归零）。派发提示词把 taskID 写死（防多 worker 抢任务）；worker 会话必须显式传 `ctx.location.directory`，否则回退到服务进程 cwd（实测曾落到无关目录）。**worker 会话必须显式指定模型**（三通道优先级：看板网页设置 `modelAnalyze`/`modelExecute` > 环境变量 `TASKBOARD_MODEL`（运维兜底，`provider/model` 形态）> opencode 默认解析）：实测(2026-10-18) opencode 对无 model 的后台会话在异常 daemon 下**创建即挂起**（session_v2.time_suspended=创建时刻，回合永不启动 → 任务无人领取）；且默认解析的免费档模型 **provider 429 限流会致批量领取全灭**（idle_outcome=failed、tokens=0）——网页选付费档模型可解。执行回合模型经 prompt per-call model 切换（**key 是 `modelID`**，create 是 `id`，别搞混），confirm-off 下无独立执行回合（worker 单回合干到底，_execute-nudge from 钉死 analysis_confirm_），分模型只在 confirm-on 放行场景生效。**严禁在插件/daemon 进程内 exec `opencode` CLI**（实证：子进程 CLI 干预 service 生命周期致 daemon 重启，连带杀死宿主会话）——`/api/models` 数据源只读本地文件（全局 opencode.json 的 providers 键 × `~/.cache/opencode/models.json` 元数据，剔 disabled）。改派发器前先读 `src/dispatcher/` 各模块头注、规格、`test/dispatcher-wiring.test.ts`（wiring）、`test/dispatcher/`（单元）与 `docs/superpowers/plans/2026-10-17-dispatcher-along-driven.md`。沿驱动的关键不变量：① `execute-nudge` 的 `from` 钉死 `analysis_confirm`——放宽到 `"*"` 会在 confirm-off（默认配置）下每任务误发一枪唤醒；② `runAdvance` 返回 `failed` 的沿**必须**入引擎重试队列（`retryAlong`），丢了 = 一次瞬断 worker 永久卡死；③ `maps.*` 是 Map，清空用 `.clear()`/`.delete()`，赋值普通对象会让 `serializeAlongState` 的 `fromEntries` 抛「not iterable」；④ 超时撤任务只能经 `patchTask` 守卫契约（仅 pending 可撤，否则抛 invalid_transition）——直接 `store.patch` 会删掉 worker 正在用的会话；⑤ 沿状态 blob（`${projectID}/dispatcher/along-state`）含 seqCounter，装载在 `initDispatcher` 里 lazy-await，重启后沿 seq 从 max+1 续接；⑥ spanLog/round 真源在 `spans.ts`（store 写路径双写，旧 `spans` 结构逐字不动，前端两段计时依赖它），spanLog 覆盖 pending/analyzing/analysis_confirm/executing 全生命周期段（排队段也入账）。
- **每次写都要广播**：`src/server.ts` 的写路由必须 `await emitSnapshot()`，否则前端 SSE（`/api/events` 全量快照，唯一事实源）停在旧状态。例外要自知：派发器直接走 store 层不经 HTTP，`emitSnapshot` 不会触发，由 `index.ts` 注入的 `broadcast` 显式补发。
- **storage key 必须前置 `projectID`**：`ctx.storage` 按插件全局共享、无位置隔离。本地 store 靠 `storageBackend(ctx.storage, `${projectID}/`)` 包装；派发器拿的是裸 storage，自己拼 `${projectID}/dispatcher/...`；token 持久化在 `${projectID}/settings/token`（跨重启与多实例共享同一令牌）。漏前缀会跨项目串数据。
- **令牌靠占位符注入**：`webapp/index.html` 里 `__TASKBOARD_TOKEN_VALUE__` 由 `server.ts` 伺服静态文件时替换进 `window.__TASKBOARD_TOKEN__`。前端读 window 必须惰性（`webapp/src/lib/api.ts` 有说明：bun 测试环境无 DOM）。
- **前端交互逻辑写纯函数**：放 `webapp/src/lib/`（`board.ts` 分组、`lane.ts` 拖拽、`duration.ts`/`usage.ts` 计时与消耗、`markdown.ts`、`events.ts` SSE、`optimistic.ts` 乐观更新等）并配套 `webapp/test/`；`.svelte.ts` 响应式模块（`drag`、`ticker`）也在 lib。别把逻辑塞进 `.svelte` 组件。
- **Agent 不能标记完成**：`taskboard_complete` 只到 completion_confirm，只有用户在网页确认才进 done；打回必须附评论。工具共 7 个（list/get/claim/analyze/complete/release/update），生效名是 `taskboard_<短名>`（来自 `taskboard` 命名空间，提示词里 `tools.taskboard.*` 与原生 `taskboard_*` 都提）。别「简化」掉这些产品不变量。

## 本地集成调试

- 集成装载必须用 `.opencode/plugins/taskboard-loader.ts` 装载器文件（`import plugin from "<abs>/src/index.ts"`）：v2.0.30 的 `plugins` 配置键**不加载本地路径**（spike 实证，别浪费时间试配置）。
- 改插件代码后要 `opencode service restart`——本地依赖不触发自动重载。
- 插件日志统一 `[taskboard]` 前缀，进内存环形缓冲，`GET /api/logs` 查看；插件 console 不落 `opencode.log`，服务端问题查 `~/.local/share/opencode/log/opencode.log`（筛 `role=server`）。
- `.debug/` 被 gitignore，属本机私有（playground 与验收脚本），没有它属正常；派发器行为以入库的 `test/dispatcher-wiring.test.ts` 为准。

## 约定

- 注释、日志、UI 文案、文档、提交信息一律中文；提交用中文约定式提交带 emoji（见 `git log`），如 `feat: 🚀 派发器 worker 池重构——一任务一会话与即时填槽调度`。
- 测试描述也用中文（如 `reject 无评论 → 400 comment_required`）。
- `StoreError` 是跨层唯一错误契约：code → HTTP 状态映射在 `server.ts` 的 `STATUS_BY_CODE`，给 Agent 的文案在 `tools.ts` 的 `describeError`。新增错误码要同时补这两处。
