/**
 * SSE 流测试辅助（server-sse / server-live 共用，解析逻辑单点维护）：
 * 逐帧读取 SSE 流，nextEvent 返回下一条 `data:` 帧的 T（跳过 `: ping` 等注释帧）；
 * closedWithin 断言流在超时内关闭（一帧即关的端点用）。
 */
export class SseReader<T> {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private buf = ""
  private decoder = new TextDecoder()

  constructor(res: Response) {
    this.reader = (res.body as ReadableStream<Uint8Array>).getReader()
  }

  async nextEvent(timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const idx = this.buf.indexOf("\n\n")
      if (idx >= 0) {
        const frame = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n")
        if (!data) continue // 注释帧（心跳）无 data 行
        return JSON.parse(data) as T
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("等待 SSE 事件超时")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 SSE 事件超时")), remaining)
        this.reader
          .read()
          .then((r) => {
            clearTimeout(timer)
            if (r.done) {
              reject(new Error("SSE 流意外结束"))
            } else {
              this.buf += this.decoder.decode(r.value, { stream: true })
              resolve()
            }
          })
          .catch((e) => {
            clearTimeout(timer)
            reject(e instanceof Error ? e : new Error(String(e)))
          })
      })
    }
  }

  /** 等待流关闭：下一次 read 应 done；超时仍未关返回 false */
  async closedWithin(timeoutMs = 3000): Promise<boolean> {
    const done = this.reader.read().then((r) => r.done)
    const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    return Promise.race([done, timer])
  }
}
