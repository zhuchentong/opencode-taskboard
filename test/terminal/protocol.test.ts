import { describe, expect, test } from "bun:test"
import { CONTROL, encodeControl, isValidSize, parseControl } from "../../src/terminal/protocol"

describe("终端帧协议", () => {
  test("parseControl:合法控制帧按 type 解析（resize/error/exit/ping）", () => {
    expect(parseControl(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))).toEqual({
      type: "resize",
      cols: 100,
      rows: 40,
    })
    expect(parseControl(JSON.stringify({ type: "error", message: "会话不存在" }))).toEqual({
      type: "error",
      message: "会话不存在",
    })
    expect(parseControl(JSON.stringify({ type: "exit", code: 3 }))).toEqual({ type: "exit", code: 3 })
    expect(parseControl(JSON.stringify({ type: CONTROL.PING }))).toEqual({ type: "ping" })
  })

  test("parseControl:非法输入一律 null（坏 JSON/数组/null/缺 type/数字 type）", () => {
    expect(parseControl("不是 JSON")).toBeNull()
    expect(parseControl("[1,2]")).toBeNull()
    expect(parseControl("null")).toBeNull()
    expect(parseControl(JSON.stringify({ cols: 1 }))).toBeNull()
    expect(parseControl(JSON.stringify({ type: 42 }))).toBeNull()
  })

  test("parseControl:字节流按 UTF-8 解码后解析", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))
    expect(parseControl(bytes)).toEqual({ type: "resize", cols: 80, rows: 24 })
  })

  test("encodeControl:编码成 JSON 文本帧", () => {
    expect(encodeControl({ type: CONTROL.ERROR, message: "出错了" })).toBe('{"type":"error","message":"出错了"}')
  })

  test("isValidSize:正整数且 ≤1000 才合法", () => {
    expect(isValidSize(120, 30)).toBe(true)
    expect(isValidSize(0, 30)).toBe(false)
    expect(isValidSize(120, -1)).toBe(false)
    expect(isValidSize(120.5, 30)).toBe(false)
    expect(isValidSize(1001, 30)).toBe(false)
    expect(isValidSize("120", 30)).toBe(false)
    expect(isValidSize(undefined, undefined)).toBe(false)
  })
})
