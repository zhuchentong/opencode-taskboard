# opencode-taskboard

OpenCode V2 任务看板插件：七阶段工作流（待规划 → 待领取 → 分析中 → 分析确认 → 执行中 → 完成确认 → 已完成），Agent 经 `taskboard_*` 工具认领任务，用户在网页看板上规划、放行、验收。前端为 Svelte 5 构建（产物已入库，安装无需 Node 工具链）。

## 安装（用户）

1. 拷贝 `src/` 到你的项目（或作为依赖引入）；
2. 在项目 `.opencode/plugins/` 下放装载器文件（v2.0.30 的 `plugins` 配置键不加载本地路径）：

```ts
// .opencode/plugins/taskboard-loader.ts
import plugin from "<taskboard-src 绝对路径>/index.ts"
export default plugin
```

3. 重启 OpenCode 服务（`opencode service restart`）并开一个会话激活插件；
4. 浏览器打开 `http://127.0.0.1:4370/`（被占用时端口自动上移，URL 见会话内 `/taskboard` 命令输出）。

## 命令与工具

- `/taskboard`：输出看板 URL 与使用说明；`/taskboard-claim`：让 Agent 认领并完成一个待领取任务
- Agent 工具（代码工具目录 `tools.taskboard.*`，或原生 `taskboard_*`）：`list` `get` `claim` `analyze` `complete` `release` `update`
- Agent 不可标记完成/修改状态：`complete` 只到「完成确认」，用户确认才进「已完成」；打回必须附评论

## 开发

```bash
bun install              # 根依赖（postinstall 会自动装 webapp 依赖）
bun test                 # 全量测试：服务端 + 前端纯函数
bun run dev              # Mock 模式跑看板（内存后端，免 OpenCode，token=dev）
cd webapp && bun install # 单独重装前端依赖（正常由根 bun install 自动完成）
bun run dev:web          # 前端 HMR（/api 代理到 4370，token 兜底 dev，配合 bun run dev 使用）
bun run build:web        # 重建前端产物到 src/web/（需提交）
bun run watch:web        # 产物 watch 构建
```

文档：设计规格与验收记录见 `docs/superpowers/`。
