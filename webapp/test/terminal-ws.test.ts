import { describe, expect, test } from "bun:test"
import {
  encodeTerminalInput,
  encodeTerminalResize,
  parseTerminalControl,
} from "../src/lib/terminal"

// 与 sidecar 的帧协议做真实 WebSocket 往返（bun 自带 WS 服务端，浏览器行为一致）：
// 浏览器 → sidecar：二进制帧 = 终端输入字节；文本帧 = JSON 控制消息。
// 这里把「帧类型」钉死：输入若被当成文本帧发，sidecar 会当控制消息忽略（终端敲键盘没反应）。

interface Received {
  /** 二进制帧的字节数 */
  binaryBytes: number
  /** 文本帧内容 */
  text: string
}

describe("WebSocket 帧协议往返", () => {
  test("终端输入发二进制帧、尺寸发文本帧，服务端能分别收到", async () => {
    const received: Received[] = []
    let resolveGot: () => void = () => {}
    const got = new Promise<void>((resolve) => (resolveGot = resolve))
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined as unknown as Response
        return new Response("no upgrade")
      },
      websocket: {
        message(_ws, message) {
          if (typeof message === "string") received.push({ binaryBytes: 0, text: message })
          else received.push({ binaryBytes: message.byteLength, text: "" })
          if (received.length >= 2) resolveGot()
        },
      },
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/ses_abc?token=t`)
    try {
      ws.onopen = () => {
        // 输入：编码成字节按二进制帧发
        ws.send(encodeTerminalInput("ls\r"))
        // 尺寸：JSON 控制消息，按文本帧发
        ws.send(encodeTerminalResize(120, 40))
      }
      await got
      // 一条二进制（3 字节 "ls\r"）+ 一条文本（resize JSON）
      expect(received.length).toBe(2)
      expect(received[0].binaryBytes).toBe(3)
      expect(received[0].text).toBe("")
      expect(received[1].binaryBytes).toBe(0)
      expect(received[1].text).toBe('{"type":"resize","cols":120,"rows":40}')
    } finally {
      ws.close()
      server.stop(true)
    }
  })

  test("服务端发二进制终端输出 + 文本控制帧，前端分别走 write 与 parse", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined as unknown as Response
        return new Response("no upgrade")
      },
      websocket: {
        open(ws) {
          // 二进制帧 = 终端输出；文本帧 = 控制消息
          ws.send(new TextEncoder().encode("TUI 渲染内容"))
          ws.send(JSON.stringify({ type: "exit", code: 0 }))
        },
      },
    })
    const outputs: string[] = []
    const controls: unknown[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/ses_abc?token=t`)
    ws.binaryType = "arraybuffer"
    let resolveGot: () => void = () => {}
    const got = new Promise<void>((resolve) => (resolveGot = resolve))
    try {
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const ctl = parseTerminalControl(ev.data)
          if (ctl) controls.push(ctl)
        } else {
          outputs.push(new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer)))
        }
        if (outputs.length + controls.length >= 2) resolveGot()
      }
      await got
      expect(outputs.join("")).toBe("TUI 渲染内容")
      expect(controls).toEqual([{ type: "exit", code: 0 }])
    } finally {
      ws.close()
      server.stop(true)
    }
  })
})
