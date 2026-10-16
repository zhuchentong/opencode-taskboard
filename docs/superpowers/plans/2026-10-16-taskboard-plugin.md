# OpenCode Taskboard 插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现七阶段任务看板的 OpenCode V2 插件：网页看板 + Agent 工具认领/分析/执行 + 双人工关卡与打回循环。

**Architecture:** 插件进程内启动 HTTP 服务（Bun.serve，退化方案见 spec §9）；存储统一抽象为 Store 接口，内存与 ctx.storage 两个后端共享同一状态机与全局写互斥；Agent 工具与 Web API 是同一 Store 的两个入口，工具路径走受限流转，Web 路径走人工流转；主/次要实例用端口归属决定唯一写者。

**Tech Stack:** TypeScript（免构建，Bun 直接加载）、`@opencode/plugin@2.0.30`、`Bun.serve`、原生 HTML/JS/CSS、bun test。

**Spec:** `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（执行者必须同时读 spec 与本计划）

## Global Constraints

- 仓库根即包根；`package.json`: `"type": "module"`，`exports: { ".": "./src/index.ts" }`，`dependencies: { "@opencode/plugin": "2.0.30" }`，`scripts: { "dev": "bun run src/dev.ts", "test": "bun test" }`。
- 运行时依赖仅 `@opencode/plugin`，不得新增其他 npm 依赖。
- 状态常量（verbatim）：`"planning" | "pending" | "analyzing" | "analysis_confirm" | "executing" | "completion_confirm" | "done"`；中文列名：待规划/待领取/分析中/分析确认/执行中/完成确认/已完成。
- 默认端口 `4370`（`options.port` 可覆盖）；仅绑定 `127.0.0.1`。
- 变更类请求必须带 `X-Taskboard-Token` 头且 `Content-Type: application/json`，否则 403/415；token 由服务端注入静态页，URL 不携带。
- 看板设置 `{ requireAnalysisConfirm: boolean }`，默认 `false`（假设 A）。
- Agent 工具路径：`done` 不可达；打回（reject）必须附非空评论；打回/放弃清空 `claim`。
- 插件日志统一前缀 `[taskboard]`，走 `console.log`/`console.error`。
- 所有面向用户的文案（工具返回、错误消息）用简体中文。
- 提交信息用中文约定式提交（含 emoji），如 `✨ feat(store): ...`。
- 测试统一 `bun test`；服务测试用 `port: 0`（Bun 自动分配）。

## Review Focus

1. **并发 claim 同一任务**：两个会话同时 `claim()`（缺省领最旧 pending）必须恰一人成功，另一人得到"已被领取"→ Task 3 竞态测试。
2. **打回不带评论**：`reject` 无 `comment` 或空白评论必须拒绝且状态不变 → Task 3 + Task 4。
3. **无 token 的变更请求**：浏览器跨站简单请求（无 `X-Taskboard-Token`）POST/PATCH/PUT/DELETE 一律 403，GET 不受影响 → Task 4。
4. **任务已删除后的工具调用**：`complete`/`release`/`analyze` 对已删任务返回"任务已不存在（可能已被删除），请放弃该任务"，不得抛未处理异常 → Task 5。
5. **设置切换瞬间的 analyze**：`analyze` 在锁内读取当前设置并据此流转，响应中带回实际到达的状态，Agent 不需要猜 → Task 3。

---

### Task 1: Spike——真实 OpenCode 环境验证四项前提

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`（node_modules、.debug/）
- Create: `src/index.ts`（临时探针版，后续 Task 7 重写）
- Create: `.debug/spike/opencode.jsonc`（探针项目配置，加载本插件绝对路径）
- Create: `docs/superpowers/plans/2026-10-16-taskboard-spike-findings.md`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 决策表（写入 findings 文件），后续任务据此填充：`KEY_PREFIX`（storage key 是否带 projectID）、`SERVE_MODE`（`"inprocess"` 或 `"childprocess"`）、`TOOL_NAMES`（生效名是否为 `taskboard_<短名>`）、`BROWSER_OPEN`（`"spawn"` 或 `"url-only"`）

- [ ] **Step 1: 写探针插件** `src/index.ts`：`Plugin.define({ id: "taskboard-spike", async setup(ctx) })`，探针内容：
  1. `Bun.serve({ port: 4390, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) })`，日志输出端口与 `Bun.serve` 是否抛错；cleanup 时 `server.stop(true)`。
  2. `ctx.storage.set("spike/probe", { dir: ctx.location.directory, ts: Date.now() })` 后 `ctx.storage.scan({ prefix: "spike/" })`，日志输出结果。
  3. `ctx.tool.transform` 注册 namespace `"spike"` + 工具短名 `"hello"`，`ctx.tool.list()` 日志输出生效 ID。
  4. `ctx.command.transform` 注册命令 `spike-open`，execute 内 best-effort 用 `Bun.spawn(["xdg-open", "http://127.0.0.1:4390"])` 并捕获异常日志。
- [ ] **Step 2: 配置探针项目** `.debug/spike/opencode.jsonc`：`{ "$schema": "https://opencode.ai/config.json", "plugins": ["/home/zhuchentong/Projects/zhuchentong/opencode-taskboard"] }`
- [ ] **Step 3: 运行验证**：`.debug/spike/` 下运行 `opencode`（TUI 或 `opencode run`）；`curl http://127.0.0.1:4390/` 应得 `{"ok":true}`；在会话中让 Agent 调 `spike_hello` 工具、执行 `/spike-open`；查看 `~/.local/share/opencode/log/opencode.log` 中 `[taskboard]` 前缀日志与 `role=server` 记录；storage 落盘位置用 `find ~/.local/share/opencode/storage -name "*probe*"` 观察 key 的路径作用域。
- [ ] **Step 4: 记录决策**：findings 文件填四项决策表 + 证据摘录；`SERVE_MODE="inprocess"` 则 Task 7 按主/次要实例实现，否则按 spec §9 退化方案先停下来与用户确认子进程设计补充。
- [ ] **Step 5: Commit** `🎉 chore: 项目脚手架与 spike 探针`

### Task 2: 类型定义与存储核心（状态机 + 内存后端）

**Files:**
- Create: `src/types.ts`
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（后续所有任务依赖，签名 verbatim）:

```ts
// src/types.ts
type Status = "planning" | "pending" | "analyzing" | "analysis_confirm" | "executing" | "completion_confirm" | "done"
interface TaskComment { author: string; text: string; createdAt: number }
interface Claim { sessionID: string; agent: string; claimedAt: number }
interface Task {
  id: string; title: string; description: string; status: Status
  analysis?: string; result?: string
  comments: TaskComment[]; claim?: Claim
  createdAt: number; updatedAt: number
}
interface BoardSettings { requireAnalysisConfirm: boolean }
type StoreErrorCode = "not_found" | "invalid_transition" | "conflict" | "not_claimer" | "comment_required" | "no_pending" | "invalid_input"
class StoreError extends Error { code: StoreErrorCode }

// src/store.ts
interface KVBackend {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<{ key: string; value: unknown }[]>   // 游标循环在此封装
}
function memoryBackend(): KVBackend
interface Store { /* 见下方方法，全部 Promise，失败抛 StoreError */ }
function createStore(backend: KVBackend, opts: { requireAnalysisConfirm: boolean }): Store
```

Store 方法（人工路径与工具路径分开）：
- 人工（Web）：`list(): Task[]`（updatedAt 倒序）、`get(id)`、`create({title, description?}) → planning`、`remove(id)`、`patch(id, p: { status?: Status; title?; description?; action?: "confirm"|"reject"; comment?: string })`、`getSettings()`、`setSettings(s)`
- 工具（受限）：`claim({ id?, sessionID, agent })`、`analyze({ id, sessionID, analysis })`、`complete({ id, sessionID, result? })`、`release({ id, sessionID })`、`updateNotes({ id, sessionID, analysis?, result? })`

- [ ] **Step 1: 写失败测试** `test/store.test.ts`（用 `memoryBackend()`，断言要点）：
  - `create` 落 `planning`；`patch` 改 status 为任意值成功（人工兜底）；拖离 `analyzing`/`executing` 或拖入 `planning`/`pending`/`analysis_confirm` 清 `claim`；拖入 `analyzing`/`executing` 无 claim 时 `claim.agent="human"`。
  - 工具路径全流转：`claim` pending→analyzing 并写 claim；`analyze` 按设置到 `analysis_confirm`（开）或 `executing`（关），响应含到达状态；`complete` executing→completion_confirm；`release` 两状态→pending 且清 claim。
  - 非法流转拒绝：`claim` 非 pending、`complete` 非 executing、`analyze` 非 analyzing、`release` 非 analyzing/executing、工具路径不可达 `done`、对 `analysis_confirm`/`completion_confirm` `reject` 无评论 → 对应 `StoreErrorCode`。
  - 非领取者/`agent:"human"` 时 `analyze`/`complete`/`release` → `not_claimer`。
  - 打回 `patch(id,{action:"reject",comment:"重新做"})` → status `pending`、claim 清空、评论入列 author "user"。
  - 并发竞态：`Promise.allSettled([s.claim(...), s.claim(...)])` 同一任务恰一 fulfilled；两次无 id `claim` 各领到不同任务。
  - 设置：`setSettings` 后 `analyze` 行为随之变化（Review Focus 5）。
- [ ] **Step 2: 跑测试确认失败** `bun test test/store.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现 `src/types.ts` 与 `src/store.ts`**：
  - `createStore` 内部一把**全局写互斥**（promise 链）串行化全部写操作——它是 spec"每任务锁"的超集，且让"无 id claim 领最旧"天然原子；`scan` 循环游标（backend 内实现）。
  - id：`task_` + `crypto.randomUUID()` 前 8 位；时间用 `Date.now()`。
  - 状态机写成常量表（`AGENT_NEXT`/`WEB_CONFIRM`/`WEB_REJECT`），`patch` 人工路径按 spec §5.4 维护 claim。
- [ ] **Step 4: 跑测试通过** `bun test` → PASS
- [ ] **Step 5: Commit** `✨ feat(store): 七阶段状态机与任务存储核心`

### Task 3: ctx.storage 后端与分页

**Files:**
- Modify: `src/store.ts`（新增 `storageBackend(ctx.storage, keyPrefix)`）
- Test: `test/store.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `KVBackend` 契约
- Produces: `storageBackend(storage: { get; set; remove; scan(opts:{prefix,after?,limit?}) }, keyPrefix: string): KVBackend`——key 映射 `keyPrefix + "task/" + id` 与 `keyPrefix + "settings/board"`；`scan` 用 `after` 游标循环取全量（limit 100）

- [ ] **Step 1: 追加失败测试**：用一个按 `after`（字典序）截断、limit 生效的假 ctx.storage 模拟分页（两页数据），断言 `createStore(storageBackend(fake,...))` 的 `list()` 返回全部任务且顺序正确；`remove` 后 `list` 不再含该任务。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `storageBackend`**：`scan` 循环 `while (true) { page = await storage.scan({ prefix, after, limit: 100 }); push; if (!page.next) break; after = page.next }`；key 前缀来自 spike `KEY_PREFIX` 决策（占位常量 `TASK_PREFIX`/`SETTINGS_KEY` 置于 store.ts 顶部）。
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `✨ feat(store): ctx.storage 后端与游标分页`

### Task 4: HTTP 服务（REST + 静态页 + token）

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 `Store`、`memoryBackend`
- Produces: `createServer(store: Store, opts: { port: number; token: string; webDir: string; primary: boolean }): { server: Bun.Server; actualPort: number; stop(): void }`

路由（spec §6 verbatim）：`GET /api/tasks`、`POST /api/tasks`、`PATCH /api/tasks/:id`（支持 `{action:"confirm"|"reject", comment?}` 与字段编辑）、`DELETE /api/tasks/:id`、`GET|PUT /api/settings`、`GET /api/health`（`{ok,primary}`）、`GET /` 及静态资源（`webDir`）。

- [ ] **Step 1: 写失败测试** `test/server.test.ts`（`memoryBackend` + `createServer(..., { port: 0 })`，`fetch` 实际请求）：
  - 建任务 → 列表含之；PATCH 改标题成功；PATCH `{action:"reject"}` 无评论 400（`comment_required`）；PATCH `{action:"confirm"}` 于 `completion_confirm` → `done`。
  - 无 token POST → 403；token 对但 `Content-Type` 非 JSON → 415；GET 无 token 正常。
  - `PUT /api/settings` 后 `GET` 返回新值，且 store 行为改变（analyze 路径）。
  - `GET /` 返回 `index.html` 且包含 token 字符串；未知 API 路径 → 404 JSON（Review Focus）。
  - `StoreError` → 对应 HTTP 状态（not_found 404、invalid_transition/conflict/not_claimer/comment_required 400、invalid_input 400）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `src/server.ts`**：`Bun.serve({ hostname: "127.0.0.1", port, fetch })`；静态文件从 `webDir` 读，`index.html` 以占位符 `__TASKBOARD_TOKEN__` 替换注入 token；统一错误映射函数 `toResponse(e: unknown)`。
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `✨ feat(server): REST API、token 防误触与静态伺服`

### Task 5: Agent 工具与错误文案

**Files:**
- Create: `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: Task 2 `Store`（工具路径方法）、`StoreError`
- Produces: `registerTools(ctx, store): Promise<Registration>`——namespace `"taskboard"`，短名 `list/get/claim/analyze/complete/release/update`（生效名 spike 确认）；`describeError(e: unknown): string`（纯函数，可单测）

- [ ] **Step 1: 写失败测试** `test/tools.test.ts`：`describeError` 对各 `StoreErrorCode` 输出含关键词的中文文案；`not_found` 必须含"任务已不存在（可能已被删除），请放弃该任务"（Review Focus 4）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `src/tools.ts`**：七个工具的 input JSON Schema（`list` 可选 `status` 枚举；`claim` 可选 `id`；`analyze` 必填 `id,analysis`；其余必填 `id`）；`execute` 从 `context.sessionID` 取会话，调用 store 对应方法，返回 `{ content: <中文可读文本，JSON 序列化任务摘要> }`；异常经 `describeError` 转文本返回（不抛出）。`claim` 响应附带 `requireAnalysisConfirm`；`analyze` 响应附带实际到达的 `status`。
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `✨ feat(tools): taskboard 命名空间七个 Agent 工具`

### Task 6: 命令与插件组装（index.ts）

**Files:**
- Create: `src/commands.ts`
- Rewrite: `src/index.ts`（替换 Task 1 探针版）
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `createStore`+`storageBackend`、`createServer`、`registerTools`、spike 决策（`KEY_PREFIX`/`SERVE_MODE`/`BROWSER_OPEN`）
- Produces: `registerCommands(ctx, store, opts: { port: number; token: string }): Promise<Registration>`；插件默认导出 `Plugin.define({ id: "taskboard", setup })`

- [ ] **Step 1: 写失败测试** `test/commands.test.ts`：对命令定义的纯逻辑部分测——`buildBoardText(url)`、`buildClaimPrompt()` 返回包含"领取/分析/执行/完成确认"关键词的工作流指令文本（与 spec §7 一致）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现两个文件**：
  - `commands.ts`：`taskboard`（synthetic 消息输出 URL；`BROWSER_OPEN="spawn"` 时 best-effort `Bun.spawn(["xdg-open", url])` 并吞错）、`taskboard-claim`（`ctx.session.prompt` 注入工作流指令）。
  - `index.ts` setup：读 `ctx.options`（`port` 默认 4370、`requireAnalysisConfirm` 默认 false）→ 生成 token → 端口归属裁决（绑 4370 成功=主实例；失败探 `GET 127.0.0.1:4370/api/health`，是本插件主实例则以 `clientStore`（fetch 实现 Store 接口，代理到主实例）建 store，否则上移端口当主实例）→ `SERVE_MODE` 分支 → 注册 tools/commands → 返回 cleanup（stop server）。日志 `[taskboard]` 前缀。
- [ ] **Step 4: 跑测试通过**（`bun test` 全量）
- [ ] **Step 5: Commit** `✨ feat(plugin): 命令、主次实例裁决与插件组装`

### Task 7: 网页前端与 Mock 模式

**Files:**
- Create: `src/web/index.html`、`src/web/app.js`、`src/web/style.css`
- Create: `src/dev.ts`

**Interfaces:**
- Consumes: Task 4 的 REST API（字段与错误格式 verbatim）；token 占位符 `__TASKBOARD_TOKEN__`
- Produces: 可用看板页；`bun run dev` 本地 Mock 服务

- [ ] **Step 1: 实现静态页**：七列（列名 verbatim 见 Global Constraints）；顶部新建输入 + 设置开关（requireAnalysisConfirm，PUT /api/settings）；卡片显示标题/描述/claim/评论；`analysis_confirm`、`completion_confirm` 两列卡片带"通过/打回"，打回弹必填评论框（PATCH `{action:"reject", comment}`）；拖拽换列 PATCH status；2s 轮询 `/api/tasks` 与 `/api/settings`；token 从注入页面的全局变量读取。
- [ ] **Step 2: 实现 `src/dev.ts`**：`createStore(memoryBackend(), { requireAnalysisConfirm: false })` + 预置 3 条样例任务 + `createServer(..., { port: 4370, token: "dev", webDir: "./src/web", primary: true })`，日志输出 `http://127.0.0.1:4370`。
- [ ] **Step 3: 验证 Mock 模式**：`bun run src/dev.ts` 后台起服；`curl -s http://127.0.0.1:4370/api/tasks` 返回 3 条；`curl -sI -X POST http://127.0.0.1:4370/api/tasks`（无 token）得 403；浏览器人工检查：四流转操作、开关切换后"分析确认"列行为变化、打回评论必填、轮询生效。
- [ ] **Step 4: Commit** `✨ feat(web): 七列看板前端与 dev Mock 模式`

### Task 8: 集成验收（真实 OpenCode 闭环）

**Files:**
- Create: `.debug/playground/opencode.jsonc`（`plugins: [本仓库绝对路径]`，gitignore）
- Modify: 仅在验收暴露问题时修 bug

**Interfaces:**
- Consumes: 全部前序任务；`.debug/playground` 配置
- Produces: 验收记录（追加到 spike-findings 文件）

- [ ] **Step 1: 服务重载**：`opencode service restart`；`.debug/playground` 下启动 `opencode`；日志确认 `[taskboard]` 加载、监听端口。
- [ ] **Step 2: 网页闭环**：建任务 → 拖到待领取 → 执行 `/taskboard-claim` → 观察任务进入分析中 → Agent 提交分析（开关关：直达执行中；开关开：停在分析确认，网页点通过）→ 执行 → 完成确认 → 网页点通过 → 已完成。
- [ ] **Step 3: 打回循环**：完成确认处打回附评论 → 回待领取 → 再次 `/taskboard-claim` → 评论可见、claim 更新为新会话。
- [ ] **Step 4: 竞态与卸载**：两个会话同时 `/taskboard-claim` 抢同一任务，仅一会话成功；`opencode service restart` 后网页与任务数据仍在（storage 持久化）。
- [ ] **Step 5: 记录与收尾**：验收结果写入 findings；全量 `bun test` 绿；Commit `✅ test: 集成验收记录`（如有 bug 修复一并提交）。

---

## Self-Review 记录

- **Spec 覆盖**：§5 状态机→Task 2；§5.5 存储→Task 3；§6 API→Task 4；§7 工具/命令→Task 5/6；§8 前端→Task 7；§9 实例模型→Task 6 Step 3；§10 错误处理→Task 4 `toResponse` + Task 5 `describeError`；§11 调试→Task 1/7/8；§12 spike→Task 1；§13 测试→各任务 Step 1。无缺口。
- **类型一致性**：`Store` 方法名在 Task 2 定义、Task 4/5/6 消费一致；`StoreErrorCode` 七值贯穿；token 占位符仅 Task 4/7 使用同名。
- **比例**：计划以签名+断言表达，未转写实现体；长度与 spec 相当。
