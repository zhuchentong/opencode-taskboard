#!/usr/bin/env node
/**
 * terminal-sidecar 启动入口（独立 Node 进程）。
 *
 * 红线提醒：本进程**不**跑在 opencode 插件/daemon 内部，是用户手起的独立进程，
 * 因此允许在这里启动 `opencode` CLI（TUI 客户端）。
 */

import { parseArgs, resolveServiceFilePath, discoverDaemon, ConfigError } from "./config.js"
import { createSidecar } from "./server.js"
import { createLogger } from "./log.js"

const HELP = `terminal-sidecar —— opencode 会话的 web 终端桥接（独立进程）

用法：
  node src/index.js --token <共享口令> [选项]

选项：
  --port <端口>            监听端口（默认 7681，只绑 127.0.0.1）
  --token <口令>           必填：浏览器与 sidecar 之间的静态共享口令
  --daemon <地址>          覆盖 daemon 地址（默认从服务注册文件自动发现）
  --service-file <路径>    覆盖服务注册文件路径（默认 ~/.local/state/opencode/service.json）
  --idle-timeout <分钟>    客户端归零后的空闲回收时间（默认 30；0 表示不回收）
  --allow-origin <地址>    追加允许的 Origin（可重复；默认含看板 origin）
  -h, --help               显示本帮助
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  const serviceFilePath = resolveServiceFilePath({ serviceFile: args.serviceFile })
  const { url: daemonUrl, password: daemonPassword } = await discoverDaemon({
    serviceFilePath,
    daemonOverride: args.daemon,
  })

  // 脱敏名单：token 与 daemon 密码都不许出现在日志里
  const logger = createLogger({ redact: [args.token, daemonPassword].filter(Boolean) })

  const config = {
    port: args.port,
    token: args.token,
    daemonUrl,
    daemonPassword,
    allowOrigins: args.allowOrigins,
    idleTimeoutMs: Math.round(args.idleTimeoutMinutes * 60 * 1000),
    serviceFilePath,
  }

  const sidecar = createSidecar({ config, logger })
  const { url: listenUrl } = await sidecar.listen(config.port)
  const tmuxReady = await sidecar.tmux.available()

  logger.info(`sidecar 已启动：${listenUrl}`)
  logger.info(`daemon：${daemonUrl}（服务注册文件：${serviceFilePath}）`)
  if (!tmuxReady) {
    logger.warn("未检测到 tmux：web 终端不可用，请先安装 tmux 后重启 sidecar")
  }
  logger.info(`Origin 白名单：${config.allowOrigins.join("、")}`)

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭 sidecar…`)
    await sidecar.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[sidecar] 启动失败：${err.message}`)
    process.exit(1)
  }
  console.error(`[sidecar] 启动失败：${err?.message ?? "未知错误"}`)
  process.exit(1)
})
