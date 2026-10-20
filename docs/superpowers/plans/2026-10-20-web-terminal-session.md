# 计划：web 终端打开 opencode session（任务详情弹窗「终端」Tab）

## 背景与目标

当前「上下文」Tab 以消息流形式展示 worker 会话（Markdown + 实时增量）。用户希望改为：**在网页里通过 web 终端打开 opencode session**，用 opencode TUI 原生的显示与交互。

约束：终端**只用于打开 opencode session**，不做通用 shell（攻击面收敛到会话级）。

## 已验证事实（本计划的事实基线，均已实测）

| 事实 | 证据 |
|---|---|
| `opencode --server <url>` = 连指定服务而非管理后台服务（纯客户端附着） | `opencode --help` |
| `opencode --session <id>` = 继续指定会话；**不存在会静默新建** | `opencode --help` → 必须先做存在性校验 |
| daemon 服务注册文件含 url 与 password | `~/.local/state/opencode/service.json` = `{id, version, url, pid, password}` |
| daemon API 在 `/api/` 前缀下，需 Basic 认证（用户名 `opencode`） | `GET /api/session` 无凭证 → 401 `UnauthorizedError` |
| `GET /api/session/{id}` 存在 → 200；不存在 → 404 `SessionNotFoundError` | 实测（Basic 认证） |
| **会话对象自带 `location.directory`**（= 会话自身工作目录，实测与 project canonical 一致）→ TUI cwd 的权威来源 | `GET /api/session/{id}` 响应体 `{data:{id, projectID, …, location:{directory}}}` |
| `GET /api/project/{id}` → 404；项目列表在 `GET /api/project` | 实测（Basic 认证）→ 无需再按 projectID 反查目录 |
| **Origin 白名单含 `http://127.0.0.1:4370` 与 `http://localhost:4370`**（同一台机器的看板两种写法）+ 空 Origin | 复审裁定采纳（防止后人当偏离删掉 localhost 那条） |
| `opencode --standalone` 是私有服务，**不用** | `--help` |
| 环境：tmux 3.7c ✅、node v24.18.0 ✅、node-pty 编译链齐 ✅、ttyd 未装 | 实测 |
| 看板 127.0.0.1:4370；daemon 端口 49898（可 `opencode service set port` 变更） | 实测；日志有 196 条端口冲突记录 → **不得硬编码端口** |

**红线（AGENTS.md）**：严禁在插件/daemon 进程内 exec `opencode` CLI（实证子进程 CLI 干预 service 生命周期致 daemon 重启、连带杀死宿主会话）。→ sidecar 必须是**用户手起的独立进程**；插件与看板服务端全程不 exec 任何东西。

## 架构

```
浏览器 xterm.js（看板「终端」Tab 内）
   │  ws://127.0.0.1:7681/ws/<sessionID>?token=<token>
   ▼
terminal-sidecar（独立 Node 进程，tools/terminal-sidecar/）
   │  node-pty  →  tmux 会话 board-<sessionID>（default-terminal=tmux-256color）
   │                 └─ opencode --server <daemonURL> --session <sessionID> ─▶ daemon
   └─ 存在性校验：GET <daemonURL>/api/session/<id>（Basic 认证，密码取自 service.json）
```

## 组件规格

### A. sidecar（`tools/terminal-sidecar/`，独立 Node 项目）

- `package.json`（type: module）、依赖 `ws`、`node-pty`；脚本：`start`、`test`（`node --test`）。
- 启动参数：`--port`（默认 7681）、`--token`（必填，静态共享口令）、`--daemon`（可选覆盖 daemon URL）、`--service-file`（可选覆盖 service.json 路径）、`--idle-timeout`（默认 30 分钟）。
- **daemon 地址与凭据自动发现**：读 `~/.local/state/opencode/service.json`（或 `$XDG_STATE_HOME/opencode/service.json`）取 url + password；`--daemon` 可覆盖。禁止硬编码端口。
- WS 路由：`/ws/<sessionID>?token=<token>`。
- **握手门禁（CSWSH 收口）**：token 必须匹配（不匹配 → 拒接）；Origin 必须在白名单（看板 origin `http://127.0.0.1:4370` 与 `http://localhost:4370` + 空 Origin；可配 `--allow-origin`）。二者任一不过 → 拒接并记日志（不打印 token 值）。
- **执行前存在性校验**：`GET <daemonURL>/api/session/<id>`；200 → 继续；404 → 回一条明确的错误文本（会话不存在），**不 exec**；daemon 不可达 → 回错误文本，不 exec。
- **cwd 解析（终审修订，实测已推翻「会话对象无目录字段」的旧前提）**：会话对象**自带** `location.directory`，即会话自身的工作目录（实测与 project canonical 一致）→ 直接作为 TUI 工作目录；解析失败（字段缺失/目录不存在）→ 回退用户 home，不报错。无需再按 projectID 反查项目目录。
- **spawn 用参数数组**（不经 shell，防注入）：`["--server", daemonURL, "--session", sessionID]`，cwd 取上一步解析出的会话工作目录 `location.directory`（兜底 home）。
- **tmux 承载**：每个 sessionID 对应 tmux 会话 `board-<sessionID>`（`tmux new-session -A -s ...` attach 语义，浏览器刷新/断线重连不丢 TUI）；默认 TERM=tmux-256color。tmux 不存在 → 明确报错并提示安装。
- **生命周期模型（终审修订，简化）**：TUI 是该 tmux 会话的唯一进程，退出即会话消失（**不设 remain-on-exit**）——因此「会话存在 ⇔ TUI 活着」，重连逻辑退化为：`has-session` 命中 → attach，未命中 → 新建。无需死 pane 检测。
- **回收**：某 session 的 WS 客户端归零且持续超过 `--idle-timeout` → `tmux kill-session -t board-<id>`。
- **显式关闭**：提供 `POST /close/<sessionID>`（同样 token 校验）→ kill tmux 会话。
- **启动健壮性（终审核实）**：`--port` 被占用 → 立即以明确中文错误退出（不自动换端口——看板配置指向固定地址）；SIGINT/SIGTERM 优雅退出只关自身监听与 PTY 客户端，**不动 tmux 会话**（跨重启持久是设计目标）。
- **可测性**：spawn 动作经依赖注入（`spawnPty` 参数），单测用假实现（spawn `cat` 之类）跑通握手/鉴权/404/回收路径，**不碰 opencode CLI**。
- README：安装、启动、参数、与看板的接线、验收步骤、故障排查。

### B. 看板前端（`webapp/`）

- 任务详情弹窗（`TaskDetail.svelte`，bits-ui Tabs）新增「终端」Tab。
  - **仅当** `task.claim?.sessionID` 存在 **且** 已配置 sidecar（localStorage）时显示该 Tab。
  - 终端内容区需要固定高度（xterm 用 ResizeObserver + `addon-fit` 跟随容器尺寸）。
- 配置项（localStorage，与既有 `taskboard:context:show-reasoning` 同款容错读写）：
  - `taskboard:terminal:sidecar-url`（如 `http://127.0.0.1:7681`）
  - `taskboard:terminal:token`
  - 配置 UI：终端 Tab 内提供「终端设置」（sidecar 地址 + token + 保存），未配置时提示如何配置。
- 纯函数 `sidecarWsUrl(base, sessionID, token)` 入 `webapp/src/lib/` + bun 用例（URL 拼接、token 编码、base 归一化去尾斜杠、非法输入）。
- **连接生命周期**：WS 与 xterm 实例按「任务 ID + 会话 ID」收敛（参照 `ContextView` 的 `liveKey` 模式）——看板快照频繁重渲染不得重建连接；切出终端 Tab / 关闭弹窗 → 主动断开 WS（tmux 保状态，重进秒级重 attach）。
- 依赖：`@xterm/xterm` + `@xterm/addon-fit`，**静态引入不做分包**（board.js 约 +250KB）。
- 产物：改 webapp 必须 `bun run build:web` 重建 `src/web/` 并入库。

## 明确不做

多用户 / 非 localhost 暴露、通用 shell 终端、语法高亮、sidecar 并入插件进程、**看板服务端任何改动**、在会话内 exec opencode CLI。

## 已知取舍

静态共享 token 保密性弱（localhost 威胁模型可接受）；多标签 attach 同一 tmux 会话 → 输入交错、尺寸取最小客户端；配置存 localStorage 不跨浏览器；daemon 端口变更需重启 sidecar（自动发现仅在启动时读取）。

## 实施步骤

1. **任务 1：sidecar**（`tools/terminal-sidecar/`）——独立 Node 项目：WS 服务、token+Origin 门禁、存在性校验、tmux 承载、idle 回收、显式关闭、README、`node --test` 单测。
2. **任务 2：看板前端**（`webapp/`）——终端 Tab、配置项与设置 UI、`sidecarWsUrl` 纯函数 + 用例、WS/term 生命周期收敛、xterm 接入、`bun run build:web` 产物入库。
3. **任务 3：集成验收**——自动门（两树 bun test + node --test + build:web）全绿；人工门为下方 5 项 spike（**须用户在自己终端执行**，会话内 exec opencode CLI 违反红线）。

## 验收标准

自动：`bun test`（根）全绿；`cd webapp && bun test` 全绿；`cd tools/terminal-sidecar && npm test` 全绿；`bun run build:web` 干净且产物入库。

人工 spike（用户终端）：
1. `opencode --server <daemonURL> --session <worker会话>` 在 tmux 内的渲染质量与 TTY 要求（含 256color）；
2. worker 回合进行中附着的只读性与输入排队行为；
3. TUI 全生命周期（打开/退出/daemon 重启后重连）**不引起 service 状态变化**（红线实证）；
4. 双标签 attach 同一 tmux 会话体验；
5. 会话不存在时 `--session` 的实际行为（配合 sidecar 的 404 短路）。
