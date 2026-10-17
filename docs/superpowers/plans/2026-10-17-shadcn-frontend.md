# shadcn-svelte + Tailwind v4 前端重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `webapp/` 前端彻底重写为 shadcn-svelte + Tailwind v4（显示层 + 逻辑层 + 测试），布局骨架与交互行为不变。

**架构：** Tailwind v4 经 vite 插件接管样式，shadcn CLI 组件落入 `src/lib/components/ui/`；拖拽由 svelte-dnd-action 接管（跨泳道 = patch status，同泳道弹回）；lib 纯函数层按既有行为复刻重写并保留现有测试为回归基线；组件自底向上覆盖重写（props 兼容，中间态可编译）。

**技术栈：** Svelte 5.57 / Vite 8.3 / tailwindcss 4.3.3 + @tailwindcss/vite / shadcn-svelte 1.7.0（bits-ui 2.19.5）/ svelte-dnd-action 0.9.80 / svelte-sonner 1.2.1 / @tailwindcss/typography 0.5.20

**规格：** `docs/superpowers/specs/2026-10-17-shadcn-frontend-design.md`（执行者两份都读）

## 全局约束

- `bun test` 是唯一验收门；无 lint/格式化器/CI，`tsc --noEmit` 不可用，**别声称 typecheck 通过**。
- 改了 `webapp/` 就必须 `bun run build:web` 并把 `src/web/` 产物与源码一起提交（任务 1/2/8/9 的验收步骤已含；任务 3–7 期间产物暂坏属分支内预期，任务 8 恢复）。
- `webapp/vite.config.ts` 中 `outDir: "../src/web"`、`emptyOutDir: true`、产物文件名 `assets/board.js`/`assets/board.[ext]`、`server.proxy` `/api`→4370 **一字不动**；本计划只允许追加 tailwindcss 插件与 `$lib` 别名。
- `webapp/index.html` 的 `__TASKBOARD_TOKEN_VALUE__` 占位符与 dev 兜底**一字不动**。
- 服务端 `src/` 不改；API 契约不改；**不新增**泳道内排序持久化。
- 注释、UI 文案、测试描述、提交信息一律中文；提交用中文约定式提交带 emoji（如 `feat: 🎨 …`）。
- shadcn 生成的 `src/lib/components/ui/` 内部文件不手改；业务逻辑一律进 `lib/` 纯函数并配测试。
- 卡片与泳道不用 svelte transition（与 dnd 库冲突）；动效走 CSS / tw-animate-css。
- webapp 的包管理器是 bun；所有 `bun x` / `bun add` 在 `webapp/` 目录执行。

## 审查重点（Review Focus）

1. 详情编辑中 SSE 快照到达 → 不得顶掉输入（editing 让路）：任务 7 步骤照抄旧逻辑，任务 9 清单第 5 项验证。
2. 断网/失败下乐观写 → settle 回滚 + 红闪、遮罩不残留：任务 4 的 optimistic 基线断言钉住，任务 9 清单第 7 项验证。
3. `api.ts` 顶层触碰 `window` → bun 测试环境无 DOM 直接炸：任务 4 新增 `test/api.test.ts` 钉住。
4. 任务状态已被他端改变（`invalid_transition`）→ toast 人话提示而非原始错误码：任务 8 保留 `friendlyError`，任务 9 清单第 9 项验证。
5. 空看板/空泳道与首屏骨架 → 不白屏、空文案引导创建：任务 6 的 empty 文案与任务 8 的 Skeleton 骨架屏，board 基线断言钉住分组完整性。

---

### 任务 1：工程基座（Tailwind v4 + shadcn init + 主题改 .dark 类）

**文件：**
- 创建：`webapp/tsconfig.json`、`webapp/components.json`（CLI 生成）、`webapp/src/lib/utils.ts`（CLI 生成）
- 修改：`webapp/vite.config.ts`、`webapp/src/app.css`（整体重写）、`webapp/src/theme.ts`、`webapp/package.json`（CLI/依赖写入）
- 测试：现有 `webapp/test/*` 全部不动（回归基线）

- [ ] **步骤 1：安装 Tailwind v4**

```bash
cd webapp && bun add -d tailwindcss @tailwindcss/vite
```

- [ ] **步骤 2：创建 `webapp/tsconfig.json`**（仅供 shadcn CLI 与 IDE，不 extends 根 tsconfig——根 tsconfig 依赖未安装的 bun-types）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "$lib": ["./src/lib"], "$lib/*": ["./src/lib/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "test/**/*.ts"]
}
```

- [ ] **步骤 3：`webapp/vite.config.ts` 追加插件与别名**——顶部 `import path from "path"` 与 `import tailwindcss from "@tailwindcss/vite"`；`plugins: [tailwindcss(), svelte()]`；新增 `resolve: { alias: { $lib: path.resolve("./src/lib") } }`。其余键（server.proxy、build.*）一字不动。

- [ ] **步骤 4：`webapp/src/app.css` 整体重写为 `@import "tailwindcss";`**

- [ ] **步骤 5：运行 shadcn init**（交互答案钉死，与官方 Vite 指南一致）

```bash
cd webapp && bun x shadcn-svelte@latest init
```

答案：base color = **Slate**；global CSS = **src/app.css**；lib alias = **$lib**；components = **$lib/components**；utils = **$lib/utils**；hooks = **$lib/hooks**；ui = **$lib/components/ui**。

- [ ] **步骤 6：自检 init 产出**——`components.json` 入库且 alias 为上一步取值；`app.css` 含 `@custom-variant dark` 与 `:root`/`.dark` 令牌块及 `@theme inline`；`src/lib/utils.ts` 导出 `cn`。

- [ ] **步骤 7：`webapp/src/theme.ts` 改写主题落点**——`apply` 改为 `document.documentElement.classList.toggle("dark", resolveTheme(mode) === "dark")`；`onSystemChange` 同步改为 classList 写法。`ThemeMode`/`themeMode`/`cycleThemeMode`/`initTheme` 签名与 localStorage 逻辑不变（本任务不新增 `setThemeMode`，任务 8 再加）。

- [ ] **步骤 8：验收**

```bash
cd webapp && bun test          # 预期：全部 PASS（旧测试未动）
bun run build:web              # 预期：成功，src/web/assets/board.js 与 board.css 生成
```

- [ ] **步骤 9：Commit**

```bash
git add webapp src/web
git commit -m "feat: 🎨 前端重构基座——Tailwind v4 接入与 shadcn-svelte 初始化"
```

### 任务 2：装入 shadcn 组件与扩展令牌

**文件：**
- 生成：`webapp/src/lib/components/ui/**`（button badge card dialog alert-dialog sheet switch dropdown-menu input textarea label table scroll-area skeleton separator sonner spinner tooltip）
- 修改：`webapp/src/app.css`、`webapp/package.json`

- [ ] **步骤 1：装入组件**

```bash
cd webapp && bun x shadcn-svelte@latest add button badge card dialog alert-dialog sheet switch dropdown-menu input textarea label table scroll-area skeleton separator sonner spinner tooltip
```

- [ ] **步骤 2：安装 typography 插件**：`cd webapp && bun add -d @tailwindcss/typography`

- [ ] **步骤 3：`app.css` 追加扩展令牌与插件**——在 shadcn 令牌块后追加（明暗同值，明暗对比问题留给任务 9 视觉验收再调）：

```css
@plugin "@tailwindcss/typography";

:root {
  --warning: oklch(0.769 0.188 70.08);            /* amber-500 */
  --warning-foreground: oklch(0.279 0.077 45.635); /* amber-950 */
  --success: oklch(0.627 0.194 149.214);           /* green-600 */
  --success-foreground: oklch(0.985 0 0);
}
.dark {
  --warning: oklch(0.769 0.188 70.08);
  --warning-foreground: oklch(0.279 0.077 45.635);
  --success: oklch(0.627 0.194 149.214);
  --success-foreground: oklch(0.985 0 0);
}
```

并在 `@theme inline` 块内按既有 `--color-*: var(--*)` 模式追加 `--color-warning`、`--color-warning-foreground`、`--color-success`、`--color-success-foreground` 四行。

- [ ] **步骤 4：验收**——`cd webapp && bun test` 全绿；`bun run build:web` 成功。

- [ ] **步骤 5：Commit**

```bash
git add webapp src/web
git commit -m "feat: 🎨 装入 shadcn 组件与 warning/success 扩展令牌"
```

### 任务 3：逻辑层重写——基础纯函数 + drop.ts

**文件：**
- 删除：`webapp/src/lib/lane.ts`、`webapp/src/lib/drag.svelte.ts`、`webapp/test/lane.test.ts`
- 复刻重写（以现文件为规格逐字重写，注释含 markdown.ts 安全红线一并保留）：`webapp/src/lib/types.ts`、`board.ts`、`duration.ts`、`usage.ts`、`markdown.ts`
- 新增：`webapp/src/lib/drop.ts`、`webapp/test/drop.test.ts`
- 基线测试（断言不改动）：`webapp/test/board.test.ts`、`duration.test.ts`、`usage.test.ts`、`markdown.test.ts`

- [ ] **步骤 1：删除 lane.ts / drag.svelte.ts / lane.test.ts**——前两者的职责移交 svelte-dnd-action（任务 6）。此后 `bun run build:web` 暂坏（旧组件仍引用 drag），`bun test` 不受影响，属分支内预期。

- [ ] **步骤 2：编写失败测试 `webapp/test/drop.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { dropTask } from "../src/lib/drop"

describe("dropTask——拖拽落点判定", () => {
  test("同泳道返回 null（弹回，不发热请求）", () => {
    expect(dropTask("pending", "pending")).toBeNull()
  })
  test("跨泳道返回目标状态", () => {
    expect(dropTask("pending", "analyzing")).toEqual({ status: "analyzing" })
  })
  test("相邻泳道 planning → pending", () => {
    expect(dropTask("planning", "pending")).toEqual({ status: "pending" })
  })
})
```

- [ ] **步骤 3：运行验证失败**

运行：`cd webapp && bun test test/drop.test.ts`
预期：FAIL，报模块 `../src/lib/drop` 不存在

- [ ] **步骤 4：实现 `drop.ts`**

签名：`export function dropTask(fromStatus: Status, toStatus: Status): { status: Status } | null`——同泳道返回 `null`，否则返回 `{ status: toStatus }`。状态转移合法性由服务端校验，前端不做转移表。

- [ ] **步骤 5：运行验证通过**——`cd webapp && bun test test/drop.test.ts` → 3 个用例 PASS

- [ ] **步骤 6：复刻重写五个基础纯函数文件**——types/board/duration/usage/markdown 以当前实现为唯一规格（签名、常量、中文注释逐字保留；markdown.ts 的安全红线三条注释是刻意行为说明，必须随文件保留）。测试断言不动，作为回归网。

- [ ] **步骤 7：运行全量测试**

运行：`cd webapp && bun test`
预期：全部 PASS（含既有 board/duration/usage/markdown 基线）

- [ ] **步骤 8：Commit**

```bash
git add webapp
git commit -m "refactor: ♻️ 逻辑层基础纯函数复刻重写——新增 drop 落点判定，移交拖拽职责"
```

### 任务 4：逻辑层重写——网络与状态时序层

**文件：**
- 删除后复刻重写：`webapp/src/lib/api.ts`、`events.ts`、`optimistic.ts`
- 修改：`webapp/src/lib/notify.ts`（sonner 化）
- 原样保留：`webapp/src/lib/ticker.svelte.ts`
- 新增：`webapp/test/api.test.ts`
- 基线测试（断言不改动）：`webapp/test/optimistic.test.ts`、`events.test.ts`

- [ ] **步骤 1：删除 api.ts / events.ts / optimistic.ts，编写失败测试 `webapp/test/api.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { BoardApiError } from "../src/lib/api"

describe("api 模块", () => {
  test("无 DOM 环境可加载——顶层不碰 window（惰性读取令牌）", () => {
    expect(typeof globalThis.window).toBe("undefined")
    expect(new BoardApiError("forbidden", "令牌失配").code).toBe("forbidden")
  })
})
```

- [ ] **步骤 2：运行验证失败**——`cd webapp && bun test test/api.test.ts` → FAIL（模块不存在）

- [ ] **步骤 3：复刻重写 `api.ts`**——签名与行为逐字保留：`BoardApiError(code, message)`；`headers()` 惰性读 `window.__TASKBOARD_TOKEN__`（注释「模块加载期不碰 window」必须保留）；`request` 的非 2xx 错误体解析（`body.error.code`/`body.error.message`，非 JSON 回落 `HTTP <status>`）；`fetchBoard` 并发拉 tasks+settings；`createTask/patchTask/deleteTask/putSettings`；`export type ConnState = "live" | "reconnecting" | "polling"`。

- [ ] **步骤 4：复刻重写 `events.ts`**——`EventsDeps` 可注入接口、常量 `RECON_SEC = 5`、`RECONCILE_SEC = 30`、`FAILURE_THRESHOLD = 3`、`connectEvents(handlers, deps?)` 返回清理函数，全部逐字保留。基线 `events.test.ts` 不改。

- [ ] **步骤 5：复刻重写 `optimistic.ts`**——`BoardState`、`emptyState/applySnapshot/beginOptimistic/settle/visibleTasks` 与 settle 时序契约注释逐字保留。基线 `optimistic.test.ts` 不改。

- [ ] **步骤 6：重写 `notify.ts`**——删除 `toasts` store 与手动定时器全家（sonner 接管展示）；保留并逐字复刻 `confirmState`/`confirmDialog`/`settleConfirm`（连续调用覆盖策略注释保留）。`notify` 新形态：

签名：`export function notify(kind: "success" | "error", text: string): void`——实现调 `svelte-sonner` 的 `toast.success(text, { duration: 4000 })` / `toast.error(text, { duration: 4000 })`。

- [ ] **步骤 7：确认 `ticker.svelte.ts` 无 drag 依赖、原样保留**

- [ ] **步骤 8：运行全量测试**

运行：`cd webapp && bun test`
预期：全部 PASS（含 api/optimistic/events 基线与新 api 用例）

- [ ] **步骤 9：Commit**

```bash
git add webapp
git commit -m "refactor: ♻️ 网络与状态时序层复刻重写——toast 改 sonner，确认弹层改 store 驱动"
```

### 任务 5：显示层——StatusDot 与 Card

**文件：**
- 覆盖重写：`webapp/src/components/StatusDot.svelte`、`webapp/src/components/Card.svelte`
- 测试：`cd webapp && bun test`（现有用例全过即可；组件无单测）

- [ ] **步骤 1：重写 `StatusDot.svelte`**——props：`let { state }: { state: ConnState } = $props()`。三态渲染（圆点 + 中文文案）：`live`→绿点（bg-success）「实时」；`reconnecting`→黄点（bg-warning）「重连中」；`polling`→红点（bg-destructive）「轮询中」。圆点 `size-2 rounded-full`，整体 `inline-flex items-center gap-1.5 text-xs text-muted-foreground`。

- [ ] **步骤 2：重写 `Card.svelte`——props 与旧版逐字一致**：`task/onopen/onconfirm/onquickreject/pendingIds/flashIds/onmove`（回调均可选）。根元素 `<article>`，`w-60 rounded-lg border bg-card p-3 grid gap-1.5 text-sm`，`data-status={task.status}`。

- [ ] **步骤 3：shadow 态**——`import { SHADOW_ITEM_MARKER_PROPERTY_NAME } from "svelte-dnd-action"`；`const isShadow = $derived((task as Record<symbol, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true)`。isShadow 时：容器 `opacity-50`，内部按钮 `pointer-events-none`。

- [ ] **步骤 4：状态视觉（令牌映射）**——左缘色带 `border-l-4`：`analyzing/executing`→`border-l-primary`；`analysis_confirm/completion_confirm`→`border-l-warning`；`done`→`border-l-muted-foreground/40` 且整卡 `opacity-80`。状态签（Badge variant="outline" 内含圆点）圆点色同映射；排队文案与 `queueLine` 用 `text-warning`。

- [ ] **步骤 5：快速操作**——确认列（analysis_confirm/completion_confirm）hover/focus-within 显隐（`hidden group-hover:flex group-focus-within:flex`，卡片加 `group`）：通过 = `Button size="sm"`、打回 = `Button size="sm" variant="destructive"`，均 `stopPropagation`。

- [ ] **步骤 6：在途与失败视觉**——`inflight`（pendingIds 含该卡）→ `opacity-60 animate-pulse`；`fail-flash`（flashIds 含该卡）→ 组件内 scoped `<style>` 定义 `@keyframes fail-flash`（`0%,45% box-shadow: 0 0 0 3px var(--destructive)` → `100% none`，0.6s ease-out）。

- [ ] **步骤 7：meta 行与文案照抄旧版**——`formatPhaseLine`/`queueLine`/`usageLine`/`timeAgo`/claim 文案/💬 计数，`tabular-nums`（`tabular-nums` 工具类）、描述与 analysis/result 摘要 `line-clamp-2`，Emoji 前缀（📌✅📊⏳💬👤🤖）保留。

- [ ] **步骤 8：键盘与禁拖视觉**——`tabindex="0"`、`role="button"`、`aria-label={\`查看任务：${task.title}\`}`；Enter → `onopen`；`Alt+ArrowUp/ArrowDown`（无 Ctrl/Meta/Shift）→ `onmove(task, ±1)`，preventDefault。Agent 认领中的 analyzing/executing：`cursor-not-allowed` + `title="正由 Agent 处理，不能移动"`（禁止拖拽的强制在 Lane 层，见任务 6）。

- [ ] **步骤 9：验收**——`cd webapp && bun test` 全绿（build 仍暂坏：旧 Lane.svelte 尚引用已删的 drag.svelte.ts，属预期）。

- [ ] **步骤 10：Commit**

```bash
git add webapp/src/components
git commit -m "feat: 🎨 Card 重写为 shadcn 风格——shadow 态、状态令牌色带与快速操作保留"
```

### 任务 6：显示层——Lane（dndzone 接线）与 Board

**文件：**
- 覆盖重写：`webapp/src/components/Lane.svelte`、`webapp/src/components/Board.svelte`

- [ ] **步骤 1：重写 `Lane.svelte`——props**：`status/label/tasks/empty/onopen/onconfirm/onquickreject/onmove/pendingIds/flashIds` 照旧，**新增可选** `ondrop?: (taskId: string, toStatus: Status) => void`（可选保证旧 App 中间态可编译）。卡片容器加 `group/lane`。

- [ ] **步骤 2：本地 items 副本**（库要求 host 回写 items，而 tasks 是派生 prop）：

```ts
import { dndzone, type DndEvent } from "svelte-dnd-action"
import { dropTask } from "../lib/drop"
let items = $state<Task[]>([])
$effect(() => { items = tasks }) // 快照到达（tasks 引用变化）时重置本地副本
```

- [ ] **步骤 3：泳道容器接线**——卡片容器元素：`use:dndzone={{ items, flipDurationMs: 150, dropTargetStyle: { outline: "2px solid var(--primary)", outlineOffset: "-2px" } }}`；事件用 Svelte 5 形式 `onconsider={handleConsider}` / `onfinalize={handleFinalize}`；`type` 缺省（同默认类型即可跨泳道）。

- [ ] **步骤 4：`handleConsider`**——`items = e.detail.items`（纯视觉重排预览）。

- [ ] **步骤 5：`handleFinalize`**（非法拖拽的强制点；钉死实现）：

```ts
function handleFinalize(e: DndEvent<Task>) {
  const dragged = e.detail.items.find((t) => t.id === e.detail.info.id)
  if (!dragged) { items = e.detail.items; return }            // 源泳道：采纳移除后的新序
  const from = dragged.status                                  // 对象来自源泳道，status 字段仍是源状态
  const guard = dragged.claim && dragged.claim.agent !== "human"
    && (from === "analyzing" || from === "executing")          // Agent 认领中 → 禁拖
  const patch = guard ? null : dropTask(from, status)
  if (!patch) { items = tasks; return }                        // 同泳道或非法：弹回
  items = e.detail.items
  ondrop?.(dragged.id, patch.status)                           // App 走乐观写通道，快照回来后 items 重置
}
```

非法（guard 命中）时在弹回分支前 `notify("error", "该任务正由 Agent 处理，不能移动")`。

- [ ] **步骤 6：zone 级禁拖**——`const zoneDragDisabled = $derived(tasks.length > 0 && tasks.every((t) => t.claim && t.claim.agent !== "human" && (t.status === "analyzing" || t.status === "executing")))`，并入 dndzone 参数。

- [ ] **步骤 7：泳道壳视觉**——竖直排列的 `<section>`：`rounded-lg border bg-card/50 p-3 flex flex-col gap-2`；泳道头 `h2`（状态圆点（色映射同任务 5 步骤 4）+ label + Badge 计数 variant="secondary"）；卡片流 `flex flex-wrap gap-2.5 min-h-10`；空泳道 `empty` 文案（`text-xs text-muted-foreground`）。内部不使用 svelte transition。

- [ ] **步骤 8：重写 `Board.svelte`**——结构与旧版一致（`groupByStatus` 七泳道 + planning 空文案「看板空空如也——点击右上「＋新建任务」创建第一张卡片」照抄），容器 `mx-auto max-w-7xl flex flex-col gap-2.5 p-4`；新增 `ondrop` 透传给每个 Lane。props 其余照旧。

- [ ] **步骤 9：验收**

```bash
cd webapp && bun test   # 全绿
bun run build:web       # 恢复成功（drag 引用已全部清除）
```

- [ ] **步骤 10：Commit**

```bash
git add webapp
git commit -m "feat: 🎬 Lane 接入 svelte-dnd-action——跨泳道改状态、非法拖拽弹回与 zone 级禁拖"
```

### 任务 7：显示层——TaskDetail（Sheet）

**文件：**
- 覆盖重写：`webapp/src/components/TaskDetail.svelte`

- [ ] **步骤 1：props 与业务函数逐字保留**——`task/onclose/onwrite/ondelete/initialReject`；`saveTitle/saveDescription/confirm/reject/addComment` 与 `editing` 让路逻辑（`$effect`：`!editing` 时同步 title/description）照抄旧版。

- [ ] **步骤 2：Sheet 壳**——`<Sheet.Root open>` 固定开、`<Sheet.Content side="right" class="sm:max-w-[420px] w-[90vw] overflow-y-auto">`；`onEscapeKeyDown` 分层：`rejectOpen` 时 `e.preventDefault()` 仅收起打回表单，否则放行关闭（走 `onOpenChange(false)` → `onclose`）。内容含 `Sheet.Title`（状态 Badge + 标题）与 `Sheet.Description`（sr-only，描述文本）以满足无障碍要求。

- [ ] **步骤 3：编辑字段**——标题 `Input`、描述 `Textarea rows=3`：`onfocus`→`editing = true`；`onblur`→保存；Escape→还原并 blur（照抄旧键位语义）。

- [ ] **步骤 4：分析/结果只读块**——`div` 两列 grid（图标 + 内容，防块级元素挤换行——照抄旧注释），内容用 `Markdown` 组件（保留现 `components/Markdown.svelte`），外层套 `prose prose-sm dark:prose-invert max-w-none break-words`。

- [ ] **步骤 5：计时/消耗两张表**——shadcn `Table`；列头照旧（阶段/开始/结束/用时；项目/token；合计行）；数字列 `tabular-nums text-right`；`phaseViews(task, ticker.now)` 驱动进行中行逐秒刷新。

- [ ] **步骤 6：打回表单与评论**——打回 textarea 必填、取消/打回（`Button variant="destructive" disabled={!rejectComment.trim()}`）；评论列表与添加照旧；`initialReject` 时自动展开并聚焦打回输入。

- [ ] **步骤 7：操作按钮**——通过 = `Button`（bg-success 语义：`class="bg-success text-success-foreground hover:bg-success/90"`）；打回 = `variant="destructive"`；删除 = `variant="outline"`，经 `confirmDialog` 确认后 `ondelete`（照旧）。

- [ ] **步骤 8：验收**——`cd webapp && bun test` 全绿；`bun run build:web` 成功（旧 App 引用 props 兼容）。

- [ ] **步骤 9：Commit**

```bash
git add webapp/src/components/TaskDetail.svelte
git commit -m "feat: 🎨 TaskDetail 改 Sheet——Esc 分层收起、编辑让路与计时段表保留"
```

### 任务 8：显示层——Header、ConfirmDialog 与 App 装配

**文件：**
- 修改：`webapp/src/lib/theme.ts`（追加导出）
- 覆盖重写：`webapp/src/components/Header.svelte`、`webapp/src/components/ConfirmDialog.svelte`、`webapp/src/App.svelte`
- 确认不动：`webapp/src/main.ts`（`initTheme()` 挂载前调用照旧）

- [ ] **步骤 1：`theme.ts` 追加 `export function setThemeMode(mode: ThemeMode): void`**——实现 `themeMode.set(mode)`。

- [ ] **步骤 2：重写 `Header.svelte`**——props 与旧版逐字一致。布局：`sticky top-0 z-10 border-b bg-background px-4 py-2.5 flex items-center gap-4`；左侧 `h1`「任务看板」+ `Button size="sm"`「＋ 新建任务」；右侧 `Switch`×2（分析需人工确认 / 自动领取，title 提示照抄）+ `StatusDot` + 主题 `DropdownMenu`（Trigger 为 `Button variant="ghost" size="sm"` 显示 `modeLabel`；内容用 `DropdownMenuRadioGroup value={mode}` 三项：跟随系统/浅色/深色，`onValueChange` → `oncyclemode` 的位置改接新回调 `onsetmode(mode)`——**props 变更**：删除 `oncyclemode`，新增 `onsetmode: (mode: ThemeMode) => void`）。新建任务弹层改 shadcn `Dialog`：标题 Input 必填、描述 Textarea、取消 + 创建（提交中 `disabled` + 文案「创建中…」）；`oncreate` reject 时保留输入与弹窗（契约照抄）。

- [ ] **步骤 3：重写 `ConfirmDialog.svelte`**——受控 `AlertDialog`：`open` 取自 `confirmState`（`get(confirmState)` + 订阅），`AlertDialogCancel` → `settleConfirm(false)`，`AlertDialogAction` → `settleConfirm(true)`；`onOpenChange(false)` 也走 `settleConfirm(false)`（Esc/遮罩）。标题/正文取 `confirmState.title/body`。

- [ ] **步骤 4：重写 `App.svelte`——脚本段业务函数全部原样保留**：`writeTask/flashFail/friendlyError/moveTask/removeTask/quickConfirm/refresh/changeSettings/handleCreate/handleToggle/handleDrop/openDetail/quickReject/closeDetail/心跳 $effect/onMount 装配`。脚本顶层追加两行全局 dnd 配置：

```ts
import { setKeyboardDragTrigger, setAriaStrings } from "svelte-dnd-action"
setKeyboardDragTrigger("space") // Enter 留给打开详情
setAriaStrings({
  dragStarted: ({ itemLabel }) => `已开始拖动「${itemLabel}」，用方向键移动，Tab 切换泳道，空格放下`,
  movedToPosition: ({ itemLabel, zoneLabel, position }) => `「${itemLabel}」已移至「${zoneLabel}」第 ${position} 位`,
  dropped: ({ itemLabel, zoneLabel, position, count }) => `「${itemLabel}」已放入「${zoneLabel}」，第 ${position} 位，共 ${count} 项`,
})
```

- [ ] **步骤 5：App 模板换装**——`Header`（`onsetmode={setThemeMode}`）；加载中骨架：七组 `Skeleton`（`h-14 w-full rounded-lg` ×若干）替代旧 shimmer；`Board` 新增 `ondrop={handleDrop}`；`TaskDetail/Toasts→<Toaster richColors position="bottom-right" />`（`import { Toaster } from "$lib/components/ui/sonner"`）+ 新 `ConfirmDialog`。模板不用 svelte transition（Sheet/Dialog 自带动画）。

- [ ] **步骤 6：手工冒烟**——`bun run dev`（终端 1）+ `bun run dev:web`（终端 2，浏览器开 Vite 端口）：创建任务→编辑→拖拽跨泳道→同泳道弹回→详情打开/编辑/关闭焦点返还→主题三态切换（`html.dark` 类随之增删）→Toast 出现于右下角。

- [ ] **步骤 7：验收**——`cd webapp && bun test` 全绿；`bun run build:web` 成功。

- [ ] **步骤 8：Commit**

```bash
git add webapp src/web
git commit -m "feat: 🎨 App 装配 shadcn 全家——Header/Dialog/Toaster/骨架屏，dnd 全局配置中文化"
```

### 任务 9：验收与交付

**文件：**
- 修改：`src/web/**`（产物重建）

- [ ] **步骤 1：手工验收清单**（`bun run dev` + `dev:web`，逐项核对规格 §11 回归基线）：

1. 创建任务：成功 / 标题空禁用 / 失败（断网）保留输入与弹窗。
2. 七泳道全路径：领取→分析→（分析确认开关两态）→执行→完成确认→done。
3. 拖拽：跨泳道改状态；同泳道弹回；Agent 认领中卡片弹回 + toast「该任务正由 Agent 处理，不能移动」；placeholder 视觉正常。
4. 键盘：Alt+↑/↓ 跨泳道移动；Enter 开详情；Esc 关抽屉（打回表单开着时先收表单）；Space 键盘拖拽（增强项，可跳过）。
5. 详情抽屉：编辑标题/描述失焦保存；**抽屉开着时让 SSE 推快照（另开终端 `curl -X PATCH` 改别的任务）→ 输入不被顶掉**；计时/消耗表逐秒；评论添加；打回必填；删除二次确认。
6. 主题三态循环 + 刷新持久化 + auto 跟随系统；浅暗两态下确认列琥珀色与通过按钮绿色可读。
7. 断网：连接点变红/黄 → 恢复后快照重同步；断网时点「通过」→ 红闪回滚、无残留遮罩。
8. `opencode service restart` 后真实插件伺服（src/web 产物）完整复走 1–7；token 鉴权正常（改 token 后写操作 403 提示）。
9. 并发冲突：详情开着时 `curl -X PATCH` 同一任务改状态 → 详情内再操作 → toast 显示「任务状态已被其他操作改变…」人话提示而非错误码。

- [ ] **步骤 2：全量测试**——仓库根 `bun test` 全绿（服务端 + webapp）。

- [ ] **步骤 3：产物重建**——`bun run build:web`；`git status` 确认 `src/web/` 变更就绪。

- [ ] **步骤 4：Commit**

```bash
git add src/web
git commit -m "feat: 📦 shadcn 前端产物重建入库"
```

- [ ] **步骤 5：合并回 master**——方式（merge/squash/PR）在执行时与用户确认后进行。
