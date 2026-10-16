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
