import { describe, expect, test } from "bun:test"
import {
  WS_READY_OPEN,
  boardToken,
  decideTerminalConn,
  encodeTerminalBinary,
  encodeTerminalInput,
  encodeTerminalResize,
  parseTerminalControl,
  terminalConnKey,
  terminalWsUrl,
} from "../src/lib/terminal"

// 终端桥已并入看板服务（方案 1）：前端**同源**直连 `/api/tasks/:id/terminal?token=…`，
// 不再有独立的 sidecar 进程、地址与口令配置项。
// 这里的用例只覆盖纯函数：地址构造、令牌读取、连接收敛判定、帧编解码。

/** 假页面位置（同源构造用） */
const HTTP_LOC = { protocol: "http:", host: "127.0.0.1:4370" }
const HTTPS_LOC = { protocol: "https:", host: "board.local" }

describe("terminalWsUrl（同源终端 WS 地址）", () => {
  test("http → ws，同源看板地址", () => {
    expect(terminalWsUrl("task-1", "tok", HTTP_LOC)).toBe(
      "ws://127.0.0.1:4370/api/tasks/task-1/terminal?token=tok",
    )
  })

  test("https → wss", () => {
    expect(terminalWsUrl("task-1", "tok", HTTPS_LOC)).toBe(
      "wss://board.local/api/tasks/task-1/terminal?token=tok",
    )
  })

  test("ws / wss 原样保留", () => {
    expect(terminalWsUrl("task-1", "tok", { protocol: "ws:", host: "127.0.0.1:4370" })).toBe(
      "ws://127.0.0.1:4370/api/tasks/task-1/terminal?token=tok",
    )
    expect(terminalWsUrl("task-1", "tok", { protocol: "wss:", host: "board.local" })).toBe(
      "wss://board.local/api/tasks/task-1/terminal?token=tok",
    )
  })

  test("taskID 与 token 都做 URL 编码", () => {
    const url = terminalWsUrl("task a/b", "to k&x=1", HTTP_LOC)
    expect(url).toBe("ws://127.0.0.1:4370/api/tasks/task%20a%2Fb/terminal?token=to%20k%26x%3D1")
    // 编码后服务端解码回来仍是原值（路由按 decodeURIComponent 取任务 ID）
    const parsed = new URL(url)
    expect(decodeURIComponent(parsed.pathname)).toBe("/api/tasks/task a/b/terminal")
    expect(parsed.searchParams.get("token")).toBe("to k&x=1")
  })

  test("缺 taskID 或 token → 空串（调用方按无法连接处理）", () => {
    expect(terminalWsUrl("", "tok", HTTP_LOC)).toBe("")
    expect(terminalWsUrl("task-1", "", HTTP_LOC)).toBe("")
    expect(terminalWsUrl("   ", "tok", HTTP_LOC)).toBe("")
  })

  test("非法协议 / 空 host → 空串", () => {
    expect(terminalWsUrl("task-1", "tok", { protocol: "ftp:", host: "127.0.0.1:4370" })).toBe("")
    expect(terminalWsUrl("task-1", "tok", { protocol: "http:", host: "  " })).toBe("")
  })

  test("协议大小写不敏感（HTTP: → ws:）", () => {
    expect(terminalWsUrl("task-1", "tok", { protocol: "HTTP:", host: "127.0.0.1:4370" })).toBe(
      "ws://127.0.0.1:4370/api/tasks/task-1/terminal?token=tok",
    )
  })

  test("host 不含端口也能用（默认端口由浏览器补）", () => {
    expect(terminalWsUrl("task-1", "tok", { protocol: "https:", host: "board.local" })).toBe(
      "wss://board.local/api/tasks/task-1/terminal?token=tok",
    )
  })

  test("任务 ID 里的 # 与中文都被编码（防路径歧义）", () => {
    const url = terminalWsUrl("任务#1", "tok", HTTP_LOC)
    expect(url).toBe("ws://127.0.0.1:4370/api/tasks/%E4%BB%BB%E5%8A%A1%231/terminal?token=tok")
    expect(decodeURIComponent(new URL(url).pathname)).toBe("/api/tasks/任务#1/terminal")
  })

  test("token 里的 # 与 % 都被编码", () => {
    const url = terminalWsUrl("task-1", "a#b%c", HTTP_LOC)
    expect(url).toBe("ws://127.0.0.1:4370/api/tasks/task-1/terminal?token=a%23b%25c")
    expect(new URL(url).searchParams.get("token")).toBe("a#b%c")
  })

  test("无页面位置（bun 测试环境无 DOM）→ 空串", () => {
    expect(terminalWsUrl("task-1", "tok")).toBe("")
    expect(terminalWsUrl("task-1", "tok", undefined)).toBe("")
  })
})

describe("看板令牌读取", () => {
  test("bun 测试环境无 window → 空串（不抛异常）", () => {
    expect(boardToken()).toBe("")
  })

  test("window 注入令牌后能读到（并去空白）", () => {
    const g = globalThis as unknown as { window?: { __TASKBOARD_TOKEN__?: string } }
    const prev = g.window
    g.window = { __TASKBOARD_TOKEN__: "  tok-123  " }
    try {
      expect(boardToken()).toBe("tok-123")
    } finally {
      if (prev === undefined) delete g.window
      else g.window = prev
    }
  })

  test("window 存在但没有令牌字段 → 空串", () => {
    const g = globalThis as unknown as { window?: { __TASKBOARD_TOKEN__?: string } }
    const prev = g.window
    g.window = {}
    try {
      expect(boardToken()).toBe("")
    } finally {
      if (prev === undefined) delete g.window
      else g.window = prev
    }
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

  test("心跳 ping 帧被忽略（null）——服务端 25s 保活，不是错误", () => {
    expect(parseTerminalControl('{"type":"ping"}')).toBeNull()
  })

  test("exit 的 code 不是数字 → 按 0 处理", () => {
    expect(parseTerminalControl('{"type":"exit","code":"x"}')).toEqual({ type: "exit", code: 0 })
  })

  test("顶层不是对象（数字/字符串/null）→ null", () => {
    expect(parseTerminalControl("42")).toBeNull()
    expect(parseTerminalControl('"error"')).toBeNull()
    expect(parseTerminalControl("null")).toBeNull()
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

  test("已连接常量 = 1（不依赖浏览器 WebSocket.OPEN）", () => {
    expect(WS_READY_OPEN).toBe(1)
  })
})

describe("decideTerminalConn（连接判定）", () => {
  const KEY = terminalConnKey("t1", "ses_abc", "tok")

  test("① 键未变（看板快照重渲染）→ hold，不重连", () => {
    expect(decideTerminalConn({ prevKey: KEY, nextKey: KEY, active: true })).toBe("hold")
  })

  test("② 令牌字符串含空白（同一令牌不同写法）→ 键相同 → hold，不重连", () => {
    // 判定函数不接收连接状态：键没变就一律 hold，
    // 结构上杜绝了「exit/error 后被一次快照自动重连」
    const next = terminalConnKey("t1", "ses_abc", " tok ")
    expect(next).toBe(KEY)
    expect(decideTerminalConn({ prevKey: KEY, nextKey: next, active: true })).toBe("hold")
  })

  test("③ exit / error 之后键未变 → hold（不自动重连）", () => {
    expect(decideTerminalConn({ prevKey: KEY, nextKey: KEY, active: true })).toBe("hold")
  })

  test("④ 切出（键清空）后切回 → connect", () => {
    // 切出时 prevKey 被清空，切回时键非空 → 键变化 → 连
    expect(decideTerminalConn({ prevKey: "", nextKey: KEY, active: true })).toBe("connect")
  })

  test("切出页签 → disconnect（并清键）", () => {
    expect(decideTerminalConn({ prevKey: KEY, nextKey: KEY, active: false })).toBe("disconnect")
  })

  test("换任务 / 换会话 / 换令牌 → connect", () => {
    expect(
      decideTerminalConn({ prevKey: KEY, nextKey: terminalConnKey("t2", "ses_abc", "tok"), active: true }),
    ).toBe("connect")
    expect(
      decideTerminalConn({ prevKey: KEY, nextKey: terminalConnKey("t1", "ses_xyz", "tok"), active: true }),
    ).toBe("connect")
    expect(
      decideTerminalConn({ prevKey: KEY, nextKey: terminalConnKey("t1", "ses_abc", "tok2"), active: true }),
    ).toBe("connect")
  })

  test("键为空 → hold（不连）", () => {
    expect(decideTerminalConn({ prevKey: KEY, nextKey: "", active: true })).toBe("hold")
  })

  test("两键都空且激活 → hold（不连也不断）", () => {
    expect(decideTerminalConn({ prevKey: "", nextKey: "", active: true })).toBe("hold")
  })

  test("未激活时一律 disconnect（哪怕键为空）", () => {
    expect(decideTerminalConn({ prevKey: "", nextKey: "", active: false })).toBe("disconnect")
  })

  test("C1 复现序列：连接 → exit → 一次看板快照 → 仍 hold（不自动重连）", () => {
    // 复审实测：旧实现用 `key === connKey && wantConn` 做守卫，
    // exit 之后 wantConn=false → 合取为假 → 一次看板快照就把连接重建了。
    // 现在的判定只看键：键没变就一律 hold。
    const afterConnect = decideTerminalConn({ prevKey: "", nextKey: KEY, active: true })
    expect(afterConnect).toBe("connect")
    // exit 帧到达：键不变（组件不碰 connKey）
    const afterExit = decideTerminalConn({ prevKey: KEY, nextKey: KEY, active: true })
    expect(afterExit).toBe("hold")
    // 随后一次看板快照（父组件换新 task 对象 → props getter 失效 → effect 重跑）：键仍不变
    const afterSnapshot = decideTerminalConn({ prevKey: KEY, nextKey: KEY, active: true })
    expect(afterSnapshot).toBe("hold")
  })
})

describe("terminalConnKey", () => {
  test("同任务同会话同令牌 → 同键", () => {
    expect(terminalConnKey("t1", "ses_abc", "tok")).toBe(terminalConnKey("t1", "ses_abc", "tok"))
  })

  test("三段都去空白（同一令牌不同写法 → 同一键，不重连）", () => {
    expect(terminalConnKey(" t1 ", " ses_abc ", " tok ")).toBe(terminalConnKey("t1", "ses_abc", "tok"))
  })

  test("换任务 / 换会话 / 换令牌 → 不同键", () => {
    const base = terminalConnKey("t1", "ses_abc", "tok")
    expect(terminalConnKey("t2", "ses_abc", "tok")).not.toBe(base)
    expect(terminalConnKey("t1", "ses_xyz", "tok")).not.toBe(base)
    expect(terminalConnKey("t1", "ses_abc", "tok2")).not.toBe(base)
  })
})
