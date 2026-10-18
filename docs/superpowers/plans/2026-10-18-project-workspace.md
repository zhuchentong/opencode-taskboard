# 看板「项目」概念 实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 subagent-driven-development(推荐)或 executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** 看板新增用户可管理的「项目」实体(名称+工作区目录),任务归属项目,worker 会话派发到项目工作区——一块看板管多个仓库。

**架构:** `Project` 为独立 KV 实体(`project/<id>`,与 `task/<id>` 同模式);内置合成默认项目(不占存储键,workspace 动态取服务目录)承接存量任务;派发链在唯一调用点解析 任务→项目→workspace 传入会话创建;SSE 全量快照扩 `projects` 字段保持唯一事实源;前端筛选器+徽标+管理弹窗。

**技术栈:** TypeScript + Bun(运行时/测试)、无框架 HTTP(server.ts)、Svelte 5 + Vite(前端)、OpenCode 插件 KV storage。

**规格:** `docs/superpowers/specs/2026-10-18-project-workspace-design.md`(决策 D1–D6、修正 M1–M3、证据见规格 §9;执行者两份都读)

## 全局约束

- `bun test` 是唯一验收门;仓库无 lint/格式化器/可用 typecheck,**不得声称 typecheck 通过**
- 注释、日志、UI 文案、测试描述、提交信息一律中文;提交 = 中文约定式 + emoji
- 改 `webapp/` 后必须 `bun run build:web`,产物 `src/web/` 随同一提交入库
- Store 四处同步:`types.ts` 接口、`store.ts` 本地、`client.ts` 代理、`server.ts` 路由;**写路由必须 `await emitSnapshot()`**
- 不新增错误码(复用 `invalid_input`/`conflict`/`not_found`);`STATUS_BY_CODE`:`conflict→400`、`not_found→404`、`invalid_input→400`
- `tools.ts` 零改动(Agent 无建任务工具;`taskboard_*` 七工具不变)
- 常量钉死:`DEFAULT_PROJECT_ID = "project_default"`;合成默认项目 `{ name: "默认项目", workspace: opts.directory ?? "(未配置)", description: "内置项目：未指定项目的任务；worker 在看板服务目录运行", builtin: true, createdAt: 0, updatedAt: 0 }`;项目 id 形如 `project_${crypto.randomUUID().slice(0,8)}`
- 测试环境不依赖文件系统的校验放 store;工作区存在性校验(`isAbsolute` + `statSync` 目录)放 server 路由层

## 审查重点(Review Focus)

1. **老任务无 `projectId` 字段**:读取/筛选/徽标/派发必须归一到默认项目——不得出现 `undefined` 徽标或派发丢弃(任务 2 归一化测试 + 任务 4 默认回退测试)
2. **删项目与 dispatcher 领取并发**:守卫+级联必须在同一 `serialized()` 块内,非 done 任务存在时删除必须 `conflict`(任务 2 删除守卫测试)
3. **派发时项目查不到**(理论不可达,仍须防御):回退服务目录继续派发,不崩溃不丢任务(任务 4 防御回退测试)
4. **非法工作区**(相对路径/不存在/是文件):建/改项目必须 400 且文案含路径,不得落库(任务 3 路由测试)
5. **`projects` 字段缺失**(旧服务端/dev 混跑):前端按空数组容错,不得白屏(任务 5 events 解析测试)

---

### 任务 1:`Project` 类型与 Store 项目 CRUD

**文件:**
- 修改:`src/types.ts`(常量与接口)
- 修改:`src/store.ts`(opts.directory、PROJECT_PREFIX、readProject、5 个方法)
- 测试:`test/project.test.ts`(新建)

- [ ] **步骤 1:编写失败测试** `test/project.test.ts`(describe 中文,复用 `createStore(memoryBackend(), { requireAnalysisConfirm: false })` 模式,参照 `test/store.test.ts`):

```ts
describe("项目 CRUD 与合成默认项目", () => {
  // 断言要点(每条一个 test,描述中文):
  test("listProjects 首项为合成默认项目,不传 directory 时 workspace 显示占位")
  // expect((await store.listProjects())[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: "默认项目", builtin: true, workspace: "(未配置)", createdAt: 0 })
  test("传 directory 时合成默认项目 workspace 取该值")
  // createStore(memoryBackend(), { requireAnalysisConfirm: false, directory: "/proj" }) → listProjects()[0].workspace === "/proj"
  test("getProject(DEFAULT_PROJECT_ID) 返回合成值(存储为空也可取)")
  test("createProject 返回完整实体且 listProjects 可见(id 前缀 project_)")
  test("重名创建 conflict;name 空白 invalid_input")
  test("updateProject 改名/改描述;重名(他人)conflict;改回自己原名放行")
  test("updateProject/deleteProject 作用于默认项目 → invalid_input;项目不存在 → not_found")
})
```

- [ ] **步骤 2:运行验证失败**

运行:`bun test test/project.test.ts`
预期:FAIL,`listProjects is not a function` 之类

- [ ] **步骤 3:实现** `src/types.ts` 导出 `DEFAULT_PROJECT_ID`、`Project`;`src/store.ts`:
  - opts 增可选 `directory?: string`;`PROJECT_PREFIX = "project/"`;私有 `readProject(id)`(默认项目返回合成值;否则读键,缺失 → `not_found`)、`readAllProjects()`(scan + createdAt 升序)
  - `Store` 接口与实现:`listProjects`(合成默认打头)、`getProject`、`createProject`(trim 非空、重名 `conflict`、`project_` 前缀 id)、`updateProject`(默认项目 `invalid_input`、重名排除自身、刷新 updatedAt)、`deleteProject`(默认项目 `invalid_input`、不存在 `not_found`;守卫与级联在步骤见任务 2——本任务先实现「无任务即可删」的直删路径)
  - 写方法全部包 `serialized()`

- [ ] **步骤 4:运行验证通过**

运行:`bun test test/project.test.ts && bun test`
预期:PASS(全量无回归)

- [ ] **步骤 5:Commit**

```bash
git add src/types.ts src/store.ts test/project.test.ts
git commit -m "feat: 🗂️ Project 实体与 Store 项目 CRUD——合成默认项目,守卫齐备"
```

### 任务 2:Task 项目归属(创建/挪项目/读取归一化/删除守卫级联)

**文件:**
- 修改:`src/store.ts`(create、patch、list、get)
- 测试:`test/project.test.ts`(追加)

- [ ] **步骤 1:编写失败测试**(追加到 `test/project.test.ts`):

```ts
describe("任务项目归属", () => {
  test("create 缺省落默认项目(落盘显式 projectId)")
  // const t = await store.create({ title: "T" }); expect(t.projectId).toBe(DEFAULT_PROJECT_ID)
  test("create 指定项目归属;项目不存在 → not_found")
  test("patch 挪项目;目标不存在 → not_found;空串归一到默认项目")
  test("读取归一化:注入无 projectId 的老结构任务,list/get 读出 DEFAULT_PROJECT_ID")
  // 直接 backend.set(TASK_PREFIX + id, { ...无 projectId 的任务 }) 后断言
  test("deleteProject 项目下有非 done 任务 → conflict")
  test("deleteProject 仅剩 done 任务 → 放行且这些任务被级联删除")
})
```

- [ ] **步骤 2:运行验证失败**

运行:`bun test test/project.test.ts`
预期:FAIL,`projectId` 断言不匹配/undefined

- [ ] **步骤 3:实现** `src/store.ts`:
  - `create` input 增可选 `projectId`:空串/缺省 → `DEFAULT_PROJECT_ID`;否则 `readProject` 校验(`not_found`);显式写入归一化值
  - `patch`:title/description 段后加 `p.projectId !== undefined` 分支(空串归一默认,否则校验存在)
  - `list`/`get`:映射 `projectId ?? DEFAULT_PROJECT_ID`
  - `deleteProject` 补全守卫:scan 任务,按归一化 projectId 过滤;存在非 done → `conflict`;否则级联 `backend.remove` 这些任务与项目键(同一 `serialized()` 块)

- [ ] **步骤 4:运行验证通过**

运行:`bun test test/project.test.ts && bun test`
预期:PASS(全量无回归——`store.test.ts` 既有用例的 create 断言不受影响,新增字段向后兼容)

- [ ] **步骤 5:Commit**

```bash
git add src/store.ts test/project.test.ts
git commit -m "feat: 🏷️ 任务归属项目——创建缺省默认/挪项目/读取归一化,删除守卫两级与 done 级联"
```

### 任务 3:HTTP 路由 + SSE 快照 + client 代理 + 装配

**文件:**
- 修改:`src/server.ts`(ServerEvent、emitSnapshot、4 条路由、POST /api/tasks 透传)
- 修改:`src/client.ts`(5 个代理方法)
- 修改:`src/index.ts`(createStore 传 `directory: ctx.location.directory`,≈:164)
- 修改:`src/dev.ts`(createStore 传 `directory: process.cwd()`)
- 测试:`test/server.test.ts`(扩展)

- [ ] **步骤 1:编写失败测试**(扩展 `test/server.test.ts`,沿用其起服务与 fetch 模式;工作区校验用 `os.tmpdir()` + `mkdtemp` 造真实目录):

```ts
describe("项目 API", () => {
  test("GET /api/projects 无鉴权返回含合成默认项目")
  test("POST 无 token → 403;相对路径/不存在的目录/指向文件 → 400 invalid_input 且文案含路径")
  test("POST 合法目录 → 201 落库;重名 → 400 conflict")
  test("PATCH 改名成功;DELETE 非 done 守卫 → 400;仅 done → 200 且 GET /api/tasks 不含被级联任务")
  test("SSE 首个 snapshot 事件含 projects 数组字段")
  test("POST /api/tasks 带 projectId 落正确归属;不带落默认项目")
})
```

- [ ] **步骤 2:运行验证失败**

运行:`bun test test/server.test.ts`
预期:FAIL,404(路由不存在)或字段缺失

- [ ] **步骤 3:实现**:
  - `server.ts`:`ServerEvent` snapshot 增 `projects: Project[]`;`emitSnapshot` 带 `store.listProjects()`;新路由段(放在 `/api/tasks` 段之前):`GET/POST /api/projects`、`PATCH/DELETE /api/projects/:id`(workspace 校验仅在给出时做:`isAbsolute` + `statSync` isDirectory,否则 `invalid_input`,message 含路径;写路由 `guard(req)`/`guard(req, false)` + `await emitSnapshot()`,照 POST /api/tasks 范式 server.ts:204-213);`POST /api/tasks` 组装增 `projectId: typeof body.projectId === "string" ? body.projectId : undefined`
  - `client.ts`:照 `call`/`post` 范式加 `listProjects`/`getProject`/`createProject`/`updateProject`/`deleteProject`
  - `index.ts`/`dev.ts`:createStore opts 加 `directory`

- [ ] **步骤 4:运行验证通过**

运行:`bun test test/server.test.ts && bun test`
预期:PASS

- [ ] **步骤 5:Commit**

```bash
git add src/server.ts src/client.ts src/index.ts src/dev.ts test/server.test.ts
git commit -m "feat: 🌐 项目 API 四处同步——路由/SSE 快照扩 projects/客户端代理/装配注入服务目录"
```

### 任务 4:派发链工作区解析

**文件:**
- 修改:`src/dispatcher/prompt.ts`(buildDispatchPrompt 第 2 参)
- 修改:`src/dispatcher/session-pool.ts`(dispatch 第 5 参 directory)
- 修改:`src/dispatcher/engine.ts`(dispatchFrontier 解析,≈:251-254)
- 测试:`test/dispatcher/engine.test.ts`、`test/dispatcher/session-pool.test.ts`(扩展;fake session 需记录每次 `create` 的 `location.directory`)

- [ ] **步骤 1:编写失败测试**:

```ts
describe("派发工作区解析", () => {
  // prompt.test 侧:
  test("buildDispatchPrompt 带 project 时含「所属项目：<名>（工作区：<路径>）」行;缺省省略该行")
  // session-pool 侧:
  test("dispatch 第5参 directory 优先;缺省回退 deps.directory")
  // 断言 fake session.create 收到的 location.directory
  // engine 侧(真 store + createProject 造项目):
  test("任务归属项目 P(workspace=/p1)→ 会话建在 /p1")        // store.create({projectId: P.id}) → patch pending
  test("任务归属默认项目 → 会话建在 ctx.directory")
  test("projectId 指向不存在项目 → 回退 ctx.directory 且日志含回退警示")
})
```

- [ ] **步骤 2:运行验证失败**

运行:`bun test test/dispatcher/engine.test.ts test/dispatcher/session-pool.test.ts`
预期:FAIL(directory 断言不匹配/签名不存在的参数被忽略)

- [ ] **步骤 3:实现**:
  - `prompt.ts`:`buildDispatchPrompt(task: { id; title }, project?: { name; workspace })`,任务标题行后增 `  所属项目：${project.name}（工作区：${project.workspace}）`(仅当传入)
  - `session-pool.ts`:`dispatch(task, workerName, text, model?, directory?)`;`location: { directory: directory ?? deps.directory }`
  - `engine.ts` `dispatchFrontier`:`try { const p = await deps.store.getProject(task.projectId ?? DEFAULT_PROJECT_ID); directory = p.workspace; project = { name: p.name, workspace: p.workspace } } catch { deps.log(回退警示); directory = ctx.directory }`;传入 dispatch 第 5 参与提示词第 2 参

- [ ] **步骤 4:运行验证通过**

运行:`bun test test/dispatcher/ test/dispatcher-wiring.test.ts && bun test`
预期:PASS

- [ ] **步骤 5:Commit**

```bash
git add src/dispatcher/ test/dispatcher/
git commit -m "feat: 🚚 worker 派发到项目工作区——任务→项目→目录解析,默认/缺失双回退,提示词带项目行"
```

### 任务 5:前端类型 + 快照链 + 纯函数 + API 封装

**文件:**
- 修改:`webapp/src/lib/types.ts`(手工副本:`Task.projectId?`、`Project`、`DEFAULT_PROJECT_ID`)
- 修改:`webapp/src/lib/events.ts`(fetchBoard/onSnapshot/解析,≈:22/:42/:87-92)
- 修改:`webapp/src/lib/optimistic.ts`(BoardState/emptyState/applySnapshot,≈:5-22)
- 修改:`webapp/src/lib/api.ts`(4 个项目函数;`createTask` 增可选 projectId 参)
- 创建:`webapp/src/lib/project-options.ts`
- 测试:`webapp/test/project-options.test.ts`(新);`webapp/test/events.test.ts`、`webapp/test/optimistic.test.ts`(适配)

- [ ] **步骤 1:编写失败测试**:

```ts
// webapp/test/project-options.test.ts
describe("project-options", () => {
  test("projectFilterOptions 首项「全部」count=未完结总数,其余按传入顺序 count=各自未完结数")
  test("badgeHue 确定性(同输入同输出)且落在 0-359")
  test("normalizeProjectId 缺省回 DEFAULT_PROJECT_ID")
  test("projectMap 以 id 为键")
})
// events.test.ts 适配:onSnapshot 三参;快照缺 projects 字段 → 收到 [](容错,审查重点 5)
// optimistic.test.ts 适配:applySnapshot 存 projects;emptyState 缺省 []
```

- [ ] **步骤 2:运行验证失败**

运行:`bun test webapp/test/project-options.test.ts`
预期:FAIL,模块不存在

- [ ] **步骤 3:实现**(签名见规格 §7.1;`api.ts` 的 `fetchProjects(): Promise<Project[]>` 取响应 `projects` 字段,照 `fetchModels` 范式 api.ts:54)

- [ ] **步骤 4:运行验证通过**

运行:`bun test webapp/test/ && bun test`
预期:PASS

- [ ] **步骤 5:Commit**

```bash
git add webapp/
git commit -m "feat: 🧩 前端项目数据层——类型同步/快照链三处/筛选与徽标纯函数/项目 API 封装"
```

### 任务 6:前端组件(筛选/建任务下拉/管理弹窗/徽标)+ 产物入库

**文件:**
- 修改:`webapp/src/App.svelte`(projects 状态与下传,≈:139-141)
- 修改:`webapp/src/components/Header.svelte`(筛选下拉、「项目」按钮、建任务对话框项目下拉,≈:183-199 表单)
- 修改:`webapp/src/components/Card.svelte`、`webapp/src/components/TaskDetail.svelte`(徽标)
- 创建:`webapp/src/components/ProjectsDialog.svelte`(范式:Header 建任务 Dialog + TaskDetail 大弹窗)
- 产物:`src/web/`(`bun run build:web`)

- [ ] **步骤 1:实现组件**(纯逻辑已在 `project-options.ts`;交互按现有 Svelte 5 模式):
  - App:projects 随快照入 state,`projectMap` 解析后 props 下传;筛选状态本地 `let projectFilter = $state("")`
  - Header:筛选 select(选项来自 `projectFilterOptions`);「项目」按钮开 `ProjectsDialog`;建任务表单加项目 select(默认 `DEFAULT_PROJECT_ID`),提交调 `createTask(title, description, projectId)`
  - `ProjectsDialog`:列表(名称/工作区/未完结计数)+ 新建/编辑表单 + 删除(ConfirmDialog,服务端 400 文案经 `BoardApiError.message` 回显);`builtin` 行无删改按钮
  - Card/TaskDetail:徽标 = 色点(`hsl(badgeHue(name),70%,50%)`)+ 项目名;`normalizeProjectId` 取 id 后查 map
- [ ] **步骤 2:运行验证通过**

运行:`bun test webapp/test/ && bun test`
预期:PASS(回归标记测试 `regression-markers.test.ts` 不受影响)

- [ ] **步骤 3:构建产物**

运行:`bun run build:web`
预期:`src/web/assets/board.js`/`board.css` 更新,无构建错误

- [ ] **步骤 4:Commit**

```bash
git add webapp/ src/web/
git commit -m "feat: 🖥️ 看板项目交互——筛选/建任务归项目/管理弹窗/任务卡徽标,产物入库"
```

### 任务 7:文档同步 + 全量回归 + 端到端验收

**文件:**
- 修改:`AGENTS.md`(「项目」概念要点:合成默认项目、worker 工作区解析、快照含 projects、`directory` 注入)

- [ ] **步骤 1:AGENTS.md 补一段项目语义**(硬约束一节,简短)
- [ ] **步骤 2:全量回归**

运行:`bun test`
预期:全绿(360+ 新增)

- [ ] **步骤 3:端到端验收**(规格 §8.3,真实看板):
  1. `opencode service restart` 加载;网页建项目(工作区=某真实仓库)→ 建任务归该项目 → 派发后查会话 `location.directory` = 项目工作区
  2. 存量任务显示「默认项目」徽标,派发回退服务目录
  3. 删除守卫两级;Agent 全链路不受影响
- [ ] **步骤 4:Commit**

```bash
git add AGENTS.md
git commit -m "docs: 📝 AGENTS.md 同步项目概念语义"
```
