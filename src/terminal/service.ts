// opencode 服务（daemon）地址与凭据的发现。
//
// 硬要求：**不得硬编码 daemon 端口**。地址与凭据都从服务注册文件读：
//   ~/.local/state/opencode/service.json（或 $XDG_STATE_HOME/opencode/service.json）
// 内容形如 {id, version, url, pid, password}。
//
// 为什么插件内能直接读：插件跑在 daemon 进程里，daemon 就是自己——
// 但仍**不**走 exec `opencode` CLI（红线：子进程 CLI 干预 service 生命周期会致 daemon 重启），
// 只读本地文件 + 起 tmux 会话里的 TUI 客户端进程。

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** daemon 地址与凭据 */
export interface DaemonInfo {
  /** daemon 根地址（不带尾斜杠） */
  url: string
  /** daemon 密码（TUI 客户端据此做 Basic 认证） */
  password: string
}

/** 配置类错误：面向用户的中文提示 */
export class TerminalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalConfigError"
  }
}

/**
 * 解析服务注册文件路径。
 * 优先级：显式指定 > $XDG_STATE_HOME/opencode/service.json > ~/.local/state/opencode/service.json
 */
export function resolveServiceFilePath({
  serviceFile,
  env = process.env,
  home = homedir(),
}: {
  serviceFile?: string
  env?: Record<string, string | undefined>
  home?: string
} = {}): string {
  if (serviceFile) return serviceFile
  const stateHome = env.XDG_STATE_HOME
  if (stateHome) return join(stateHome, "opencode", "service.json")
  return join(home, ".local", "state", "opencode", "service.json")
}

/** 去掉末尾斜杠，保证拼接 /api/... 时不出现双斜杠 */
export function normalizeDaemonUrl(url: string): string {
  const trimmed = String(url).trim()
  if (!trimmed) throw new TerminalConfigError("daemon 地址不能为空")
  if (!/^https?:\/\//.test(trimmed)) {
    throw new TerminalConfigError(`daemon 地址必须以 http:// 或 https:// 开头：${trimmed}`)
  }
  if (/[\s'"`$;&|<>()\\]/.test(trimmed)) {
    throw new TerminalConfigError(`daemon 地址含有非法字符：${trimmed}`)
  }
  return trimmed.replace(/\/+$/, "")
}

/**
 * 解析服务注册文件内容。
 * @throws TerminalConfigError JSON 坏掉或缺字段
 */
export function parseServiceJson(text: string, path = "service.json"): DaemonInfo {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new TerminalConfigError(`opencode 服务注册文件解析失败：${path}（JSON 格式错误）`)
  }
  if (typeof data !== "object" || data === null) {
    throw new TerminalConfigError(`opencode 服务注册文件解析失败：${path}（内容不是对象）`)
  }
  const obj = data as { url?: unknown; password?: unknown }
  if (typeof obj.url !== "string" || !obj.url) {
    throw new TerminalConfigError(`opencode 服务注册文件缺少 url 字段：${path}`)
  }
  if (typeof obj.password !== "string" || !obj.password) {
    throw new TerminalConfigError(`opencode 服务注册文件缺少 password 字段：${path}`)
  }
  return { url: normalizeDaemonUrl(obj.url), password: obj.password }
}

/**
 * 发现 daemon 地址与凭据（读本地文件，不 exec 任何东西）。
 */
export async function discoverDaemon({
  serviceFilePath,
  readFileImpl = readFile,
}: {
  serviceFilePath?: string
  readFileImpl?: (path: string, encoding: "utf8") => Promise<string>
} = {}): Promise<DaemonInfo> {
  const path = serviceFilePath ?? resolveServiceFilePath()
  let text: string
  try {
    text = await readFileImpl(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new TerminalConfigError(
        `未找到 opencode 服务注册文件：${path}；请先启动 opencode 服务`,
      )
    }
    throw new TerminalConfigError(
      `读取 opencode 服务注册文件失败：${path}（${(err as Error)?.message ?? "未知错误"}）`,
    )
  }
  return parseServiceJson(text, path)
}
