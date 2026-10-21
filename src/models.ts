/** 模型清单聚合：阶段模型下拉的数据源（自 index.ts 拆出，纯本地文件读取，零 CLI 调用）。
 * ⚠️ 实证(2026-10-18):daemon 进程内 exec `opencode` CLI 会导致 daemon 重启(子进程 CLI
 * 干预 service 生命周期),严禁在插件进程内起 opencode 子进程 —— 本实现只读本地文件。
 * 数据源三路并集(等价 `opencode auth list` 的完整口径,但零 CLI 调用):
 * ① 全局 opencode 配置(providers 键;兼容 .json / .jsonc)——含自定义 provider 自带 models;
 * ② auth.json(~/.local/share/opencode/auth.json)已存凭据的 provider——只读键名,凭据值绝不读入;
 * ③ models.dev 元数据缓存(~/.cache/opencode/models.json)里 env 数组变量在环境中的知名 provider。
 * 模型展开 = 元数据 models ∪ 配置自带 models,剔 disabled(仅配置里显式声明的生效)。
 * 最后按全局配置的 policies(provider.use,last-match-wins)过滤——对齐 opencode
 * 「被拒 provider 从 catalog 与模型选择中消失,无论它从何而来」;项目级/系统级/Console
 * 政策不在本插件可见范围(只读全局文件),属已知边界。 */

import { MODELS_CACHE_TTL_MS } from "./constants"

/** 模型清单缓存(模块级,主次实例共用) */
let modelsCache: { at: number; list: string[] } | null = null

/** 剥 JSONC 注释(状态机):字符串外的行注释与块注释移除,字符串内(含 \" 转义)原样保留 */
export function stripJsonComments(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  let inStr = false
  while (i < n) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === `"`) inStr = false
      i++
      continue
    }
    if (c === `"`) {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 读全局 opencode 配置:.json 优先,解析失败回退 .jsonc(剥注释);都没有/都坏 → undefined */
async function readOpencodeConfig(
  home: string,
): Promise<{ providers?: unknown; policies?: unknown; experimental?: { policies?: unknown } } | undefined> {
  const base = `${home}/.config/opencode/opencode`
  try {
    return await Bun.file(`${base}.json`).json()
  } catch {
    // 回退 jsonc
  }
  try {
    return JSON.parse(stripJsonComments(await Bun.file(`${base}.jsonc`).text()))
  } catch {
    return undefined
  }
}

/** auth.json 只取 provider 键名(等价 `opencode auth list` 的 stored 行);缺文件/坏格式 → 空 */
async function readAuthProviderIDs(home: string): Promise<string[]> {
  try {
    const auth = await Bun.file(`${home}/.local/share/opencode/auth.json`).json()
    return Object.keys(auth ?? {})
  } catch {
    return []
  }
}

/** permissions 同款整值通配:* 匹配零或多字符,? 恰一字符,其余字符按字面量 */
function wildcardToRegExp(pattern: string): RegExp {
  const src = [...pattern]
    .map((c) => {
      if (c === "*") return ".*"
      if (c === "?") return "."
      return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
    .join("")
  return new RegExp(`^${src}$`)
}

/** provider.use 政策求值(语义对齐 opencode V2 文档 /v2/docs/policies):
 * 有序语句 **last-match-wins**(无特异度规则);无匹配 → 默认放行;
 * 非法语句(缺字段 / effect 非 allow|deny / resource 非字符串)按「被丢弃」处理,不参与匹配;
 * 只认 action === "provider.use",tool.use / integration.use 与模型清单无关。 */
export function providerAllowedByPolicies(providerID: string, statements: unknown[]): boolean {
  let allowed = true
  for (const s of statements) {
    if (typeof s !== "object" || s === null) continue
    const st = s as { action?: unknown; resource?: unknown; effect?: unknown }
    if (st.action !== "provider.use") continue
    if (typeof st.resource !== "string") continue
    if (st.effect !== "allow" && st.effect !== "deny") continue
    if (wildcardToRegExp(st.resource).test(providerID)) allowed = st.effect === "allow"
  }
  return allowed
}

/** 可注入 home/env 的模型清单;注入 opts(测试)绕过模块级缓存,避免跨 fixture 串数据 */
export async function listModels(opts?: { home?: string; env?: Record<string, string> }): Promise<string[]> {
  if (!opts && modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache.list
  const home = opts?.home ?? process.env.HOME ?? ""
  const env: Record<string, string | undefined> = opts?.env ?? process.env
  let list: string[] = []
  try {
    const cfg = await readOpencodeConfig(home)
    let meta: Record<string, { env?: string[]; models?: Record<string, unknown> }> | undefined
    try {
      meta = await Bun.file(`${home}/.cache/opencode/models.json`).json()
    } catch {
      // 元数据缺失只影响元数据来源,配置自带模型仍可用
    }
    const providers = (cfg?.providers ?? {}) as Record<string, { models?: Record<string, { disabled?: boolean }> }>
    // 政策语句:experimental.policies(旧键)在前,canonical policies 在后(last-match-wins 下后者有最终决定权)
    const policyStatements: unknown[] = [
      ...(Array.isArray(cfg?.experimental?.policies) ? (cfg.experimental.policies as unknown[]) : []),
      ...(Array.isArray(cfg?.policies) ? (cfg.policies as unknown[]) : []),
    ]
    const ids = new Set<string>([
      ...Object.keys(providers),
      ...(await readAuthProviderIDs(home)),
      ...Object.entries(meta ?? {})
        .filter(([, m]) => (m.env ?? []).some((e) => env[e] !== undefined && env[e] !== ""))
        .map(([id]) => id),
    ])
    for (const providerID of ids) {
      if (!providerAllowedByPolicies(providerID, policyStatements)) continue
      const cfgModels = providers[providerID]?.models ?? {}
      const disabled = new Set(Object.entries(cfgModels).filter(([, v]) => v?.disabled).map(([k]) => k))
      const modelIDs = new Set([...Object.keys(meta?.[providerID]?.models ?? {}), ...Object.keys(cfgModels)])
      for (const modelID of modelIDs) {
        if (!disabled.has(modelID)) list.push(`${providerID}/${modelID}`)
      }
    }
    list.sort()
  } catch {
    // 配置/元数据不可读:空列表,前端提示
    list = []
  }
  if (!opts) modelsCache = { at: Date.now(), list }
  return list
}
