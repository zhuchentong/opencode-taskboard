# OpenCode Taskboard 插件设计

- 日期：2026-10-16（v2：七阶段流水线状态机）
- 状态：待用户审阅
- 仓库：`/home/zhuchentong/Projects/zhuchentong/opencode-taskboard`（仓库根即插件包根）

## 1. 背景与目标

为 OpenCode V2 开发一个任务看板插件：

- 安装后通过命令或浏览器访问本机端口打开任务看板网页。
- 用户在网页中创建任务，任务沿**七阶段流水线**流转：
  **待规划 → 待领取 → 分析中 →（分析确认）→ 执行中 → 完成确认 → 已完成**。
- Agent 通过插件注册的工具**自主认领**待领取任务：先分析、后执行；分析确认与完成确认两个人工关卡由用户把关；被打回的任务（附评论）回到待领取队列重新循环。
- 用户可设置**是否需要手动分析确认**：开启则分析完成后停在"分析确认"等用户放行；关闭则自动进入"执行中"。
- 插件在本仓库目录开发，**全程可调试**（见第 11 节）。

成功标准：

1. 真实 OpenCode 加载本插件后，网页七列看板可用：创建、拖拽流转、确认/打回、评论、编辑、删除。
2. 会话中执行 `/taskboard-claim`，Agent 经工具认领任务 → 提交分析 →（按设置等待或自动放行）→ 执行 → 提交完成确认；用户在网页确认后进入已完成；网页实时可见。
3. 关卡设置两种取值下流转均正确；打回任务带评论回到待领取，可被再次认领。
4. 并发 claim 同一任务仅一人成功。
5. `bun test` 全绿。

## 2. 非目标

- 不做 TUI 界面扩展（CLI plugin 是另一类插件，不在本期）。
- 不做 Agent 参与规划（待规划仅人工）。
- 不做多用户/鉴权体系（仅本机单人使用）。
- 不做 SSE 推送（2s 轮询已够，留作二期）。
- 不做跨项目聚合看板、不做逐任务级设置（分析确认开关为看板级）。

## 3. 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Agent 认领机制 | 工具认领（`taskboard_claim`） | Agent 自主决定领取哪个任务，实现清晰可控 |
| 任务存储 | `ctx.storage` | 零依赖、官方托管、免编译环境问题；数据规模远不需要 SQL |
| 分析阶段语义 | Agent 必做分析并产出结论；是否人工放行由看板设置决定 | 兼顾自主性与人工把关 |
| Web 托管 | 插件进程内 `Bun.serve` | 零额外进程，与工具共享状态；不可用则退化（第 9 节） |
| 前端 | 原生 HTML/JS/CSS | 无框架无构建，插件目录直接伺服 |
| 包形态 | 仓库根即包根，TS 免构建 | `package.json` exports 直接指向 `src/index.ts` |

## 4. 总体架构与目录

```
opencode-taskboard/
├── package.json        # type: module; exports { ".": "./src/index.ts" }; deps: @opencode/plugin
├── tsconfig.json
├── src/
│   ├── index.ts        # 插件入口 Plugin.define({ id, setup, cleanup })
│   ├── store.ts        # 存储层：storageStore(ctx.storage) + memoryStore()，同一接口；含状态机校验
│   ├── server.ts       # createServer({ store, port, token }) → { port, stop }（Bun.serve）
│   ├── tools.ts        # taskboard 命名空间工具注册
│   ├── commands.ts     # /taskboard、/taskboard-claim
│   ├── dev.ts          # Mock 模式入口：memoryStore + createServer，bun run dev
│   └── web/            # index.html / app.js / style.css（静态，直接伺服）
├── test/
│   ├── store.test.ts
│   └── server.test.ts
├── .debug/playground/  # 集成调试用测试项目（gitignore）
└── docs/superpowers/specs/
```

插件 `setup` 流程：建 store → 注册 tools/commands → 启动 HTTP 服务；`cleanup`（setup 返回值）停服务并依赖注册自动 dispose。

## 5. 数据模型与状态机

### 5.1 任务

```ts
Task {
  id: string                          // "task_" + 短随机
  title: string
  description: string                 // 默认 ""
  status:
    | "planning"            // 待规划
    | "pending"             // 待领取
    | "analyzing"           // 分析中
    | "analysis_confirm"    // 分析确认
    | "executing"           // 执行中
    | "completion_confirm"  // 完成确认
    | "done"                // 已完成
  analysis?: string                   // 最近一轮 Agent 分析结论
  result?: string                     // 执行结果备注
  comments: { author: string; text: string; createdAt: number }[]
                                      // author: "user" | agent 名；打回必附评论
  claim?: { sessionID: string; agent: string; claimedAt: number }
                                      // agent 可为 "human"；打回/放弃时清空
  createdAt: number
  updatedAt: number
}
```

### 5.2 看板设置

```ts
BoardSettings { requireAnalysisConfirm: boolean }   // 默认 false（自动进入执行中）
```

- 存 `ctx.storage`（key `settings/board`）；网页头部可切换；插件选项 `requireAnalysisConfirm` 决定初始默认。
- **假设 A（默认自动放行）**：默认 `false`，贴合"Agent 自动领取执行"的初衷；用户可随时在网页打开关卡。可改。

### 5.3 状态机

**Agent 工具流转（受限，一律校验 claim 归属）**：

| 工具 | 流转 | 校验 |
|------|------|------|
| `claim(id?)` | `pending → analyzing` | 原子；缺省领最旧 pending（同 createdAt 按 id 字典序） |
| `analyze(id, analysis)` | `analyzing → analysis_confirm`（设置开）<br>`analyzing → executing`（设置关，自动放行） | 仅领取者 |
| `complete(id, result?)` | `executing → completion_confirm` | 仅领取者 |
| `release(id)` | `analyzing → pending`、`executing → pending` | 仅领取者；清空 claim |

**用户流转（网页）**：

| 操作 | 流转 | 说明 |
|------|------|------|
| 拖拽 planning → pending | `planning → pending` | 规划完成，进入待领取队列 |
| 分析确认-通过 | `analysis_confirm → executing` | — |
| 分析确认-打回 | `analysis_confirm → pending` | 必附评论；清空 claim |
| 完成确认-通过 | `completion_confirm → done` | — |
| 完成确认-打回 | `completion_confirm → pending` | 必附评论；清空 claim |
| 自由拖拽（兜底） | 任意→任意 | 人工纠错；按 5.4 维护 claim |

**规则**：

- `done` 只能从 `completion_confirm` 到达（确认通过），或人工拖拽兜底。
- 打回必附评论（评论进 `comments`，author 为 "user"）；`analysis` 保留上一轮内容，新一轮 `analyze` 覆盖。
- 多轮循环：打回后任务回 `pending`，任何 Agent 可再次 `claim`，`comments` 作为轮次审计轨迹。

### 5.4 领取信息（claim）语义

- 人工把任务拖**离** `analyzing`/`executing`，或拖**入** `planning`/`pending`/`analysis_confirm` 前的非领取状态 → 清空 claim（确认类状态本就无主，拖入不设 claim）。
- 人工拖**入** `analyzing`/`executing` 且无 claim → `claim = { sessionID: "", agent: "human", claimedAt: now }`。
- Agent `analyze`/`complete`/`release` 遇 `agent: "human"` 或非本人 claim → 拒绝并返回可读错误。

### 5.5 存储

- key：`task/{id}`；是否前置 projectID 以 spike #2 结论为准。
- 列表：`scan({ prefix })` 按 `next` 游标循环取全量，内存按 `updatedAt` 倒序。

## 6. HTTP API

服务仅绑定 `127.0.0.1`，端口取 `options.port`（默认 **4370**），被占自动向上找空闲端口。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/tasks` | 任务列表（updatedAt 倒序） |
| POST | `/api/tasks` | 创建 `{ title, description? }` → planning |
| PATCH | `/api/tasks/:id` | 改 `status/title/description/result`；确认/打回/评论也走这里（`{ action: "confirm" \| "reject" \| "comment", comment? }`），服务端按 5.3 校验并维护 claim/评论 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET/PUT | `/api/settings` | 读/写看板设置（`requireAnalysisConfirm`） |
| GET | `/api/health` | `{ ok: true, primary: boolean, projectID }` |
| GET | `/api/logs` | 插件环形日志（上限 500 条），调试通道 |
| GET | `/` | 看板静态页（服务端注入 token，URL 不携带） |

防误触：启动时生成随机 token，注入静态页；POST/PATCH/PUT/DELETE 必须带 `X-Taskboard-Token` 头且 `Content-Type: application/json`，否则 403/415。GET 不校验。

## 7. Agent 工具与命令

**工具**：`ctx.tool.transform` 注册命名空间 `taskboard`，工具用短名（生效 ID = `taskboard_<name>`，spike #3 确认）：

| 工具 | 行为 |
|------|------|
| `list(status?)` | 列任务 |
| `get(id)` | 任务详情（含 settings 摘要） |
| `claim(id?)` | 原子领取 `pending → analyzing`；响应含任务全文与 `requireAnalysisConfirm`，Agent 据此知道分析后能否自动进入执行 |
| `analyze(id, analysis)` | 提交分析结论；按设置流转到 `analysis_confirm` 或自动 `executing` |
| `complete(id, result?)` | `executing → completion_confirm` |
| `release(id)` | 放弃：回 `pending`，清空本人 claim |
| `update(id, { analysis?, result? })` | 仅更新备注文本，**无 status 参数** |

**命令**：

- `/taskboard` — 输出看板 URL；best-effort 拉起浏览器（失败仅打印 URL）。
- `/taskboard-claim` — `ctx.session.prompt` 注入工作流指令："用 taskboard 工具领取一个待领取任务；先分析并 `analyze` 提交结论；若看板要求分析确认则告知用户等待确认，否则继续执行；完成后 `complete` 提交完成确认，等用户确认"。

## 8. 前端

> **2026-10-16 修订（Svelte 5 重构）**：本节原「原生 HTML/JS/CSS、无构建」的决策已被用户显式推翻，理由：原生实现的交互打磨成本高于组件化方案（操作反馈、动画、详情面板、拖拽手感四项痛点）；代价是引入仅构建期的 Vite/Svelte 工具链（运行时零依赖不变，产物入库后用户安装仍只需 `src/` + 装载器）。

**技术栈**：Svelte 5（runes）+ Vite，源码在 `webapp/`，构建产物固定文件名输出到 `src/web/` 并提交入库（`bun run build:web`）。

**交互与体验**：
- 七列看板（列头带计数、空列提示、首载骨架屏），卡片 keyed 渲染 + 跨列 flip 动画
- **Pointer Events 自研拖拽**：拖影跟随、目标列高亮、插入位置指示（视觉层）；Agent 认领中的分析/执行任务禁止用户拖动
- **乐观更新协议**：所有写本地立即生效（`beginOptimistic` 遮罩），SSE 快照回流不覆盖在途写，失败回滚到服务器最近快照并弹 toast；成功路径先应用快照再摘遮罩
- **SSE 实时**：`GET /api/events` 订阅快照（免 token），断线自动重连，连续 3 次失败降级 5s 轮询 + 30s 对账轮询恒开；Header 连接状态点（live/reconnecting/polling）
- **任务详情侧滑面板**：行内编辑标题/描述（Esc 还原、空标题不保存）、完整评论流与添加、通过/打回（打回原因必填）、删除（自定义确认弹层）
- 全部通知用 toast、确认用自定义弹层（消灭原生 alert/confirm）；主题跟随系统深浅色 + 手动切换；键盘可达（卡片 focus + Enter 开详情 + Esc 关闭/还原，焦点返还）
- 桌面端为主；窄屏不专门适配

## 9. 并发与实例模型

- **正常模型**（预期）：一个位置至多一个活跃插件实例（共享 service 进程 + storage 按位置隔离）。所有写入经 store 每任务一把 async 互斥锁串行化；claim 在锁内 read-check-write。
- **写者唯一原则**：只有绑定基准端口（4370）的实例是**主实例**，持有唯一内存锁；次要实例（端口上移者）经 `/api/health` 探测到主实例后，把包括工具在内的全部写操作代理到主实例 HTTP API，自身只读。
- **退化方案**：spike #1 否决进程内 `Bun.serve` 时，退到独立子进程方案——子进程即唯一主实例，天然单写者。

## 10. 错误处理

| 场景 | 行为 |
|------|------|
| 端口被占 | 上移端口并提示实际 URL；探测到同项目主实例则降级为次要实例 |
| claim 冲突 | "任务已被其他会话领取"，Agent 继续领下一个 |
| 非法流转/非领取者 | 拒绝并说明当前状态与 claim 归属（如"任务在执行中，claim 属于其他会话"） |
| 打回无评论 | 拒绝："打回必须附评论" |
| 任务已删除 | 工具返回"任务已不存在（可能已被删除），请放弃该任务" |
| storage 异常 | 工具返回可读错误；Web API 500 + JSON error |
| 插件卸载 | cleanup 停服务，注册自动 dispose |

## 11. 开发与调试工作流

仓库自带三层调试能力：

1. **单元测试**：`bun test`（test/ 与 webapp/test/ 下），覆盖状态机全流转、claim 竞态、HTTP API、SSE 契约、双实例代理、前端纯函数（分组/乐观协议/SSE 客户端）。
2. **Mock 模式（前端/API 快速迭代）**：`bun run dev` —— `src/dev.ts` 用内存后端 + `createServer()` 直接起服务（默认 4370），浏览器打开即调，无需 OpenCode。前端 HMR 迭代用 `bun run dev:web`（Vite dev server，`/api` 代理到 4370）；改前端后 `bun run build:web` 重建产物（提交入库，固定文件名避免 hash 污染）。
3. **集成调试（真实 OpenCode）**：
   - `.debug/playground/` 是 gitignore 的测试项目，在 **`.opencode/plugins/taskboard-loader.ts`** 放装载器（v2.0.30 的 `plugins` 配置键不加载本地路径，spike 实证）：
     ```ts
     import plugin from "/home/zhuchentong/Projects/zhuchentong/opencode-taskboard/src/index.ts"
     export default plugin
     ```
   - 在该目录运行 `opencode`；改插件代码后 `opencode service restart` 重载（本地依赖不触发自动重载）。
   - 插件日志：`GET http://127.0.0.1:<port>/api/logs`（插件 console 不落入 opencode.log）；服务端侧问题再查 `~/.local/share/opencode/log/opencode.log`（筛 `role=server`）。

**用户安装**（产物已入库，无需 Node 工具链）：拷贝 `src/` 到目标项目，并在目标项目 `.opencode/plugins/` 放装载器文件指向 `src/index.ts`。前端重建仅开发时需要（`cd webapp && bun install && bun run build:web`）。
   - 服务状态：`opencode service status`；API 自检：`opencode api get /api/info`。
4. 插件日志统一前缀 `[taskboard]`，写入内存环形缓冲（上限 500 条），经 `GET /api/logs` 暴露；`console.*` 仅作 best-effort。

## 12. Spike 清单（已完成，结论见 `docs/superpowers/plans/2026-10-16-taskboard-spike-findings.md`）

1. ✅ 插件进程内 `Bun.serve` 可用 → inprocess 方案成立。
2. ✅ `ctx.storage` 全局按插件 ID 共享、无位置隔离 → key 必须带 `ctx.location.project.id`；project.id 首次发现时生成、不随 commit 变化。
3. ✅ 工具生效名 = `命名空间_短名`（`taskboard_<短名>`），Agent 会话可见可调用。
4. ✅ 浏览器拉起走 best-effort（命令触发需 TUI，Task 8 验收；失败仅打印 URL）。
5. ➕（spike 新增结论）`plugins` 配置键在 v2.0.30 不加载本地路径，集成装载走 `.opencode/plugins/` 装载器文件。

## 13. 测试策略

- store/状态机：
  - 全部合法流转逐条验证；非法流转逐条拒绝（工具路径 `done` 只进不出、打回无评论拒绝等；人工拖拽路径不受此限）。
  - 分析确认开关两种取值：`analyze` 后分别到 `analysis_confirm` / `executing`。
  - 打回循环：`completion_confirm → pending` 清 claim、评论入列、可再 claim。
  - 并发 claim 竞态（仅一人成功）；领取信息语义（拖动清空/标记）。
  - 游标分页。
- server：真实请求打测试实例；token / Content-Type 校验（403/415）；settings GET/PUT；主/次要实例写代理。
- 手动验收：`.debug/playground` 中走通 创建→待领取→`/taskboard-claim`→分析→（设置开/关各验一次）→执行→完成确认→确认/打回→再循环→已完成 闭环。

## 14. 未决问题

- **假设 A**：分析确认开关默认 `false`（自动放行）——待用户确认，一行代码可改。
- ~~storage key 是否前置 projectID~~ → 已裁决：必须前置（spike #2）。
- ~~进程内 Bun.serve~~ → 已确认可用（spike #1）。
- ~~工具生效名~~ → 已确认 `taskboard_<短名>`（spike #3）。
- 浏览器自动拉起：best-effort 实现，TUI 实际效果 Task 8 验收（失败则仅打印 URL，无设计影响）。
