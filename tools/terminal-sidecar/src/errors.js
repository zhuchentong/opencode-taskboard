/**
 * sidecar 运行期错误：面向用户的中文提示。
 * 原始错误（英文堆栈等）放在 cause 里，只进 debug 日志。
 */
export class SidecarError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = "SidecarError"
  }
}
