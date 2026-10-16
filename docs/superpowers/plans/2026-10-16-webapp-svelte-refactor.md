# 网页端 Svelte 5 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 Svelte 5 + Vite 重构任务看板网页端：SSE 实时、乐观更新、Pointer 拖拽、详情侧滑面板，消灭原生 alert/confirm，构建产物入库保持安装模型不变。

**Architecture:** 服务端只加一条 SSE 路由与广播总线（REST 形状零破坏）；前端整体重写为 Svelte 5 组件树，源码在 `webapp/`，Vite 构建产物落 `src/web/` 入库。乐观更新用纯函数状态机（遮罩 + 服务器快照回滚），SSE 全量快照广播为唯一事实源。

**Tech Stack:** Bun 1.4.2（运行/测试）、Svelte 5 + Vite（仅构建期，node v24.18.0 可回退）、无其他运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（§8 前端部分由本计划推翻重写：无框架决策 → Svelte 5，理由见任务 12 spec 修订）；架构修订讨论见本仓库 git 历史与 2026-10-16 会话记录。

## 执行编排（混合并行，用户已选定）

```
Phase A（串行）      Task 1 Spike —— 契约与构建链冻结点
Phase B（3 泳道并行） L1=Task3(SSE服务端)  L2=Task4(脚手架)  L3=Task8(乐观协议)
Phase C（2 泳道并行） L2'=Task5+6(Header+看板渲染)  L4=Task10(Toast/Confirm)
Phase D（串行）      Task2 退役 → Task7 拖拽 → Task9 SSE客户端 → Task11 详情面板 → Task12 验收收尾
```

- 并行泳道用 `opencode worktree_create` 隔离，每泳道一个实现子代理 + 一个审查子代理；合并顺序 L2 → L1 → L3 → L4（文件不相交，merge 平凡）
- **文件所有权边界**（泳道子代理越界即停）：
  - L1：仅 `src/server.ts`、`test/server-sse.test.ts`
  - L2：仅 `webapp/`（脚手架部分）、根 `package.json`、`.gitignore`
  - L3：仅 `webapp/src/lib/optimistic.ts`、`webapp/test/optimistic.test.ts`
  - L4：仅 `webapp/src/components/{Toasts,ConfirmDialog}.svelte`、`webapp/src/lib/notify.ts`
- 每泳道提示词必须附：本计划 Global Constraints + 对应任务全文 + Svelte 5 组件规范（runes：`$state`/`$derived`/`$props`；组件文件 PascalCase.svelte；lib 纯 TS 不 import .svelte）

## Global Constraints

- Bun 1.4.2 运行与测试；构建用 `bun x vite`，失败回退 `node node_modules/.bin/vite`
- 七状态值（verbatim）：`planning` `pending` `analyzing` `analysis_confirm` `executing` `completion_confirm` `done`
- 服务绑定 `127.0.0.1`，默认端口 `4370`；变更路由须带 `X-Taskboard-Token` + `Content-Type: application/json`
- token 注入占位符（verbatim）：`__TASKBOARD_TOKEN_VALUE__`
- SSE：事件仅 `hello` 与 `snapshot`（全量 `tasks`+`settings`）；心跳注释帧 25s；连接上限 32（超出 503）；免 token
- 静态响应加 `Cache-Control: no-cache`
- 构建产物固定文件名：`src/web/assets/board.js`、`src/web/assets/board.css`；产物提交入库
- UI 文案简体中文；提交信息格式 `<type>: <emoji> <subject>`（type 小写，emoji 在冒号后）
- 仅桌面端；不引入除 svelte/vite/vite-plugin-svelte 外的任何依赖

## Review Focus

1. **SSE 断线期间他端改动**：重连后必须自动补齐最新状态（重连首条 snapshot 即全量）→ Task 9 测试钉住「断连→恢复→收到快照→状态一致」
2. **快速重复操作同一任务**（双击「通过」）：第二次 `invalid_transition` 不得破坏 UI 状态 → Task 8 settle 测试 + Task 11 接线
3. **拖拽撞上 Agent 操作**（drop 时任务已被认领）：回滚到服务器快照而非本地旧位置 → Task 8 测试钉住
4. **构建产物缺失**（`src/web` 为空）：页面 404 返回 JSON 错误而非静默白屏/500 → Task 3 静态路由测试补一条
5. **打开次要实例端口页面**：写经代理仍可用，且本页能收到该写操作的广播 → Task 12 双实例验收

---

### Task 1: Spike——Svelte 5 + Vite + Bun 工具链验证

**Files:**
- Create: `webapp/`（临时探针：`index.html`、`src/main.ts`、`src/App.svelte`）、`webapp/package.json`、`webapp/vite.config.ts`
- Modify: 根 `.gitignore`（加 `webapp/node_modules/`）

**Interfaces:**
- Consumes: 现有 `src/web/index.html` 的 token 注入结构
- Produces: 可用的构建链与定稿 `vite.config.ts`（后续所有前端任务的构建基础）；findings 记录 svelte/vite 版本

- [ ] **Step 1: 脚手架探针**：`webapp/vite.config.ts`——`root` 默认、`build.outDir: "../src/web"`、`build.emptyOutDir: true`、`build.rollupOptions.output.entryFileNames: "assets/board.js"`、`chunkFileNames: "assets/board.js"`、`assetFileNames: "assets/board.[ext]"`；探针 `App.svelte` 渲染一行文本 + 一个 `$state` 计数按钮（验证 Svelte 5 runes 编译）
- [ ] **Step 2: 构建并断言占位符**：`webapp/index.html` 含 `<script>window.__TASKBOARD_TOKEN__ = "__TASKBOARD_TOKEN_VALUE__";</script>`（内联经典脚本，置于 module script 之前）；构建后 `grep -c __TASKBOARD_TOKEN_VALUE__ ../src/web/index.html` ≥1
- [ ] **Step 3: 回退路径验证**：`bun x vite build` 失败则 `node node_modules/.bin/vite build` 重试；记录实际可用命令到 findings
- [ ] **Step 4: 真实伺服验证**：`opencode service restart` 后 playground 激活插件，`curl http://127.0.0.1:4370/` 返回构建页且含注入的 token 值
- [ ] **Step 5: Commit** `chore: 🔧 svelte 构建链 spike 探针`

### Task 2: 旧前端退役

**Files:**
- Delete: `src/web/index.html`、`src/web/app.js`、`src/web/style.css`、`src/web/viewmodel.js`、`test/viewmodel.test.ts`

**Interfaces:**
- Consumes: Task 1 构建产物已落位 `src/web/`
- Produces: 无死代码的仓库

- [ ] **Step 1**: 删除上列 5 个文件
- [ ] **Step 2**: `bun test` 全绿（61→58）；`grep -r boardKey src/ test/ webapp/` 零命中
- [ ] **Step 3: Commit** `chore: 🔥 移除 vanilla 前端与渲染守卫`

### Task 3: 服务端 SSE 契约（TDD）

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-sse.test.ts`（新建）

**Interfaces:**
- Consumes: `Store`（现有）、`ServerHandle`（现有）
- Produces:
  ```ts
  type ServerEvent = { type: "hello" } | { type: "snapshot"; tasks: Task[]; settings: BoardSettings }
  // ServerHandle 增加: emit(event: ServerEvent): void
  // GET /api/events → text/event-stream；事件 data: JSON；心跳 ": ping\n\n" 每 25s；第 33 连接 503
  ```
- 步骤中的「写分支」指 `api()` 内全部变更端点（POST/PUT /api/settings、POST /api/tasks、PATCH/DELETE /api/tasks/:id、POST /api/claim、POST /api/tasks/:id/{analyze,complete,release,notes}）

- [ ] **Step 1: 写失败测试**（fetch + ReadableStream 读 SSE）：
  - 连接后首事件为 `hello`；随后 `POST /api/tasks` 成功后流上出现 `snapshot` 且 `tasks` 含新任务、`settings` 在场
  - 建立第 33 个连接返回 503
  - `AbortController` 中止后服务端订阅计数回落（通过再次建连仍正常验证）
  - `GET /no-such` 于 `webDir` 缺失时仍为 404 JSON（Review Focus 4）
- [ ] **Step 2**: `bun test test/server-sse.test.ts` → FAIL
- [ ] **Step 3**: 实现——`createServer` 内 `subscribers = new Set<Controller>`；`/api/events` 分支建 `ReadableStream` 推 `hello` + 当前 `store.list()`/`store.getSettings()` 快照；8 个写分支成功路径调用 `emit({type:"snapshot", ...})`；`req.signal` abort 时清理；25s `setInterval` 心跳（cleanup 时清除）；`serveStatic` 两处 Response 加 `Cache-Control: no-cache`
- [ ] **Step 4**: `bun test` 全绿
- [ ] **Step 5: Commit** `feat: 📡 SSE 事件流与静态 no-cache`

### Task 4: 前端脚手架 + 主题系统（L2）

**Files:**
- Create: `webapp/src/{main.ts,app.css,theme.ts}`、`webapp/src/App.svelte`（布局壳）、`webapp/src/lib/types.ts`（Task/BoardSettings/Status 前端副本，与 `src/types.ts` 字段一致）
- Modify: `webapp/vite.config.ts`（Task 1 定稿保留）

**Interfaces:**
- Consumes: Task 1 构建链
- Produces:
  ```ts
  // theme.ts
  export const themeMode: Writable<"auto" | "light" | "dark">  // localStorage key "taskboard-theme"，默认 "auto"
  ```
- 布局壳：Header 区（本任务静态占位）+ `<main id="board">` 七列 grid（`repeat(7, minmax(168px, 1fr))`）

- [ ] **Step 1**: CSS 变量双主题（暗色沿用现 `src/web` 色板基准确保观感不倒退；亮色新配）；`[data-theme]` 属性驱动；`prefers-color-scheme` 响应 `auto`
- [ ] **Step 2**: 主题循环切换 `auto→light→dark`，持久化并在刷新后还原
- [ ] **Step 3**: 构建 + 真实实例目检三态
- [ ] **Step 4: Commit** `feat: 🎨 前端脚手架与双主题系统`

### Task 5: Header 三件套（L2'）

**Files:**
- Create: `webapp/src/lib/api.ts`、`webapp/src/components/Header.svelte`、`webapp/src/components/StatusDot.svelte`
- Modify: `App.svelte` 接线

**Interfaces:**
- Consumes: Task 4 布局壳、Task 3 快照契约
- Produces:
  ```ts
  // api.ts —— 全前端唯一 API 入口；非 2xx 抛 BoardApiError { code, message }
  export class BoardApiError extends Error { code: string }
  export async function fetchBoard(): Promise<{ tasks: Task[]; settings: BoardSettings }>
  export function createTask(title: string, description?: string): Promise<Task>
  export function patchTask(id: string, patch: Record<string, unknown>): Promise<Task>
  export function deleteTask(id: string): Promise<void>
  export function putSettings(requireAnalysisConfirm: boolean): Promise<BoardSettings>
  export type ConnState = "live" | "reconnecting" | "polling"
  ```
- Header：新建表单（回车提交、空标题禁用）、「分析需人工确认」开关（change 即 PUT，失败回弹 + toast 占位）、StatusDot 三态色（本任务接假状态，Task 9 换真）

- [ ] **Step 1**: api.ts 实现（headers 带 token + JSON；`fetchBoard` 合并 GET tasks+settings）
- [ ] **Step 2**: Header 组件接线；Mock 下人工验证建任务/开关
- [ ] **Step 3: Commit** `feat: ✨ Header 新建任务与设置开关`

### Task 6: 看板渲染核心（L2'，分组纯函数 TDD）

**Files:**
- Create: `webapp/src/lib/board.ts`、`webapp/test/board.test.ts`、`webapp/src/components/{Board,Column,Card}.svelte`
- Modify: `App.svelte`

**Interfaces:**
- Consumes: Task 4/5
- Produces:
  ```ts
  // board.ts
  export const STATUSES: readonly Status[]  // 七态，列顺序 verbatim：待规划/待领取/分析中/分析确认/执行中/完成确认/已完成
  export const STATUS_LABELS: Record<Status, string>
  export function groupByStatus(tasks: Task[]): Record<Status, Task[]>  // 列内 updatedAt 倒序
  export function timeAgo(ts: number): string  // "刚刚/N 分钟前/N 小时前/日期"
  ```

- [ ] **Step 1: RED**——`groupByStatus` 分组/倒序/空列、`timeAgo` 边界（<60s 刚刚、<60m、<24h、更早）断言；`bun test webapp/test/board.test.ts` FAIL
- [ ] **Step 2: GREEN** 实现
- [ ] **Step 3**: 三组件渲染：keyed `{#each}`、卡片信息层级（标题→描述→📌分析→✅结果→claim（human 显示「👤 用户执行中」）→评论数→`timeAgo`）；卡片可 focus（`tabindex="0"`）
- [ ] **Step 4**: 空状态（列空时灰字提示「暂无任务」）与首载骨架屏（快照到达前卡片形占位闪烁）
- [ ] **Step 5**: 构建后 Mock 目检七列与样例数据
- [ ] **Step 6: Commit** `feat: ✨ 七列看板渲染与分组纯函数`

### Task 7: Pointer 拖拽系统（Phase D）

**Files:**
- Create: `webapp/src/lib/drag.ts`
- Modify: `Card.svelte`、`Column.svelte`、`Board.svelte`

**Interfaces:**
- Consumes: Task 6 组件、`patchTask`（api.ts）
- Produces:
  ```ts
  // drag.ts
  export function createDragController(opts: {
    onDrop(taskId: string, toStatus: Status): void
    getState(): { draggingId: string | null; overStatus: Status | null }
  }): { bindCard(el: HTMLElement, taskId: string): void; cleanup(): void }
  ```

- [ ] **Step 1**: Pointer Events 实现——pointerdown 记录、位移 ≥4px 才启动拖拽、`setPointerCapture`、拖影（原卡片 clone 固定定位跟随光标、原位 opacity .4）、目标列高亮、up 结算回调、Esc 取消、`prefers-reduced-motion: reduce` 时去动画
- [ ] **Step 2**: drop → `patchTask(id, {status})`；非本人认领的 analyzing/executing 卡片禁用拖拽（`claim.agent !== "human" && status ∈ {analyzing, executing}` 时 `bindCard` 不绑或忽略启动）——防误抢 Agent 任务
- [ ] **Step 3**: Mock 全列间拖拽目检；无效 drop 不发包
- [ ] **Step 4: Commit** `feat: ✋ Pointer 拖拽与目标反馈`

### Task 8: 乐观更新协议状态机（L3，TDD，纯 TS 零框架依赖）

**Files:**
- Create: `webapp/src/lib/optimistic.ts`、`webapp/test/optimistic.test.ts`

**Interfaces:**
- Consumes: 仅 `webapp/src/lib/types.ts`（Task/BoardSettings/Status）+ 本计划冻结的契约
- Produces:
  ```ts
  export type BoardState = {
    server: Task[]                     // 最近一次服务器快照（事实源）
    settings: BoardSettings
    pending: Map<string, Partial<Task>> // taskId → 在途遮罩
  }
  export function emptyState(settings: BoardSettings): BoardState
  export function applySnapshot(state: BoardState, tasks: Task[], settings: BoardSettings): BoardState
  export function beginOptimistic(state: BoardState, taskId: string, patch: Partial<Task>): BoardState
  export function settle(state: BoardState, taskId: string, ok: boolean): BoardState
  export function visibleTasks(state: BoardState): Task[]
  ```
- 协议 5 规则（Review Focus 2/3 的钉子在此）：① `applySnapshot` 先落 `server` 再用 pending 遮罩覆盖合成视图（在途期间不被回流覆盖）② 写成功后快照到达且字段一致 → `settle(ok)` 摘遮罩 ③ `settle(false)` 该任务视图回滚到 `server` 中的最近快照 ④ 多任务并发互不影响 ⑤ 遮罩以字段级覆盖（`Partial<Task>` 合并）
- 不可变更新（每函数返回新对象），组件侧 `$derived` 消费

- [ ] **Step 1: RED**——按 5 规则 + 边界（同任务连续两次乐观写、settle 未知 taskId 容错、`visibleTasks` 对不存在任务忽略遮罩）写测试；FAIL
- [ ] **Step 2: GREEN** 实现；测试全绿
- [ ] **Step 3: Commit** `feat: 🔀 乐观更新状态机与遮罩协议`

### Task 9: SSE 客户端 + 轮询兜底（Phase D）

**Files:**
- Create: `webapp/src/lib/events.ts`
- Modify: `App.svelte`（状态源切换为 `BoardState`）、`StatusDot.svelte` 接真状态

**Interfaces:**
- Consumes: Task 3 事件契约、Task 8 状态机、api.ts `fetchBoard`
- Produces:
  ```ts
  // events.ts
  export function connectEvents(handlers: {
    onSnapshot(tasks: Task[], settings: BoardSettings): void
    onStatus(s: ConnState): void
  }): () => void   // 返回卸载函数
  ```

- [ ] **Step 1**: **RED 测试**（EventSource 以注入 fake 实现）：断连恢复后收到的首快照使状态一致（Review Focus 1）；连续失败降级 5s 轮询、30s 对账恒开；`bun test` FAIL
- [ ] **Step 2**: **GREEN 实现**——EventSource `/api/events`；`onopen`→live；`onerror`→reconnecting（EventSource 自带重连）；连续 3 次失败降级轮询；重连成功回 live；返回卸载函数清理全部定时器
- [ ] **Step 3**: 快照一律经 `applySnapshot` 进状态；本地所有写操作 = `beginOptimistic` → api 调用 → `settle(ok)`；失败 toast 错误信息
- [ ] **Step 4**: 测试全绿 + Mock 目检
- [ ] **Step 5: Commit** `feat: 📡 SSE 实时与轮询兜底接线`

### Task 10: Toast + ConfirmDialog（L4）

**Files:**
- Create: `webapp/src/components/{Toasts,ConfirmDialog}.svelte`、`webapp/src/lib/notify.ts`

**Interfaces:**
- Consumes: Task 4 主题变量
- Produces:
  ```ts
  // notify.ts
  export const toasts: Writable<{ id: number; kind: "success" | "error"; text: string }[]>
  export function notify(kind: "success" | "error", text: string): void   // 4s 自动消失
  export function confirmDialog(title: string, body: string): Promise<boolean>  // 替代 window.confirm；Esc=取消
  ```

- [ ] **Step 1**: 组件 + 状态实现；Toasts 挂 App 根、ConfirmDialog 单例
- [ ] **Step 2**: Mock 目检：多条堆叠、hover 暂停自动消失、Tab/Esc 键盘环、成功/错误两态样式
- [ ] **Step 3: Commit** `feat: 💬 toast 通知与确认弹层`

### Task 11: 任务详情侧滑面板（Phase D）

**Files:**
- Create: `webapp/src/components/TaskDetail.svelte`
- Modify: `Board.svelte`（点击卡片/Enter 打开）、`Card.svelte`（操作按钮接面板）

**Interfaces:**
- Consumes: Task 5 api.ts、Task 6 组件、Task 8 协议、Task 10 组件
- Produces: 无新导出（纯组件）

- [ ] **Step 1**: 右侧滑入（`transition:fly`）、Esc 关闭、打开时焦点入面板
- [ ] **Step 2**: 全字段：title/description 行内编辑（失焦保存、Esc 还原、空标题还原不保存）；analysis/result 只读区；完整评论流 + 添加评论（`patchTask(id, {action:"comment", comment})`）；按状态渲染操作：确认列 → 通过/打回（打回弹必填评论，复用确认弹层模式）、全程 → 编辑/删除（`confirmDialog` 后 `deleteTask`）；claim 与 createdAt/updatedAt `timeAgo` 展示
- [ ] **Step 3**: 全部写走乐观协议；快速双击「通过」第二次失败 → toast + 状态一致（Review Focus 2 接线验收）
- [ ] **Step 4**: Mock 全操作闭环目检（含键盘：Tab 入卡 → Enter 开 → Esc 关）
- [ ] **Step 5: Commit** `feat: 📋 任务详情侧滑面板与全操作`

### Task 12: 集成验收与收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（§8 重写 + §11 安装说明）、`README.md`（构建说明）
- Test: 验收记录追加 `docs/superpowers/plans/2026-10-16-taskboard-spike-findings.md`

- [ ] **Step 1**: dev Mock 全功能回归（建/拖/编辑/评论/打回/删除/开关/主题）
- [ ] **Step 2**: 真实 playground 验收：Agent 闭环 + 网页实时反映（SSE <1s）；双实例（次要端口页面写经代理 + 本页收到广播，Review Focus 5）；服务重启 → EventSource 自动重连 + 状态点恢复
- [ ] **Step 3**: `bun test` 全绿；`git status` 干净（产物已入库）
- [ ] **Step 4**: spec §8 重写（Svelte 5 决策、推翻「无框架」的理由与代价）+ §11（产物入库、用户安装仍只需 `src/`+装载器）；README 加「前端开发：`bun run dev:web`（HMR）/ `bun run build:web`」
- [ ] **Step 5: Commit** `docs: 📝 前端重构验收与 spec 修订`；终审子代理整分支复审 + 修复轮
