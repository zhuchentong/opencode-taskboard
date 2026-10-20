import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ALLOWED_ORIGINS,
  TERMINAL_TOKEN_KEY,
  TERMINAL_URL_KEY,
  currentOrigin,
  emptyTerminalConfig,
  encodeTerminalBinary,
  encodeTerminalInput,
  encodeTerminalResize,
  loadTerminalConfig,
  originNeedsAllowOrigin,
  parseTerminalControl,
  saveTerminalConfig,
  sidecarWsUrl,
  terminalAvailable,
  terminalConnKey,
  type TerminalStorage,
} from "../src/lib/terminal"

/** 假 localStorage：可模拟「读取抛错」「写入抛错」两种异常路径 */
function fakeStorage(initial: Record<string, string> = {}): TerminalStorage & {
  data: Record<string, string>
} {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem(key: string) {
      return key in data ? data[key] : null
    },
    setItem(key: string, value: string) {
      data[key] = value
    },
  }
}

describe("sidecarWsUrl", () => {
  test("http → ws 且去尾斜杠", () => {
    expect(sidecarWsUrl("http://127.0.0.1:7681", "ses_abc", "tok")).toBe(
      "ws://127.0.0.1:7681/ws/ses_abc?token=tok",
    )
    expect(sidecarWsUrl("http://127.0.0.1:7681/", "ses_abc", "tok")).toBe(
      "ws://127.0.0.1:7681/ws/ses_abc?token=tok",
    )
    expect(sidecarWsUrl("  http://127.0.0.1:7681  ", "ses_abc", "tok")).toBe(
      "ws://127.0.0.1:7681/ws/ses_abc?token=tok",
    )
  })

  test("https → wss", () => {
    expect(sidecarWsUrl("https://sidecar.local", "ses_abc", "tok")).toBe(
      "wss://sidecar.local/ws/ses_abc?token=tok",
    )
  })

  test("ws / wss 原样保留", () => {
    expect(sidecarWsUrl("ws://127.0.0.1:7681", "ses_abc", "tok")).toBe(
      "ws://127.0.0.1:7681/ws/ses_abc?token=tok",
    )
    expect(sidecarWsUrl("wss://sidecar.local", "ses_abc", "tok")).toBe(
      "wss://sidecar.local/ws/ses_abc?token=tok",
    )
  })

  test("保留 base 的路径前缀（反向代理场景）", () => {
    expect(sidecarWsUrl("http://127.0.0.1:7681/term/", "ses_abc", "tok")).toBe(
      "ws://127.0.0.1:7681/term/ws/ses_abc?token=tok",
    )
  })

  test("sessionID 与 token 都做 URL 编码", () => {
    const url = sidecarWsUrl("http://127.0.0.1:7681", "ses a/b", "to k&x=1")
    expect(url).toBe("ws://127.0.0.1:7681/ws/ses%20a%2Fb?token=to%20k%26x%3D1")
    // 编码后 sidecar 侧解码回来仍是原值
    const parsed = new URL(url)
    expect(decodeURIComponent(parsed.pathname)).toBe("/ws/ses a/b")
    expect(parsed.searchParams.get("token")).toBe("to k&x=1")
  })

  test("非法 base 返回空串（调用方按未配置处理）", () => {
    expect(sidecarWsUrl("", "ses_abc", "tok")).toBe("")
    expect(sidecarWsUrl("不是地址", "ses_abc", "tok")).toBe("")
    expect(sidecarWsUrl("127.0.0.1:7681", "ses_abc", "tok")).toBe("")
    expect(sidecarWsUrl("ftp://127.0.0.1", "ses_abc", "tok")).toBe("")
  })

  test("缺 sessionID 或 token 返回空串", () => {
    expect(sidecarWsUrl("http://127.0.0.1:7681", "", "tok")).toBe("")
    expect(sidecarWsUrl("http://127.0.0.1:7681", "ses_abc", "")).toBe("")
  })
})

describe("终端配置读写", () => {
  test("无 storage → 空配置", () => {
    expect(loadTerminalConfig(null)).toEqual(emptyTerminalConfig())
  })

  test("读取已存配置并去空白", () => {
    const s = fakeStorage({
      [TERMINAL_URL_KEY]: "  http://127.0.0.1:7681  ",
      [TERMINAL_TOKEN_KEY]: " s3cr3t ",
    })
    expect(loadTerminalConfig(s)).toEqual({ sidecarUrl: "http://127.0.0.1:7681", token: "s3cr3t" })
  })

  test("读取抛错（隐私模式）→ 空配置且不抛异常", () => {
    const broken: TerminalStorage = {
      getItem() {
        throw new Error("boom")
      },
      setItem() {},
    }
    expect(loadTerminalConfig(broken)).toEqual(emptyTerminalConfig())
  })

  test("保存写入两个键并去空白", () => {
    const s = fakeStorage()
    saveTerminalConfig({ sidecarUrl: " http://127.0.0.1:7681 ", token: " tok " }, s)
    expect(s.data[TERMINAL_URL_KEY]).toBe("http://127.0.0.1:7681")
    expect(s.data[TERMINAL_TOKEN_KEY]).toBe("tok")
  })

  test("写入抛错 → 静默忽略不抛异常", () => {
    const broken: TerminalStorage = {
      getItem: () => null,
      setItem() {
        throw new Error("quota")
      },
    }
    expect(() => saveTerminalConfig({ sidecarUrl: "http://x", token: "t" }, broken)).not.toThrow()
  })

  test("保存后能原样读回", () => {
    const s = fakeStorage()
    saveTerminalConfig({ sidecarUrl: "http://127.0.0.1:7681", token: "s3cr3t" }, s)
    expect(loadTerminalConfig(s)).toEqual({ sidecarUrl: "http://127.0.0.1:7681", token: "s3cr3t" })
  })
})

describe("terminalAvailable", () => {
  const cfg = { sidecarUrl: "http://127.0.0.1:7681", token: "s3cr3t" }

  test("配置齐全 + 有会话 ID → 可用", () => {
    expect(terminalAvailable(cfg, "ses_abc")).toBe(true)
  })

  test("缺会话 ID → 不可用", () => {
    expect(terminalAvailable(cfg, "")).toBe(false)
    expect(terminalAvailable(cfg, undefined)).toBe(false)
    expect(terminalAvailable(cfg, null)).toBe(false)
  })

  test("缺配置 → 不可用", () => {
    expect(terminalAvailable({ sidecarUrl: "", token: "s3cr3t" }, "ses_abc")).toBe(false)
    expect(terminalAvailable({ sidecarUrl: "http://127.0.0.1:7681", token: "" }, "ses_abc")).toBe(false)
    expect(terminalAvailable(emptyTerminalConfig(), "ses_abc")).toBe(false)
  })

  test("地址非法 → 不可用", () => {
    expect(terminalAvailable({ sidecarUrl: "不是地址", token: "s3cr3t" }, "ses_abc")).toBe(false)
  })
})

describe("控制帧编解码", () => {
  test("解析 error 帧", () => {
    expect(parseTerminalControl('{"type":"error","message":"会话不存在：xxx"}')).toEqual({
      type: "error",
      message: "会话不存在：xxx",
    })
  })

  test("解析 exit 帧（缺 code 按 0）", () => {
    expect(parseTerminalControl('{"type":"exit","code":0}')).toEqual({ type: "exit", code: 0 })
    expect(parseTerminalControl('{"type":"exit"}')).toEqual({ type: "exit", code: 0 })
  })

  test("解析 resize 帧", () => {
    expect(parseTerminalControl('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    })
  })

  test("非法 JSON / 未知类型 / 形状不对 → null", () => {
    expect(parseTerminalControl("不是 JSON")).toBeNull()
    expect(parseTerminalControl("[]")).toBeNull()
    expect(parseTerminalControl('{"type":"unknown"}')).toBeNull()
    expect(parseTerminalControl('{"type":"error"}')).toBeNull()
    expect(parseTerminalControl('{"type":"resize","cols":"120","rows":40}')).toBeNull()
  })

  test("resize 帧编码为 JSON 文本", () => {
    expect(encodeTerminalResize(120, 40)).toBe('{"type":"resize","cols":120,"rows":40}')
  })

  test("终端输入编码为 UTF-8 字节（供二进制帧发送）", () => {
    expect(Array.from(encodeTerminalInput("a"))).toEqual([0x61])
    expect(Array.from(encodeTerminalInput("中"))).toEqual([0xe4, 0xb8, 0xad])
  })

  test("二进制输入按字节截断", () => {
    expect(Array.from(encodeTerminalBinary("\u0001"))).toEqual([0x01])
  })
})

describe("terminalConnKey", () => {
  test("同任务同会话同配置 → 同键", () => {
    expect(terminalConnKey("t1", "ses_abc", "http://127.0.0.1:7681", "tok")).toBe(
      terminalConnKey("t1", "ses_abc", "http://127.0.0.1:7681", "tok"),
    )
  })

  test("换任务 / 换会话 / 换配置 → 不同键", () => {
    const base = terminalConnKey("t1", "ses_abc", "http://127.0.0.1:7681", "tok")
    expect(terminalConnKey("t2", "ses_abc", "http://127.0.0.1:7681", "tok")).not.toBe(base)
    expect(terminalConnKey("t1", "ses_xyz", "http://127.0.0.1:7681", "tok")).not.toBe(base)
    expect(terminalConnKey("t1", "ses_abc", "http://127.0.0.1:9999", "tok")).not.toBe(base)
    expect(terminalConnKey("t1", "ses_abc", "http://127.0.0.1:7681", "tok2")).not.toBe(base)
  })
})

describe("Origin 白名单提示", () => {
  test("默认白名单内的 Origin 不需要 --allow-origin", () => {
    for (const o of DEFAULT_ALLOWED_ORIGINS) {
      expect(originNeedsAllowOrigin(o)).toBe(false)
    }
    expect(originNeedsAllowOrigin("")).toBe(false)
  })

  test("其它 Origin 需要 --allow-origin", () => {
    expect(originNeedsAllowOrigin("http://127.0.0.1:4371")).toBe(true)
    expect(originNeedsAllowOrigin("http://192.168.1.10:4370")).toBe(true)
  })

  test("bun 测试环境无 location → 空串", () => {
    expect(currentOrigin()).toBe("")
  })
})
