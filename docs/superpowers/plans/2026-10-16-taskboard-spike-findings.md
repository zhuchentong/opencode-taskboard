# Taskboard Spike 结论（Task 1）

日期：2026-10-16 · OpenCode v2.0.30 · bun 1.4.2

## 决策表

| 决策项 | 结论 | 证据 |
|--------|------|------|
| `SERVE_MODE` | **inprocess**（进程内 Bun.serve 可用） | 探针日志 `Bun.serve OK http://127.0.0.1:4392`；`curl /` 返回 `{"ok":true,...}` |
| `KEY_PREFIX` | **必须带 `ctx.location.project.id` 前缀**；ctx.storage 全局按插件 ID 共享，无位置隔离 | opencode.db kv 表 key=`plugin:<UTF-16hex插件ID>:<key>`，无位置分量 |
| `PROJECT_ID_STABILITY` | **稳定**（首次发现时生成，不随 commit 变化） | commit 934600b 后 `/api/project` 中本项目 id 仍为 f3669fd…，`time.updated` 未变 |
| `TOOL_NAMES` | **`taskboard_<短名>`**（namespace+短名→生效名拼接确认） | 探针 `tool.list spike => spike2_ping,spike2_logs`；Agent 会话内成功调用两工具 |
| `BROWSER_OPEN` | **best-effort spawn + url-only 兜底**；命令经 `opencode run "/cmd"` 无法触发，需 TUI（Task 8 验收） | `/spike2-open` 消息被当作普通文本 |

## 装载方式决策（重要）

**v2.0.30 的 `plugins` 配置键（目录形态与绝对 .ts 文件形态）均静默不加载**（无 loading plugin 日志、无报错；`opencode plugin list` 不含）。`.opencode/plugins/` 自动发现路径可靠（direct .ts 文件加载成功）。

→ 集成调试与最终用法：在目标项目 `.opencode/plugins/` 放装载器文件：
```ts
import plugin from "/abs/path/to/opencode-taskboard/src/index.ts"
export default plugin
```
本地依赖的自动重载不生效（touch 后旧实例仍持有端口），改代码后需 `opencode service restart`（与文档 caveat 一致）。

## 日志决策

插件 `console.log` 不落入 opencode.log，也未在磁盘其他位置发现（仅 storage WAL 命中）。
→ **server.ts 自带 `GET /api/logs`**（内存环形日志，上限 500 条），作为插件自省与调试通道；spec §11 第 4 条按此修订。

## 其他发现

- `opencode run --standalone`：帮助文本列出该 flag，但解析器报 `Unrecognized flag`（v2.0.30 CLI bug）。
- ctx.storage 落盘于 `~/.local/share/opencode/opencode.db`（SQLite kv 表），只读检查命令：`sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro"`。
- `ctx.location.project` 形如 `{id, directory, canonical}`；canonical 指向 git 仓库根。
- 插件实例按位置常驻：同位置后续会话不会重跑 setup；storage 是跨会话共享面。

## 对后续任务的影响

- Task 4：路由表追加 `GET /api/logs`。
- Task 6：装载与日志按上述决策；`KEY_PREFIX` 取 `ctx.location.project.id`。
- Task 8：命令执行（/taskboard、/taskboard-claim）在 TUI 人工验收；playground 用装载器文件加载。

## Task 8 集成验收记录（2026-10-16）环境：真实 OpenCode v2.0.30 共享服务，`.debug/playground/.opencode/plugins/taskboard-loader.ts` 装载。

| 项 | 结果 | 证据 |
|----|------|------|
| 插件加载/服务就绪 | ✅ 主实例 4370 | `/api/health` → `{"ok":true,"primary":true}`；`/api/logs` 三条启动日志 |
| 完整闭环（设置关） | ✅ pending→analyzing→executing→completion_confirm | 真实 Agent 会话领取 task_9f9a971d，产出 acceptance.txt（内容 hello taskboard），result 已填 |
| 确认完成 | ✅ completion_confirm→done | PATCH confirm（等价网页按钮） |
| 打回循环 | ✅ completion_confirm→pending、claim 清空、评论入列 | task_491f8b4a 被打回后由**新会话**（sessionID 已更换）重新认领，按评论要求返工，再次到达 completion_confirm，评论保留 |
| 分析确认关卡（设置开） | ✅ analyze 停在 analysis_confirm，放行后→executing | task_5f9c2db9 实测；设置已恢复 false |
| 并发 claim 竞态 | ✅ 恰一人成功 | 并发两请求：200 与 400(invalid_transition) |
| 重启持久化 | ✅ | service restart + 重新激活后任务与状态原样保留（opencode.db kv） |
| 工具可见性 | ✅（经 Code Mode 目录） | `tools.taskboard.list/claim/...` 由 Agent 经 `execute` 成功调用；原生 taskboard_* 形态依 Agent 宿主而定 |

**验收中修复**：占位符重名导致前端 token 变 undefined（Task 7 已修，`964f807` 前的 e75798a…见 ledger）；认领提示补充代码工具目录路径（`964f807`）。

**遗留人工项**（不影响自动化验收结论）：
1. 浏览器实际点按体验（拖拽/弹层/轮询）——按钮走的是已测 REST 路由；task_491f8b4a 故意留在「完成确认」列，可直接打开 `http://127.0.0.1:4370/` 亲自点「通过」收尾。
2. `/taskboard`、`/taskboard-claim` 命令的 TUI 触发（`opencode run` 无法触发斜杠命令，注册本身已验证）。

## Webapp 构建链 Spike 结论（2026-10-16，计划 2026-10-16-webapp-svelte-refactor.md Task 1）

- 版本：svelte 5.57.2 / vite 8.3.4 / @sveltejs/vite-plugin-svelte 7.3.1（webapp/ 本地 devDependencies）
- `bun x vite build` 直接可用，无需 node 回退；构建 253ms，产物 gzip 10.4KB
- token 占位符 `__TASKBOARD_TOKEN_VALUE__` 位于内联经典脚本，经构建原样保留（grep 断言 1 处）
- 固定文件名生效：`src/web/assets/board.js`（entryFileNames/chunkFileNames/assetFileNames 钉住），无 hash
- `emptyOutDir` 连带删除旧 vanilla 前端四文件——Task 2 的实质删除并入 Task 1 提交（589945d），保留每提交皆绿；Task 2 仅余测试删除与残留验证（boardKey grep 0 命中）
- 真实实例伺服验证 OK：重启+激活后首页注入真实 token（bb3c62b5…），`/assets/board.js` 200 / 25578B
- 运维注意：webapp/node_modules 由根 .gitignore 的 `node_modules/` 规则覆盖，无需追加

## Webapp Svelte 重构集成验收记录（2026-10-16，计划 2026-10-16-webapp-svelte-refactor.md Task 12）

环境：真实 OpenCode v2.0.30 共享服务 + playground 装载器；构建产物 board.js 65KB(gzip 25KB)/board.css 8.5KB。

| 项 | 结果 | 证据 |
|----|------|------|
| 服务重启激活与产物伺服 | ✅ | token 注入 bb3c62b5…；board.js/board.css 均 200 |
| SSE hello 帧与写广播 | ✅ | 连接即收 `{"type":"hello"}`；POST 任务后监听流收到含新任务 id 的 snapshot |
| 拖拽写路径与评论动作 | ✅ | PATCH status→pending、action:comment 服务端核验通过 |
| Agent 闭环（Code Mode 工具） | ✅ | task_56f944b7 claim→analyze→complete 达 completion_confirm，result=验收闭环完成，claim 保留会话 |
| 同项目双实例代理 | ✅（测试层） | test/proxy.test.ts：次要端口 health primary:false、经次要端口 claim/patch 落主实例存储 |
| 双实例真实环境 | ⚠️ 环境受限 | **新事实**：v2.0.30 插件 setup 按服务进程×项目只执行一次——同项目第二个 `opencode run` 不会生成次要实例（4371 未监听）；真实双实例需两个 service 进程。代理代码路径已由测试确定性覆盖 |
| 全量测试 | ✅ | bun test 82 例 11 文件全绿（含 5 例 SSE、10 例乐观协议、4 例 SSE 客户端、1 例双实例代理） |

**遗留人工项**：浏览器实际点按体验（新 UI 全交互：拖拽/详情面板/toast/主题切换）；TUI 斜杠命令触发。验收任务 task_56f944b7 特意留在「完成确认」列，打开 `http://127.0.0.1:4370/` 点「通过」即可体验收尾。

## 竖直泳道优化验收记录（2026-10-16，计划 2026-10-16-vertical-lanes.md）

- 布局改竖直泳道（用户决策）：状态 band 纵向堆叠、卡片 240px flex wrap、空 band 薄投递区、planning 空引导、状态色系（分析/执行蓝、确认列琥珀、完成灰）
- 新交互：确认列卡片 hover 快速通过/打回（打回跳详情面板展开表单）、Alt+↑/↓ 键盘跨泳道移动、乐观写入在途半透明+失败红闪、拖拽视口边缘自动纵滚、invalid_transition 文案可读化
- 测试：85 例全绿（+3 例 insertIndex 横向插入判定，drag 命中选择器同步改 `lane`）
- 真实冒烟：SMOKE-12-V-OK（产物含 lane 标记、快速通过 API 链路 completion_confirm→done、task_9b7a9652 留完成确认列供人工体验）
- 失败提示分工：快速通过失败静默红闪（双击高发防 toast 轰炸），其余路径红闪+toast

## 自动派发器 Spike（2026-10-16，计划 2026-10-16-auto-dispatcher.md Task 1）

- `ctx.session.create({ title })` 在插件 setup 内可用，返回 SessionInfo（含 id）
- `session.prompt({ sessionID, text })` 不指定 delivery 即入队 user 消息并触发 Agent 执行：约 0.5s 返回消息对象（fire-and-forget 友好），`session.wait({ sessionID })` 阻塞至空闲（实测 3.5s，含真实模型调用），`context` 返回 3 条消息（含 assistant 回复）
- 消息对象顶层是 `type`（user/assistant）而非 `role`
- 结论：自动派发器可按计划实现，无需降级「提醒器」；会话持久性由 dispatcher 的 get-失效重建路径兜底

## 自动派发器集成验收记录（2026-10-16，计划 2026-10-16-auto-dispatcher.md Task 6）

- 全链路实证（playground 真实环境，free 模型 worker）：autoDispatch 开 → pending 任务自动派发 → worker（持久会话）经 code-mode 工具领取 → analyze → requireAnalysisConfirm=true 时停在 analysis_confirm → **用户网页放行 → 执行唤醒自动 prompt worker → complete 至 completion_confirm → 用户确认 done**（task_056a97d5 全程日志可查）
- 自动续链 ✓：worker 完成提交后 dispatcher 识别其空闲，自动派发队列中下一个 pending（task_03925c31 → analyzing）
- 关开关 ✓：autoDispatch=false 后 25s 内新 pending 任务无人领取、无派发日志
- 控制机制实证：单飞门（awaitingClaim 期间跳过 worker-busy）、60s claim 检查触发连败与 60s 冷却、日计数持久化
- 验收中发现并修复的两个关键缺陷：
  1. 无单飞门时重复派发每 ~12s 打断 worker（60s 检查被重置永不触发，退避熔断全失效）——修复 awaitingClaim 门控（d3bd502）
  2. 分析确认放行后无人唤醒 worker——修复执行唤醒 nudge（fb5502e）；顺带确认规则：drag 进确认列清 claim 是人类接管的既有设计，放行走 action confirm 保留 claim
- 提示词教训：worker 会话继承全局 superpowers 技能，会把派发当计划先加载一堆 skill——派发 prompt 必须明令「直接行动、跳过 skill、第一步就 claim」（e733e71）；free 模型全程慢（领取约 60-90s），claim 检查 60s 属临界但冷却重试可兜底
- 风险实锤与遗留：worker 拥有全量工具（本次它自行创建 worktree 并移动了自己的会话）——下一轮建议在派发 prompt 中约束「不要创建 worktree/不要移动会话」，或考虑 worker 会话限权
