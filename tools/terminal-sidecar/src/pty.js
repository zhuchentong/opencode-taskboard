/**
 * node-pty 的惰性加载。
 *
 * 为什么要惰性：node-pty 是原生模块（需要编译），单测不需要它，
 * 惰性加载能让「跑测试」与「装好依赖才能跑」解耦。
 */

/** 加载并缓存 node-pty 模块 */
export async function loadPty() {
  try {
    const mod = await import("node-pty")
    return mod.default ?? mod
  } catch (err) {
    throw new Error(
      `node-pty 不可用：${err?.message ?? "未知错误"}；请在 tools/terminal-sidecar 目录执行 npm install（原生模块需要编译链）`,
    )
  }
}

/**
 * 默认的 pty 启动器（生产路径用）。
 * @param {string} file 可执行文件
 * @param {string[]} args 参数数组
 * @param {object} options node-pty 启动选项
 */
export async function defaultSpawnPty(file, args, options) {
  const pty = await loadPty()
  return pty.spawn(file, args, options)
}
