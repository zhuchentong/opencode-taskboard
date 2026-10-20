# terminal-sidecar —— opencode 会话的 web 终端桥接

把浏览器里的 xterm.js 通过 WebSocket 桥接到 **tmux 里运行的 opencode TUI**，从而在看板网页里直接打开某个 opencode session。

> ⚠️ **这是独立进程，不是插件的一部分。**
> 本仓库的 opencode 插件（`src/`）运行在 opencode daemon 进程内，**严禁**在插件/daemon 进程内 exec `opencode` CLI
> （实证：子进程 CLI 会干预 service 生命周期，导致 daemon 重启并连带杀死宿主会话）。
> 所以 sidecar 做成一个**需要用户手动启动**的独立 Node 进程：它自己就是「插件之外的第二个运行时」。

---

## 1. 它做什么

```
浏览器 xterm.js（看板「终端」Tab）
   │  ws://127.0.0.1:7681/ws/<sessionID>?token=<共享口令>
   ▼
terminal-sidecar（独立 Node 进程，tools/terminal-sidecar/）
   │  node-pty  →  tmux 会话 board-<sessionID>
   │                 └─ opencode --server <daemonURL> --session <sessionID> ─▶ opencode daemon
   └─ 执行前存在性校验：GET <daemonURL>/api/session/<id>（Basic 认证，密码取自 service.json）
```

关键行为：

| 行为 | 说明 |
| --- | --- |
| daemon 自动发现 | 从 `~/.local/state/opencode/service.json`（或 `$XDG_STATE_HOME/opencode/service.json`）读 `{url, password}`，**不硬编码端口** |
| 握手门禁 | token 必须匹配 + Origin 必须在白名单（CSWSH 收口），任一不过直接拒接 |
| 存在性校验 | 先 `GET /api/session/<id>`：200 才继续；404 / 401 / 不可达 → 给客户端发中文错误文本并关闭，**绝不 exec** |
| tmux 承载 | 每个 sessionID 一个 tmux 会话 `board-<sessionID>`，attach 语义（不存在才创建），刷新/重连不丢 TUI |
| 空闲回收 | 某 session 的客户端归零并持续超过 `--idle-timeout` → `tmux kill-session` |
| 显式关闭 | `POST /close/<sessionID>`（同样校验 token）→ 立即 kill 会话 |
| 死面板自愈 | TUI 退出（daemon 重启等）后 tmux 留死面板（remain-on-exit），重连时识别并重建 |

## 2. 环境要求

- **Node.js ≥ 20**（开发与验证使用 v24.18.0）
- **tmux ≥ 3.2**（需要 `new-session -e` 设置会话环境变量；验证使用 3.7c）
- 已在运行的 opencode 服务（`opencode service status` 可见），因为 sidecar 是**附着**到既有服务，不自己起服务

## 3. 安装与启动

```bash
cd tools/terminal-sidecar
npm install          # 只装 ws + node-pty 两个依赖
npm start -- --token <共享口令>
```

`node-pty` 是原生模块，需要编译链。npm 11 默认会拦截安装脚本，若 `npm install` 后启动报
「node-pty 不可用」，执行一次：

```bash
npm approve-scripts node-pty   # 或 npm rebuild node-pty
```

启动示例：

```bash
npm start -- --token s3cr3t --port 7681 --idle-timeout 30
```

### 启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--token <口令>` | **必填** | 浏览器与 sidecar 之间的静态共享口令 |
| `--port <端口>` | `7681` | 只绑 `127.0.0.1`（不对外暴露） |
| `--daemon <地址>` | 自动发现 | 覆盖 daemon 地址（如 `http://127.0.0.1:49898`）；**密码仍取自 service.json** |
| `--service-file <路径>` | `~/.local/state/opencode/service.json` | 覆盖服务注册文件路径 |
| `--idle-timeout <分钟>` | `30` | 客户端归零后的空闲回收时间；`0` 表示不回收 |
| `--allow-origin <地址>` | `http://127.0.0.1:4370`、`http://localhost:4370` | 追加允许的 Origin（可重复） |
| `-h, --help` | — | 帮助 |

> `--daemon` 只改地址不改凭据：daemon 的 Basic 认证密码只能从服务注册文件取。daemon 端口变更后**需要重启 sidecar**（自动发现只在启动时读一次）。

## 4. HTTP 接口

| 方法 | 路径 | 鉴权 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | `{"ok":true,"daemon":"http://127.0.0.1:49898","tmux":true}`（**不含密码**） |
| `POST` | `/close/<sessionID>` | 需要 token | `{"ok":true,"killed":true}`；token 缺失或错误 → `401` |

token 传递方式二选一：查询参数 `?token=<口令>`，或请求头 `Authorization: Bearer <口令>`。

```bash
curl http://127.0.0.1:7681/health
curl -X POST "http://127.0.0.1:7681/close/ses_xxx?token=<口令>"
```

## 5. WebSocket 接口与帧协议

```
ws://127.0.0.1:7681/ws/<sessionID>?token=<口令>
```

握手要求：

- `token` 必须与启动参数一致（不匹配 → 拒接 401，且**日志里不打印 token 值**）
- `Origin` 必须在白名单内（不在 → 拒接 403）；**空 Origin 放行**（非浏览器客户端）
- `sessionID` 只允许 `[A-Za-z0-9_-]`，否则拒接 400

### 帧格式

| 方向 | 帧类型 | 载荷 |
| --- | --- | --- |
| 浏览器 → sidecar | 二进制 | 终端输入的原始字节 |
| 浏览器 → sidecar | 文本 | JSON 控制消息，如 `{"type":"resize","cols":120,"rows":40}` |
| sidecar → 浏览器 | 二进制 | 终端输出的原始字节 |
| sidecar → 浏览器 | 文本 | JSON 控制消息：`{"type":"error","message":"会话不存在：xxx"}`、`{"type":"exit","code":0}` |

浏览器端实现要点：xterm.js 的 `onData` 回调给的是字符串，需要 `new TextEncoder().encode(data)` 后按**二进制帧**发送；
`onResize` 时发 `{"type":"resize","cols":term.cols,"rows":term.rows}` 文本帧；
收到文本帧时 `JSON.parse` 后按 `type` 分流（`error` 显示成提示文案，`exit` 提示 TUI 已退出）。

## 6. 与看板的接线

看板前端（任务 2）负责：

1. 在终端 Tab 内提供「终端设置」，把 sidecar 地址与 token 存到 localStorage
   （建议键名：`taskboard:terminal:sidecar-url`、`taskboard:terminal:token`）。
2. 仅当 `task.claim.sessionID` 存在且已配置 sidecar 时才显示「终端」Tab。
3. 按上面的帧协议连接 `ws://<sidecar-host>:<port>/ws/<sessionID>?token=<token>`。

sidecar 侧**不需要**看板做任何改动，也不参与看板的鉴权体系。

## 7. 验收步骤（人工）

> 下面第 3 步会启动 `opencode` CLI，**请在你自己的终端里执行**（会话内 exec opencode CLI 违反红线）。

1. 启动 sidecar：`npm start -- --token <口令>`
2. `curl http://127.0.0.1:7681/health` → `{"ok":true,...,"tmux":true}`
3. 在另一个终端里手工验证 TUI 渲染与 TTY 要求（含 256color）：

   ```bash
   tmux new-session -d -s probe -e TERM=tmux-256color -- opencode --server <daemonURL> --session <你的会话ID>
   tmux attach -t probe
   ```

4. 网页端打开任务详情 → 「终端」Tab → 应看到同一个 TUI，键盘输入可见
5. 刷新网页 → TUI 状态不丢（attach 语义）
6. 断开所有客户端并等待 `--idle-timeout` → `tmux ls` 里 `board-*` 会话消失
7. `POST /close/<sessionID>` → 会话立即消失，网页端显示「已退出」
8. 会话不存在时用浏览器连接 → 应显示「会话不存在：<id>」，且 `tmux ls` **不出现**新会话（绝不 exec）

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报「未找到 opencode 服务注册文件」 | opencode 服务没起，或用 `--service-file` 指定正确路径 |
| 启动报「opencode 服务注册文件解析失败」 | service.json 是坏 JSON（多为服务正在重启）；稍后重试 |
| 浏览器连上立刻断开，控制台 401 | token 与 `--token` 不一致 |
| 浏览器连上立刻断开，控制台 403 | 看板 origin 不在白名单：看板若跑在别的端口，用 `--allow-origin` 追加 |
| 终端里报认证失败 | daemon 凭据已过期：重启 sidecar 重新读 service.json |
| 终端里报「未检测到 tmux」 | 没装 tmux，或 tmux 不在 PATH |
| TUI 起来后一片空白/乱码 | 终端颜色能力不足：确认 xterm 主题是 256color，sidecar 固定 `TERM=tmux-256color` |
| 多个标签页同时打开 | 共享同一个 TUI，输入会交错、尺寸取最小客户端（已知取舍） |

## 9. 已知取舍与安全说明

- **静态共享 token**：保密性弱，localhost 威胁模型下可接受。
- **多标签 attach**：多个浏览器标签 attach 同一 tmux 会话 → 共享 TUI、输入交错、尺寸取最小客户端。
- **daemon 端口变更需重启 sidecar**：自动发现只在启动时读一次 service.json。
- **密码传递**：daemon 密码**不会**出现在命令行参数与日志里；它通过 tmux 会话环境变量
  `OPENCODE_SERVER_PASSWORD` 传给 TUI（opencode 客户端在 `--server` 模式下只从该环境变量读 Basic 认证密码）。
  同机同用户可以用 `tmux show-environment -t board-<id>` 看到它，属可接受范围（同用户本来就能读 service.json）。
- **日志脱敏**：日志器会把已知的 token / 密码替换成 `***`；拒接日志只记原因（`token 不匹配`、`Origin 不在白名单内`），不记凭据。
- **不做通用 shell**：sidecar 只允许打开 opencode session，命令固定为
  `opencode --server <daemonURL> --session <sessionID>`，且用**参数数组**执行、不经 shell。

## 10. 目录结构与测试

```
tools/terminal-sidecar/
├── package.json      # type: module，依赖 ws + node-pty，脚本 start / test
├── README.md
├── src/
│   ├── index.js         # CLI 入口（参数解析 → 发现 daemon → 起服务）
│   ├── config.js        # 参数解析 + service.json 解析 + daemon 发现
│   ├── auth.js          # token 比对（常量时间）+ Origin 白名单 + sessionID 校验
│   ├── session-check.js # 存在性校验（Basic 认证的 GET /api/session/<id>）
│   ├── tmux.js          # tmux 会话管理（建/查/杀/attach）
│   ├── idle.js          # 空闲回收（时钟可注入）
│   ├── protocol.js      # WS 帧协议常量与解析
│   ├── server.js        # HTTP + WS 服务（createSidecar，所有外部依赖可注入）
│   ├── pty.js           # node-pty 惰性加载
│   └── log.js           # 带脱敏的日志器
└── test/                # node --test 单测（外部依赖全部用假实现）
    ├── helpers.mjs      # 假 pty / 假时钟 / 假 tmux 命令
    └── cases/*.mjs      # 用例文件
```

> 用例文件放在 `test/cases/` 且**不用 `*.test.js` 命名**：仓库根的 `bun test` 会扫描全仓，
> 避免被 bun 的测试运行器误收（bun 与 node:test 的 API 行为有差异）。sidecar 自己的测试用 `npm test` 跑。

跑测试：

```bash
cd tools/terminal-sidecar
npm test        # node --test test/cases/*.mjs
```

单测**不会**真的启动 opencode：tmux 命令、pty、HTTP 校验、时钟全部是注入的假实现。
