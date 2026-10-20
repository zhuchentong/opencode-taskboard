/**
 * 启动参数解析 + opencode 服务（daemon）自动发现。
 *
 * 硬要求：**不得硬编码 daemon 端口**。地址与凭据都从服务注册文件读：
 *   ~/.local/state/opencode/service.json（或 $XDG_STATE_HOME/opencode/service.json）
 * 内容形如 {id, version, url, pid, password}。
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_PORT = 7681
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30
/** 看板默认 origin（127.0.0.1 与 localhost 是同一台机器的两种写法，都放行） */
export const DEFAULT_ALLOW_ORIGINS = ["http://127.0.0.1:4370", "http://localhost:4370"]
/** 静态共享口令的最小长度：太短的口令容易被猜中 */
export const MIN_TOKEN_LENGTH = 8

/** 参数/配置类错误：面向用户的中文提示 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "ConfigError"
  }
}

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {{port:number, token:string, daemon?:string, serviceFile?:string, idleTimeoutMinutes:number, allowOrigins:string[], help:boolean}}
 */
export function parseArgs(argv = []) {
  const result = {
    port: DEFAULT_PORT,
    token: "",
    daemon: undefined,
    serviceFile: undefined,
    idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    allowOrigins: [...DEFAULT_ALLOW_ORIGINS],
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    /** 取参数值：支持 `--k v` 与 `--k=v` 两种写法 */
    const takeValue = (name) => {
      const eq = arg.indexOf("=")
      if (eq > 0) return arg.slice(eq + 1)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) throw new ConfigError(`参数 ${name} 缺少取值`)
      i += 1
      return next
    }
    const name = arg.split("=")[0]

    switch (name) {
      case "--port": {
        const raw = takeValue("--port")
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ConfigError(`--port 取值非法：${raw}（应为 1-65535 的整数）`)
        }
        result.port = port
        break
      }
      case "--token":
        result.token = takeValue("--token")
        break
      case "--daemon":
        result.daemon = takeValue("--daemon")
        break
      case "--service-file":
        result.serviceFile = takeValue("--service-file")
        break
      case "--idle-timeout": {
        const raw = takeValue("--idle-timeout")
        const minutes = Number(raw)
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new ConfigError(`--idle-timeout 取值非法：${raw}（应为不小于 0 的分钟数，0 表示不回收）`)
        }
        result.idleTimeoutMinutes = minutes
        break
      }
      case "--allow-origin": {
        const origin = takeValue("--allow-origin").trim()
        if (!origin) throw new ConfigError("--allow-origin 取值不能为空")
        if (!result.allowOrigins.includes(origin)) result.allowOrigins.push(origin)
        break
      }
      case "--help":
      case "-h":
        result.help = true
        break
      default:
        throw new ConfigError(`未知参数：${arg}`)
    }
  }

  if (!result.help) {
    if (!result.token) throw new ConfigError("缺少必填参数 --token（浏览器与 sidecar 之间的静态共享口令）")
    if (result.token.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(`--token 至少需要 ${MIN_TOKEN_LENGTH} 个字符（口令太短容易被猜中）`)
    }
    if (result.daemon !== undefined) result.daemon = normalizeDaemonUrl(result.daemon)
  }

  return result
}

/** 去掉末尾斜杠，保证拼接 /api/... 时不出现双斜杠 */
export function normalizeDaemonUrl(url) {
  const trimmed = String(url).trim()
  if (!trimmed) throw new ConfigError("daemon 地址不能为空")
  if (!/^https?:\/\//.test(trimmed)) {
    throw new ConfigError(`daemon 地址必须以 http:// 或 https:// 开头：${trimmed}`)
  }
  if (/[\s'"`$;&|<>()\\]/.test(trimmed)) {
    throw new ConfigError(`daemon 地址含有非法字符：${trimmed}`)
  }
  return trimmed.replace(/\/+$/, "")
}

/**
 * 解析服务注册文件路径。
 * 优先级：--service-file > $XDG_STATE_HOME/opencode/service.json > ~/.local/state/opencode/service.json
 */
export function resolveServiceFilePath({ serviceFile, env = process.env, home = homedir() } = {}) {
  if (serviceFile) return serviceFile
  const stateHome = env.XDG_STATE_HOME
  if (stateHome) return join(stateHome, "opencode", "service.json")
  return join(home, ".local", "state", "opencode", "service.json")
}

/**
 * 解析 service.json 内容。
 * @throws {ConfigError} JSON 坏掉或缺字段
 */
export function parseServiceJson(text, { path = "service.json" } = {}) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new ConfigError(`opencode 服务注册文件解析失败：${path}（JSON 格式错误）`)
  }
  if (typeof data !== "object" || data === null) {
    throw new ConfigError(`opencode 服务注册文件解析失败：${path}（内容不是对象）`)
  }
  if (typeof data.url !== "string" || !data.url) {
    throw new ConfigError(`opencode 服务注册文件缺少 url 字段：${path}`)
  }
  if (typeof data.password !== "string" || !data.password) {
    throw new ConfigError(`opencode 服务注册文件缺少 password 字段：${path}`)
  }
  return {
    id: typeof data.id === "string" ? data.id : "",
    version: typeof data.version === "string" ? data.version : "",
    url: normalizeDaemonUrl(data.url),
    pid: typeof data.pid === "number" ? data.pid : undefined,
    password: data.password,
  }
}

/**
 * 发现 daemon 地址与凭据。
 * --daemon 只覆盖地址；密码仍从服务注册文件取（Basic 认证需要）。
 */
export async function discoverDaemon({
  serviceFilePath,
  daemonOverride,
  readFileImpl = readFile,
} = {}) {
  let text
  try {
    text = await readFileImpl(serviceFilePath, "utf8")
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new ConfigError(
        `未找到 opencode 服务注册文件：${serviceFilePath}；请先启动 opencode 服务，或用 --service-file 指定路径`,
      )
    }
    throw new ConfigError(`读取 opencode 服务注册文件失败：${serviceFilePath}（${err?.message ?? "未知错误"}）`)
  }

  const info = parseServiceJson(text, { path: serviceFilePath })
  const url = daemonOverride ? normalizeDaemonUrl(daemonOverride) : info.url
  return { url, password: info.password, serviceFilePath }
}
