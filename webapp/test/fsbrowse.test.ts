import { describe, expect, test } from "bun:test"
import { BoardApiError } from "../src/lib/api"
import { describeFsError, parentOf, retryTarget, sortEntries, splitCrumbs } from "../src/lib/fsbrowse"
import type { FsEntry, FsListing } from "../src/lib/fsbrowse"

const E = (name: string): FsEntry => ({ name, path: `/root/${name}`, type: "dir" })
const L = (path: string): FsListing => ({ path, parent: "/", home: "/home/me", entries: [] })

describe("splitCrumbs 面包屑切分", () => {
  test("根目录单节", () => {
    expect(splitCrumbs("/")).toEqual([{ name: "/", path: "/" }])
  })
  test("多级路径逐级累积", () => {
    expect(splitCrumbs("/home/me")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
    ])
  })
})

describe("parentOf 上级目录", () => {
  test("根目录无上级返回 null", () => {
    expect(parentOf("/")).toBe(null)
  })
  test("一级目录回根;多级回上级", () => {
    expect(parentOf("/home")).toBe("/")
    expect(parentOf("/home/me")).toBe("/home")
  })
})

describe("sortEntries 目录排序", () => {
  test("数位感知: b2 排在 b10 前", () => {
    const src = [E("b10"), E("b2"), E("a")]
    expect(sortEntries(src).map((e) => e.name)).toEqual(["a", "b2", "b10"])
  })
  test("不改原数组", () => {
    const src = [E("b"), E("a")]
    sortEntries(src)
    expect(src.map((e) => e.name)).toEqual(["b", "a"])
  })
})

describe("describeFsError 错误文案", () => {
  test("按错误码映射中文", () => {
    expect(describeFsError(new BoardApiError("invalid_path", "x"))).toContain("绝对路径")
    expect(describeFsError(new BoardApiError("not_found", "x"))).toContain("不存在")
    expect(describeFsError(new BoardApiError("forbidden", "x"))).toContain("权限")
  })
  test("非 BoardApiError 兜底", () => {
    expect(describeFsError(new Error("boom"))).toBe("目录加载失败")
    expect(describeFsError("随便")).toBe("目录加载失败")
  })
})

describe("retryTarget 重试目标", () => {
  test("优先重试用户输入的路径（失败后不静默回落旧目录）", () => {
    expect(retryTarget("/mnt/nas", L("/home/me"))).toBe("/mnt/nas")
  })
  test("输入为空则回退上一次成功列出的目录", () => {
    expect(retryTarget("   ", L("/home/me"))).toBe("/home/me")
  })
  test("输入为空且无历史目录则 undefined（由服务端列 HOME）", () => {
    expect(retryTarget("", null)).toBe(undefined)
  })
})
