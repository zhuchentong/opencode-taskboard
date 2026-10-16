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
