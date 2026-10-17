import { describe, expect, test } from "bun:test"
import { BoardApiError } from "../src/lib/api"

describe("api 模块", () => {
  test("无 DOM 环境可加载——顶层不碰 window（惰性读取令牌）", () => {
    expect(typeof globalThis.window).toBe("undefined")
    expect(new BoardApiError("forbidden", "令牌失配").code).toBe("forbidden")
  })
})
