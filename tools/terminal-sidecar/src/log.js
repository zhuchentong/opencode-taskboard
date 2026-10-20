/**
 * 日志器：统一前缀 + 机密值脱敏。
 *
 * 硬要求：日志里**不得**出现 daemon 密码与静态 token 明文。
 * 这里用「已知机密值替换成 ***」的方式兜底，而不是靠调用方自觉。
 */

/** 把值格式化成日志里可读的一行（对象走 JSON，其它走 String） */
function formatValue(value) {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 创建日志器。
 * @param {object} options
 * @param {string[]} [options.redact] 需要脱敏的机密值（token / 密码）
 * @param {(line: string) => void} [options.sink] 输出目标
 * @param {string} [options.prefix] 行前缀
 */
export function createLogger({ redact = [], sink, prefix = "[sidecar]" } = {}) {
  const secrets = redact.filter((s) => typeof s === "string" && s.length > 0)
  const write = sink ?? ((line) => console.log(line))

  /** 脱敏：把机密值替换成 *** */
  function scrub(text) {
    let out = String(text)
    for (const secret of secrets) {
      while (out.includes(secret)) out = out.replace(secret, "***")
    }
    return out
  }

  function emit(level, args) {
    const body = args.map(formatValue).join(" ")
    write(scrub(`${prefix} ${level} ${body}`))
  }

  return {
    info: (...args) => emit("信息", args),
    warn: (...args) => emit("警告", args),
    error: (...args) => emit("错误", args),
    scrub,
  }
}

/** 静默日志器（测试用） */
export function createSilentLogger() {
  return createLogger({ sink: () => {} })
}
