# 看板「项目」概念设计——项目指定工作区,任务归属项目

日期:2026-10-18
状态:已批准设计(对话定稿 + 交叉验证修正),待实现
前置:`docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`(任务看板基线)、`docs/superpowers/specs/2026-10-17-dispatcher-along-driven-design.md`(沿驱动派发器)

## 0. 背景与目标

看板当前绑定单个 opencode 项目目录:所有 worker 会话都跑在服务进程目录(`session-pool.ts` 的 `deps.directory`),任务无归属维度,多仓库工作全挤在一个看板里。

本设计引入**用户可管理的「项目」实体**:项目指定一个工作区目录,任务归属项目;派发 worker 会话时,会话落在所属项目的工作区里。**一块看板管理多个仓库的任务**。

成功标准:

1. 网页可建/改/删项目(名称 + 工作区绝对路径 + 描述);
2. 建任务时选择所属项目;任务卡与详情可见归属;
3. 任务派发后,worker 会话的 `location.directory` = 所属项目的工作区(可实证);
4. 存量任务零迁移自动归入内置「默认项目」,行为与升级前完全一致;
5. Agent 七个工具行为不变;`bun test` 全绿。

## 1. 已确认的产品决策(对话定稿,2026-10-18)

| # | 决策 | 内容 |
|---|---|---|
| D1 | 工作区语义 | **worker 会话在项目工作区运行**(核心价值:跨仓库派发) |
| D2 | 存量任务 | **内置默认项目**(不可删改):任务必有项目,数据模型统一,派发无空值分支 |
| D3 | 管理入口 | **仅网页**管理项目;Agent 工具面不动(实测 `tools.ts` 本无建任务工具,建任务唯一路径是网页 → `POST /api/tasks` → `store.create`) |
| D4 | 看板展示 | **筛选器 + 徽标**:Header 项目筛选下拉(默认「全部」),泳道仍按状态组织,任务卡小徽标 |
| D5 | 删除语义 | 项目下有**非 done 任务 → 拒绝删除**;仅剩 done → 放行且 **done 任务级联删除** |
| D6 | 项目级设置 | **不做**:模型/确认开关仍看板全局(YAGNI,有真实需求再做覆盖) |

交叉验证修正(2026-10-18,证据见 §9):

- **M1** `conflict` 在 `STATUS_BY_CODE` 映射 **400**(非 409),守卫断言按 400 写;
- **M2** 目录注入收敛到 `createStore` opts(可选 `directory`),`createServer` 不加参;
- **M3** Agent 侧零改动比预想更彻底:`tools.ts` 完全不碰。

## 2. 非目标(YAGNI)

项目级模型/设置覆盖、Agent 项目管理工具、opencode worktree 集成、项目泳道分组、URL 状态持久化、项目级配额/限流、跨实例项目共享(存储天然按 opencode 项目隔离)。

## 3. 数据模型

### 3.1 `src/types.ts`

```ts
export const DEFAULT_PROJECT_ID = "project_default"

export interface Project {
  id: string            // `project_<8位hex>`
  name: string          // 唯一,非空;允许改名(外键是 id,不断链)
  workspace: string     // 绝对路径
  description?: string
  builtin?: boolean     // 仅合成的默认项目为 true
  createdAt: number
  updatedAt: number
}

export interface Task {
  // ...现有字段全部不动
  projectId?: string    // 可选:读取归一化 `?? DEFAULT_PROJECT_ID`;老任务零迁移
}

export interface TaskPatch {
  // ...现有字段不动
  projectId?: string    // 挪项目;目标项目必须存在
}
```

前端 `webapp/src/lib/types.ts` 是**手工副本**(文件头注释即此约定):`Task.projectId`、`Project`、`DEFAULT_PROJECT_ID` 三处同步。

### 3.2 默认项目 = 合成实体,不占存储键

- `store.listProjects()` 返回 `[合成默认项目, ...存储项目(按 createdAt 升序)]`;
- `store.getProject(DEFAULT_PROJECT_ID)` 返回合成值,不查存储;
- 合成值:`{ id: DEFAULT_PROJECT_ID, name: "默认项目", workspace: opts.directory ?? "(未配置)", description: "内置项目:未指定项目的任务;worker 在看板服务目录运行", builtin: true, createdAt: 0, updatedAt: 0 }`;
- 工作区**不落盘**的原因:服务目录随部署位置变,落盘会漂移;动态解析永远正确;
- `updateProject`/`deleteProject` 对 `DEFAULT_PROJECT_ID` 一律拒绝(`invalid_input`)。

### 3.3 存储

- `PROJECT_PREFIX = "project/"`(相对键,经 `storageBackend` 自动带 `${opencode项目ID}/` 前缀——两层「项目」概念互不混淆);
- 每项目一键 `project/<id>`,值 = `Project`,与 `task/<id>` 同模式;
- **迁移**:无。老任务无 `projectId` 字段,读路径(`list`/`get`/派发解析)统一 `?? DEFAULT_PROJECT_ID` 归一化,不回写;该任务下次被 patch 时自然落盘。

## 4. Store 层(`src/store.ts`)

### 4.1 接口新增(四处同步之第一处:`store.ts:74-92`)

```ts
listProjects(): Promise<Project[]>
getProject(id: string): Promise<Project>               // 默认项目返回合成值
createProject(input: { name: string; workspace: string; description?: string }): Promise<Project>
updateProject(id: string, patch: { name?; workspace?; description? }): Promise<Project>
deleteProject(id: string): Promise<void>
```

### 4.2 构造参数

`createStore(backend, opts)` opts 增**可选** `directory?: string`(M2):默认项目合成 workspace 的来源。`index.ts:164` 传 `ctx.location.directory`;`dev.ts` 传 `process.cwd()`;测试不传(合成值显示 `(未配置)` 占位)。既有调用零破坏。

### 4.3 守卫(全部在 `serialized()` 块内,与 claim/patchTask 原子互斥——交叉验证已确认无 TOCTOU)

| 守卫 | StoreError code | HTTP |
|---|---|---|
| `createProject`/`updateProject` name 为空(trim 后) | `invalid_input` | 400 |
| `createProject`/`updateProject` 重名(name.trim() 精确全等,排除自身) | `conflict` | **400**(M1) |
| `updateProject`/`deleteProject` 作用于 `DEFAULT_PROJECT_ID` | `invalid_input` | 400 |
| `updateProject`/`deleteProject` 项目不存在 | `not_found` | 404 |
| `deleteProject` 项目下存在非 done 任务 | `conflict` | **400** |
| `deleteProject` 仅剩 done 任务 | 放行:同块内级联 `backend.remove` 这些任务,再删项目键 | — |

### 4.4 Task 侧集成

- `create`(store.ts:162):input 增可选 `projectId`。提供时经 `readProject`(不存在 → `not_found`)校验;**新任务显式写入归一化后的 `projectId`**(含缺省落 `DEFAULT_PROJECT_ID`);
- `patch`(store.ts:188-239):在 title/description 段(≈:224-229)后增加——`p.projectId !== undefined` 时经 `readProject` 校验后赋值;**空串按缺省处理**(归一到 `DEFAULT_PROJECT_ID`,与「缺省落默认」同语义,防呆);不触碰 action/status/spans 逻辑;
- 读取归一化:`list`(store.ts:151)与 `get`(store.ts:158)映射 `projectId ?? DEFAULT_PROJECT_ID`(get 走 `readTask` 后归一);派发侧同样归一化(§6)。

## 5. HTTP 与 SSE(`src/server.ts` / `src/client.ts`)

### 5.1 路由

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/projects` | 无(照 `GET /api/models` 读路径先例,server.ts:188) | `{ projects: Project[] }` |
| `POST /api/projects` | `guard(req)` | 工作区校验(见下)→ `createProject` → `emitSnapshot` → 201 |
| `PATCH /api/projects/:id` | `guard(req)` | 仅校验**给出**的 workspace → `updateProject` → `emitSnapshot` |
| `DELETE /api/projects/:id` | `guard(req, false)` | `deleteProject`(守卫在 store)→ `emitSnapshot` |
| `POST /api/tasks` | 现有 | body 增可选 `projectId` 透传 `store.create` |
| `PATCH /api/tasks/:id` | 现有 | body 的 `projectId` 随现有透传进入 `TaskPatch` |

**工作区校验在路由层**(store 保持纯数据层):`path.isAbsolute(workspace)` 且 `statSync(workspace)` 为目录,否则 `invalid_input`(文案含路径)。`createServer` **不加** `directory` 参数(M2)。

不新增错误码 → `STATUS_BY_CODE`(server.ts:22)与 `tools.ts` `describeError` 均不动。

### 5.2 SSE 快照(唯一事实源)

- `ServerEvent` snapshot 扩为 `{ type: "snapshot"; tasks: Task[]; settings: BoardSettings; projects: Project[] }`(server.ts:5);
- `emitSnapshot`(server.ts:111-115)带 `store.listProjects()`——项目 CRUD、任务级联删、普通任务写全部广播同一快照;
- 次要实例:`proxyStore` 代理新方法(client.ts 照 `call/post` 范式,错误归一与 10s 超时自动继承),路由对次要实例透明可用。

## 6. 派发链(`src/dispatcher/`)

### 6.1 工作区解析(在 `dispatchFrontier`,engine.ts:251——全仓唯一 `pool.dispatch` 调用点)

```
task.projectId ?? DEFAULT_PROJECT_ID
  → deps.store.getProject(id)
      命中 → directory = p.workspace,project = p
      未命中/异常(理论不可达:活跃任务的项目不可删)→ 回退 ctx.directory + log warn(双保险)
```

### 6.2 会话创建

`pool.dispatch(task, workerName, text, model?, directory?)` 增第 5 参(session-pool.ts:117):

```ts
location: { directory: directory ?? deps.directory }
```

`deps.directory` 的红线注释保留;并发槽仍全局 6 个跨项目共享;阶段模型仍全局设置;超时回收/沿结算按 taskID,项目维度**零新增状态**。

### 6.3 提示词

`buildDispatchPrompt(task, project?: { name; workspace })`(prompt.ts:12)在任务 ID/标题后增一行:

```
  所属项目:<名>(工作区:<路径>)
```

project 缺省时不输出该行(向后兼容旧测试快照式断言)。

### 6.4 防抢机制不受影响

提示词写死 taskID + `claim` 原子(store.ts:270,serialized)——worker 在 X 项目工作区只可能领到提示词指定的任务,天然不串项目。

## 7. 前端(`webapp/`)

### 7.1 纯函数(新文件 `webapp/src/lib/project-options.ts` + `webapp/test/project-options.test.ts`)

```ts
projectFilterOptions(projects: Project[], tasks: Task[]): { id: string; label: string; count: number }[]
// 首项「全部」(id 为空串,count = 全部未完结);其余按 projects 顺序,count = 该项目未完结任务数
badgeHue(name: string): number            // 确定性 hash → 0-359,徽标着色
normalizeProjectId(t: Pick<Task, "projectId">): string
projectMap(projects: Project[]): Map<string, Project>   // 徽标/详情解析用
```

### 7.2 快照链(4 处,交叉验证枚举)

1. `events.ts:22` `EventsDeps.fetchBoard` 返回类型 + `:42` `onSnapshot` 签名扩第三参;`:87-92` 解析 `evt.projects ?? []`(对旧服务端容错);
2. `optimistic.ts:5-22` `BoardState` 增 `projects: Project[]`,`emptyState`/`applySnapshot` 同步;
3. `App.svelte:139-141` 调用点适配,projects 经 props 下传 Board → Lane → Card / TaskDetail(或经 `projectMap` 解析后传名);
4. `webapp/test/events.test.ts`、`webapp/test/optimistic.test.ts` 更新。

### 7.3 API 封装(`lib/api.ts`)

`fetchProjects()`、`createProject(name, workspace, description?)`、`updateProject(id, patch)`、`deleteProject(id)`——照 `request<T>` 范式,服务端校验错误经 `BoardApiError(code, message)` 原样回显。

### 7.4 组件

| 组件 | 改动 |
|---|---|
| `Header.svelte` | 项目筛选下拉(默认「全部」,选项带未完结计数)+「项目」按钮;**建任务对话框**增项目下拉(必选,默认 `DEFAULT_PROJECT_ID`) |
| `ProjectsDialog.svelte`(新) | 管理 CRUD:列表 + 表单(名称/工作区/描述);内置项目行无删改按钮;删除走 ConfirmDialog;服务端 400 错误文案回显 |
| `Card.svelte` / `TaskDetail.svelte` | 项目徽标(色点 `badgeHue` + 项目名);详情弹窗显示归属 |

## 8. 测试与验收

### 8.1 服务端(bun test 唯一验收门)

- **`test/project.test.ts`(新)**:CRUD 全路径;重名 conflict;默认项目禁删改;`listProjects` 合成注入(传/不传 `directory` 两态);任务缺省归属;挪项目(目标不存在 → not_found);删除守卫两级(非 done → conflict 400;仅 done → 级联删任务);老结构任务(无 `projectId`)读取归一化回归;
- **`test/server.test.ts` 扩**:项目路由 CRUD/鉴权/工作区校验(绝对路径、目录存在);快照含 `projects`;POST/PATCH /api/tasks 的 projectId 透传;
- **`test/dispatcher-wiring.test.ts` / `test/dispatcher/engine.test.ts` 扩**:fake session 记录每次 `create` 的 `location.directory` → 断言按任务项目解析;默认项目回退;未命中防御回退;提示词含项目行。

### 8.2 前端

`webapp/test/project-options.test.ts`(筛选/计数/着色/归一化);`events.test.ts`、`optimistic.test.ts` 适配新签名。

### 8.3 端到端验收(实现完成后)

1. 网页建项目(工作区指向真实仓库目录)→ 建任务归该项目 → 观察派发:worker 会话 `location.directory` = 项目工作区(opencode 会话记录实证);
2. 存量任务(升级前创建)在看板显示「默认项目」徽标,派发回退服务目录,行为与升级前一致;
3. 筛选/徽标/CRUD 弹窗交互;删除守卫两级;Agent 领取→分析→完成全链路不受影响;
4. `bun run build:web` 产物入库;全量 `bun test` 绿。

## 9. 交叉验证记录(2026-10-18)

| 结论 | 证据 |
|---|---|
| dispatch 唯一调用点,影响面 = 1 签名 + 1 调用 | `engine.ts:254`;`session-pool.ts:117,126` |
| 删除守卫无竞态:所有写同走 `serialized()` 全局互斥 | `store.ts:98-107`;claim/patchTask 同链 |
| 快照扩展向后兼容:旧前端忽略多余字段 | `events.ts:87-92` 仅取 `tasks/settings` |
| 读路径无鉴权先例 | `GET /api/models`(server.ts:188) |
| 次要实例自动获得能力:store 即代理 | `index.ts:108` `clientStore(...)` |
| dev 模式零成本:真 store + 内存 KV | `dev.ts:3,6` |
| 提示词参数化扩展点现成 | `prompt.ts:2,12` |
| Agent 无建任务工具,`tools.ts` 零改动 | 7 工具 = list/get/claim/analyze/complete/release/update |
| 前端类型手工副本需双处同步 | `webapp/src/lib/types.ts:1` 头注释 |
| `conflict` → 400(非 409) | `server.ts:25` `STATUS_BY_CODE` |
| `createServer` 无需加 directory(M2 收敛) | `createStore` opts 增可选 `directory`(store.ts:96) |

## 10. 风险与边界

- **项目改名/改工作区**:进行中任务的徽标随快照刷新;已派发 worker 会话不受影响(会话目录创建时已定);之后的派发用新值;
- **删除项目与在途派发**:在途任务必为非 done(pending/analyzing/…)→ 守卫拒绝,不存在「会话建了、项目没了」;
- **`workspace` 原样存储**:不做尾部斜杠归一、不做 `~` 展开(网页表单提示填绝对路径,服务端校验兜底);
- **name 匹配**:trim 后精确全等,不做大小写/Unicode 归一;
- **新前端 × 旧服务端**(仅 dev HMR 混跑场景):`fetchProjects`/快照 projects 缺失按空数组容错。
