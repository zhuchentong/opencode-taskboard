# AGENTS.md

面向 OpenCode 会话的仓库指南。权威口径看设计规格 `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（§5 状态机、§9 实例模型、§11 开发工作流）；实施计划与验收记录在 `docs/superpowers/plans/`。

## 项目是什么

OpenCode V2 插件：一个七阶段任务看板（planning → pending → analyzing → analysis_confirm → executing → completion_confirm → done）。Agent 用 `taskboard_*` 工具领取、分析、提交完成，用户在网页看板（`http://127.0.0.1:4370`）上规划、放行、验收。

- `src/` —— 插件运行时（TypeScript，Bun 跑；唯一依赖 `@opencode/plugin@2.0.30`，与本机 opencode 版本钉死）
- `webapp/` —— 前端源码（Svelte 5 + Vite，仅开发需要）
- `src/web/` —— **前端构建产物，已提交入库**（见下方「产物必须入库」）
- `test/`（服务端）、`webapp/test/`（前端纯函数）

## 命令

```bash
bun install                        # 根依赖（只有 @opencode/plugin）
bun test                           # 唯一验收门：同时跑 test/ 与 webapp/test/（15 文件）
bun test test/store.test.ts        # 单文件；bun test -t "关键字" 按用例名过滤
bun run dev                        # Mock 模式：内存后端 + 真实服务，免 OpenCode；token 固定 dev
cd webapp && bun install           # 前端构建链，仅开发前端时需要
bun run dev:web                    # 前端 HMR，/api 代理到 4370
bun run build:web                  # 重建产物到 src/web/（必须与 webapp/ 改动一起提交）
```

**没有 lint、没有格式化器、没有 CI、没有可用的 typecheck。** `package.json` 里没有 typecheck 脚本；`tsconfig.json` 要求 `bun-types` 但该包未安装，`tsc --noEmit` 会直接报 TS2688。仓库里还存在既有类型瑕疵（`src/client.ts` 导入了不存在的 `StoreErrorErrorCode`，`src/tools.ts` 首尾有重复的 type-only import），Bun 会擦除类型导入所以 `bun test` 仍绿。别声称 typecheck 通过，`bun test` 是唯一验证手段。

## 硬约束（改代码前必须知道）

- **产物必须入库**：`src/web/` 是给用户安装用的（用户只拷 `src/`，不需要 Node 工具链）。改了 `webapp/` 就必须跑 `bun run build:web` 并提交产物，否则发布出去的是旧前端。`vite.config.ts` 把 `entryFileNames/chunkFileNames/assetFileNames` 钉死为 `assets/board.js` / `assets/board.[ext]`（无 hash），别「修」这个反直觉配置。
- **Store 有两份实现**：`src/store.ts`（本地）与 `src/client.ts`（HTTP 代理到主实例）。新增 Store 方法必须三处同步改：接口定义、本地实现、`src/client.ts` 实现 + `src/server.ts` 路由。
- **写者唯一**：只有绑到基准端口 4370 的实例是主实例，持有唯一写串行链（`store.ts` 里 `serialized()` 是**全局**互斥，比 spec §9 写的「每任务锁」更强）；端口被同项目主实例占用时降级为次要实例，把**包括 Agent 工具在内**的全部写操作代理过去。只读操作走本地也不走代理。破坏这点 = 出现并发写。
- **自动派发器只装配在主实例**（`src/index.ts`），次要实例也装会导致双派发。
- **每次写都要广播**：`src/server.ts` 新增写路由后必须 `await emitSnapshot()`，否则前端 SSE（`/api/events` 全量快照，唯一事实源）会停留在旧状态。
- **storage key 必须前置 `projectID`**：`ctx.storage` 按插件 ID 全局共享、无位置隔离（spike #2 实证）。漏掉前缀会跨项目串数据。
- **令牌靠占位符注入**：`webapp/index.html` 里 `__TASKBOARD_TOKEN_VALUE__` 由 `server.ts` 的 `serveStatic` 在响应时替换进 `window.__TASKBOARD_TOKEN__`。前端读 window 必须惰性（`api.ts` 注释有说明：bun 测试环境无 DOM）。
- **前端交互逻辑写纯函数**：放在 `webapp/src/lib/`（`board.ts` 分组、`lane.ts` 拖拽计算、`markdown.ts`、`events.ts` SSE 客户端、`optimistic.ts` 乐观更新状态机）并配套 `webapp/test/`，不要塞进 `.svelte` 组件里。
- **Agent 不能标记完成**：`taskboard_complete` 只到 completion_confirm，只有用户在网页确认才进 done；打回必须附评论。别「简化」掉这些产品不变量。
- **工具生效名是 `taskboard_<短名>`**（来自 `taskboard` 命名空间，spike #3 实证），所以提示词里同时提到 `tools.taskboard.*` 与原生 `taskboard_*`。

## 本地集成调试

`.debug/` 被 gitignore，内含 playground 与验收脚本（`accept-dispatch.sh` 等），只在本机存在。

- 集成装载必须用 `.opencode/plugins/taskboard-loader.ts` 装载器文件（`import plugin from "<abs>/src/index.ts"`）：v2.0.30 的 `plugins` 配置键**不加载本地路径**（spike 实证，别浪费时间试配置）。
- 改插件代码后要 `opencode service restart`——本地依赖不触发自动重载。
- 插件日志统一 `[taskboard]` 前缀，只进内存环形缓冲，用 `GET /api/logs` 看；插件 console 不落 `opencode.log`，服务端问题再查 `~/.local/share/opencode/log/opencode.log`（筛 `role=server`）。
- 自动派发器的单飞门 `awaitingClaim`、派发异常熔断、执行唤醒（nudge）几处逻辑都是拿真实会话 API 反复调出来的；改之前先读 `docs/superpowers/plans/2026-10-16-auto-dispatcher.md` 与 `.debug/accept-dispatch.sh`。

## 约定

- 注释、日志、UI 文案、文档、提交信息一律中文；提交用中文约定式提交带 emoji（见 `git log`），如 `fix: 🐛 派发单飞门——awaitingClaim 期间禁止重复派发防打断 worker`。
- 测试描述也用中文（如 `reject 无评论 → 400 comment_required`）。
- `StoreError` 是跨层唯一错误契约：code → HTTP 状态映射在 `server.ts` 的 `STATUS_BY_CODE`，给 Agent 的文案在 `tools.ts` 的 `describeError`。新增错误码要同时补这两处。
