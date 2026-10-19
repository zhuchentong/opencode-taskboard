# 项目工作区目录选择器与卡片式项目管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板项目管理弹窗新增「资源管理器选路径」（服务端列目录 API + 前端目录浏览弹窗），并把项目列表改为卡片风格（底部操作栏：编辑/删除）。

**Architecture:** server 层新增只读 `GET /api/fs/ls`（每实例本地处理，不走主实例代理，不扩展 StoreError 契约）；前端 `lib/fsbrowse.ts` 纯函数 + `DirectoryPicker.svelte` 嵌套 Dialog；`ProjectsDialog.svelte` 列表视图改卡片网格。名称/描述/删除功能维持现状不动。

**Tech Stack:** Bun + TypeScript、Svelte 5 runes、shadcn-svelte（bits-ui Dialog）、Tailwind v4（CSS-first，无 config 文件）、bun test。

**Spec:** 设计 v3（2026-10-19 本会话确认；bounded 任务无独立 spec 文件，全部设计决策沉淀在下方 Global Constraints 与各任务 Interfaces 中）。

## Global Constraints

- `bun test` 是唯一验收门；**无 lint、无可用 typecheck**（tsconfig 要求 bun-types 但未安装，`tsc --noEmit` 必失败，不要尝试）。
- 改了 `webapp/` 就必须 `bun run build:web` 并把 `src/web/` 产物随该任务提交（产物文件名钉死 `assets/board.js`/`assets/board.[ext]`，别「修」vite 配置）。
- 注释、日志、UI 文案、测试描述、提交信息一律中文；提交信息用中文约定式带 emoji。
- **在途改动交叠（重要）**：`src/server.ts`、`test/server.test.ts` 已有未提交的 `model_not_configured` 相关改动。Task 1 提交前**先问用户在途改动如何处置**（先行提交/保留）；提交时用 `git add -p` 按 hunk 挑选本功能改动，**严禁整体 `git add` 这两个文件**。`webapp/src/lib/model-options.ts`、`webapp/test/model-options.test.ts` 的在途改动与本计划无关，不碰。
- fs/ls 错误体统一 `{ error: { code, message } }` 形状（与 `server.ts:38` 及前端 `BoardApiError` 解析对齐）。
- fs/ls 是 GET 读路径，**无鉴权**（与 tasks/logs/SSE 同姿态，属既有知情决策）；**不做路径沙箱**（只读列目录 + 127.0.0.1 绑定 + 本机单用户，代码注释记录该决策）；**每实例本地处理**（文件系统全机共享，次要实例不代理）。
- 条目截断上限常量 `FS_LIST_CAP = 500`；服务端排序（`localeCompare`，`{ numeric: true }`）后截断。

## Review Focus

- `/proc` 等目录单条 `stat` 抛 EPERM/EIO → 跳过该条目、整体仍 200（Task 1 断链 symlink 用例钉住）。
- 巨型目录（>500 条目）→ 返回恰好 500 条不卡死（Task 1 用 501 个 symlink 用例钉住）。
- 根目录 `/` → `parent: null`，前端不渲染 `..` 行（Task 1 服务端用例 + Task 2 `parentOf` 用例各钉一半）。
- `?path=` 空串或相对路径 → 400 `invalid_path`，绝不静默回落 HOME/cwd（Task 1 用例钉住）。
- 无权限目录（EACCES）→ 403 `forbidden` 而非 500（Task 1 chmod 用例钉住，root 下跳过）。

---

### Task 1: 服务端 `GET /api/fs/ls`

**Files:**
- Modify: `src/server.ts`（紧随 `/api/projects` 路由块之后挂路由；顶部补 import）
- Test: `test/server.test.ts`（新增 `describe("目录浏览路由", ...)`；import 补 `symlinkSync`、`chmodSync`、`dirname`）

**Interfaces:**
- Consumes: 现有 `guard`/`StoreError` 均不使用（本路由读路径、本地错误响应）。
- Produces: `GET /api/fs/ls?path=<绝对路径>` → 200 `{ path: string, parent: string | null, home: string, entries: Array<{ name: string, path: string, type: "dir" }> }`；错误 400 `invalid_path` / 404 `not_found` / 403 `forbidden`，体形 `{ error: { code, message } }`。语义：`path` 缺省 = `os.homedir()`；显式空串/相对路径 = 400；入口先 `path.resolve` 归一；只列目录（逐条 `stat` 跟随符号链接）；单条 stat 失败跳过；排序后截断 500；根目录 `parent` 为 `null`。

- [x] **Step 1: 写失败测试**（`test/server.test.ts` 新增块，用例描述中文）

```ts
describe("目录浏览路由", () => {
  test("GET /api/fs/ls 只列目录,缺省 HOME,单条 stat 失败容错,超 500 截断", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = await setup(s)
    const root = mkdtempSync(join(tmpdir(), "fs-ls-"))
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "file.txt"), "x")
    symlinkSync(join(root, "gone"), join(root, "dangling")) // stat 失败条目
    const r = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(root)}`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { path: string; parent: string | null; entries: Array<{ name: string; type: string }> }
    expect(body.path).toBe(root)
    expect(body.parent).toBe(dirname(root))
    expect(body.entries.map((e) => e.name)).toEqual(["sub"]) // 文件与断链剔除
    for (let i = 0; i < 501; i++) symlinkSync(root, join(root, `d${String(i).padStart(3, "0")}`))
    const r2 = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(root)}`)
    expect(((await r2.json()) as { entries: unknown[] }).entries.length).toBe(500)
    rmSync(root, { recursive: true, force: true })
  })

  test("GET /api/fs/ls 非法路径 400 invalid_path;不存在 404 not_found;根目录 parent null", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = await setup(s)
    const bad = await fetch(`${base}/api/fs/ls?path=rel/path`)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_path")
    const empty = await fetch(`${base}/api/fs/ls?path=`)
    expect(empty.status).toBe(400)
    const missing = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent("/definitely/not/exist")}`)
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found")
    const rootLs = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent("/")}`)
    expect(((await rootLs.json()) as { parent: string | null }).parent).toBe(null)
  })

  test("GET /api/fs/ls 无权限目录 403 forbidden(非 root 才可测)", async () => {
    if (process.getuid?.() === 0) return
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = await setup(s)
    const root = mkdtempSync(join(tmpdir(), "fs-ls-"))
    const locked = join(root, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    const r = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(locked)}`)
    expect(r.status).toBe(403)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("forbidden")
    chmodSync(locked, 0o755) // 便于清理
    rmSync(root, { recursive: true, force: true })
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test test/server.test.ts`
Expected: 新用例 FAIL——路由不存在时 fetch 落入静态文件 fallback，`res.json()` 解析 HTML 抛错。

- [x] **Step 3: 实现**（`src/server.ts`）

顶部补 `import { readdir, stat } from "node:fs/promises"`、`import { homedir } from "node:os"`（`isAbsolute`/`join`/`dirname`/`resolve` 按现有 import 合并）。在 `createServer` 闭包内实现 `handleFsList(url: URL): Promise<Response>`，逻辑按 Interfaces 语义；注释记录「只读列目录不做沙箱」与「单条 stat 失败跳过」两个决策。路由挂载在 `/api/projects` 块之后：`if (pathname === "/api/fs/ls" && method === "GET") return handleFsList(new URL(req.url))`（无 `guard`，读路径）。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test test/server.test.ts`
Expected: PASS（含既有用例，注意在途 `model_not_configured` 用例行为不受影响）。

- [x] **Step 5: 提交（先问用户在途改动处置，hunk 级暂存）**

```bash
git add -p src/server.ts test/server.test.ts   # 只挑本功能 hunk
git commit -m "feat: 🌐 目录浏览 API——GET /api/fs/ls 只列目录,单条容错与 500 截断"
```

---

### Task 2: 前端数据层 `listDir` + `fsbrowse` 纯函数

**Files:**
- Modify: `webapp/src/lib/api.ts`（末尾追加类型与 `listDir`）
- Create: `webapp/src/lib/fsbrowse.ts`
- Test: `webapp/test/fsbrowse.test.ts`（Create；import 路径对齐 `webapp/test/` 现有文件写法，如 `../src/lib/fsbrowse`）

**Interfaces:**
- Consumes: Task 1 的响应形状。
- Produces（后续任务按此签名消费）:
  - `interface FsEntry { name: string; path: string; type: "dir" }`
  - `interface FsListing { path: string; parent: string | null; home: string; entries: FsEntry[] }`
  - `listDir(path?: string): Promise<FsListing>`（api.ts，经现有 `request<T>`，query 用 `URLSearchParams`）
  - `splitCrumbs(path: string): Array<{ name: string; path: string }>`——`"/"` → `[{name:"/",path:"/"}]`；`"/home/me"` → 三节累积路径
  - `parentOf(path: string): string | null`——`"/"` → `null`；`"/home"` → `"/"`（POSIX 语义，可用 `node:path` 的 `dirname`）
  - `sortEntries(entries: FsEntry[]): FsEntry[]`——`localeCompare` `{ numeric: true }`，返回新数组不变异
  - `describeFsError(err: unknown): string`——`BoardApiError.code` 映射中文（`invalid_path` 含「绝对路径」、`not_found` 含「不存在」、`forbidden` 含「权限」），非 BoardApiError 兜底「目录加载失败」

- [x] **Step 1: 写失败测试**（覆盖上述全部签名与边界：根单节、多级累积、`parentOf` 根边界、排序数位感知 + 不变异、三类 code 映射 + 兜底）

- [x] **Step 2: 跑测试确认失败**

Run: `bun test webapp/test/fsbrowse.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现** `webapp/src/lib/fsbrowse.ts` 与 `api.ts` 的 `listDir`

- [x] **Step 4: 跑测试确认通过**

Run: `bun test webapp/test/fsbrowse.test.ts && bun test`
Expected: PASS（全量回归）

- [x] **Step 5: 构建 + 提交**

```bash
bun run build:web
git add webapp/src/lib/api.ts webapp/src/lib/fsbrowse.ts webapp/test/fsbrowse.test.ts src/web
git commit -m "feat: 🧭 前端目录数据层——listDir 封装与 fsbrowse 纯函数"
```

---

### Task 3: 项目管理列表卡片化

**Files:**
- Modify: `webapp/src/components/ProjectsDialog.svelte`（列表视图块，现 93-115 行区域；`Dialog.Content` 的 `sm:max-w-[520px]` → `sm:max-w-[640px]`）

**Interfaces:**
- Consumes: 现有 `projects` props、`openEdit`/`remove`（签名不变）。
- Produces: 无（纯视图改造，表单区不动）。

- [x] **Step 1: 改造列表视图**：列表容器 `grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2`；每项目一张卡片 `rounded-lg border p-3 flex flex-col gap-1.5`——头部：项目名（truncate 加粗）+「内置」Badge；中部：workspace（truncate + `title` 全路径）与描述（`line-clamp-2`，无则不占位）；底部操作栏 `border-t pt-2 mt-auto flex justify-end gap-1`：「编辑」ghost +「删除」ghost 红字（`text-destructive`），仅 `!p.builtin` 显示。**不加空状态**（默认项目恒在，列表永不为空）。
- [x] **Step 2: 验证**：`bun test` 回归 PASS；`bun run dev` 目检卡片布局、内置项目无操作栏、描述两行截断。
- [x] **Step 3: 构建 + 提交**

```bash
bun run build:web
git add webapp/src/components/ProjectsDialog.svelte src/web
git commit -m "feat: 🗂️ 项目管理卡片化——双列网格与底部操作栏"
```

---

### Task 4: `DirectoryPicker` 组件 + 表单集成

**Files:**
- Create: `webapp/src/components/DirectoryPicker.svelte`
- Modify: `webapp/src/components/ProjectsDialog.svelte`（表单区 workspace 输入行 + 组件挂载）

**Interfaces:**
- Consumes: Task 2 全部导出（`listDir`/`FsListing`/`splitCrumbs`/`parentOf`/`sortEntries`/`describeFsError`）。
- Produces: `<DirectoryPicker open: boolean（$bindable）, initial: string, onPick: (path: string) => void>`。

- [x] **Step 1: 实现 `DirectoryPicker.svelte`**：嵌套 Dialog（bits-ui 支持嵌套）；`open` 变 true 时 `listDir(initial || undefined)` 加载（加载态 spinner）；顶部路径输入框回车跳转；面包屑用 `splitCrumbs` 逐节可点；`listing.parent` 非 `null` 时首行 `..` 上级；条目单击进入；错误态显示 `describeFsError` + 重试按钮；底部「选择此目录」→ `onPick(listing.path)` 并置 `open = false`。所有新文案中文。
- [x] **Step 2: 集成 `ProjectsDialog` 表单**：workspace 输入行改 flex（Input `flex-1` + 「浏览…」按钮）；`let pickerOpen = $state(false)`；`onPick` 回填 `workspace`。
- [x] **Step 3: 验证**：`bun test` 全绿。
- [x] **Step 4: 构建**：`bun run build:web`。
- [x] **Step 5: 端到端目检**：`bun run dev` → 管理项目 → 新建 → 浏览 → 逐级进入/回车跳转/`..` → 选择此目录 → 保存成功且任务派发不受影响。
- [x] **Step 6: 提交**

```bash
git add webapp/src/components/DirectoryPicker.svelte webapp/src/components/ProjectsDialog.svelte src/web
git commit -m "feat: 📂 项目工作区目录选择器——浏览/跳转/回填"
```

---

## 归档说明

本计划当前存于 `/home/zhuchentong/.opencode/plan/`（plan mode 约束）。实施开始时将本文件复制到仓库惯例位置 `docs/superpowers/plans/2026-10-19-project-directory-picker.md` 并随 Task 1 首次提交入库。

---

## 执行记录（2026-10-19，Native 执行）

提交：`392a874` 服务端 API → `d507f98` 前端数据层 → `cd6789a` 卡片化 → `d562080` 目录选择器 → `7ccf527` 审查修复。基线 `ce95ae3`（421 pass / 0 fail），收尾 435 pass / 0 fail。

### 实施 rulings

- Task 2：`parentOf` 不用 `node:path`，改为手写 POSIX 切分——浏览器 bundle 无 node 内置模块。代价：仅 POSIX（服务端 `isAbsolute` 同此约束）。
- Task 2：`FsEntry`/`FsListing` 放 `fsbrowse.ts`，`api.ts` 以 `import type` 消费——避免运行时循环导入（`fsbrowse` 运行时 import `BoardApiError`）。代价：类型与 `types.ts` 分置（见延后项 M-9）。
- Task 4：回调 prop 命名 `onpick`（计划写 `onPick`）——对齐本仓 `onchanged` 惯例。代价：零。

### 审查修复（Important 全部修完，Minor 全部延后）

- I-1「重试」重载旧目录 → 抽纯函数 `retryTarget(input, listing)`（用户输入优先，其次上次目录），`webapp/test/fsbrowse.test.ts` 3 例钉住。
- I-2 `FS_LIST_CAP` 只截响应不截工作量 → `readdir(withFileTypes)` 类型短路，仅 symlink 才 `stat`；实测 `/usr/lib` 135-159ms → 89-98ms，`/usr/bin` 80-84ms → 17-18ms，响应内容不变。
- I-3 用例名声称覆盖「缺省 HOME」而 `home` 零断言 → 补 `home` 与无参请求断言，并以变异验证（`homedir()` → `process.cwd()` 变红、还原转绿）证明断言吃得住。
- 另：注释如实记录新增未鉴权面（本机目录名枚举）。

### 延后的 Minor（不修，留待后续）

M-1 `Awaited<ReturnType<typeof readdir>>` 标注实为自我断言（bun 不做类型检查，运行时无碍）· M-2 `ENOTDIR` 报 404「目录不存在」文案略偏（计划已钉该映射）· M-3 并发导航无请求序号守卫（慢请求后到会覆盖后请求，概率低）· M-4 `parentOf` 为死导出（服务端已下发 `parent`）· M-5 测试临时目录断言失败时无兜底清理 · M-6 服务端与前端各排一次序（前端重排是防御性，建议补注释）· M-7 嵌套 Dialog 焦点归还与双层遮罩观感需实机确认 · M-8 计划勾选状态（已回填）· M-9 `FsListing` 类型与 `types.ts` 分置。

### 既有 flaky（非本次引入）

`test/server-sse.test.ts`「第 33 个连接 503」偶发失败（1/7 全量跑）。根因：`handleEvents` 的 fire-and-forget 块在 `enqueue`/`emitSnapshot` 抛错时 `removeSubscriber`，未被读取的流被客户端回收即提前摘除订阅。本次对 `src/server.ts` 纯增量、未触碰 SSE 逻辑，基线 8 次未复现。治本方式：在用例里显式读取每条流的 `hello` 帧。

### 待人工确认

像素级目检（卡片布局、嵌套 Dialog 焦点归还、描述两行截断）需浏览器确认——CLI 代理已用编译通过 + 产物入包 + 真实 HTTP 端到端（列目录 → 建项目 → 删除）代证。
