// 项目工作区目录选择的纯函数：面包屑切分、上级推导、排序与错误文案。
// 交互逻辑不写进 .svelte 组件，便于 bun test 覆盖。
// 路径语义限 POSIX（看板服务只跑本机 localhost，服务端 isAbsolute 同此约束）；
// 不用 node:path——浏览器 bundle 里没有 node 内置模块。
import { BoardApiError } from "./api"

export interface FsEntry {
  name: string
  path: string
  type: "dir"
}

export interface FsListing {
  /** 当前目录绝对路径（服务端已 resolve 归一） */
  path: string
  /** 上级目录；根目录为 null */
  parent: string | null
  /** 用户 HOME，面包屑快捷入口 */
  home: string
  entries: FsEntry[]
}

/** 面包屑切分："/home/me" → [/, home, me] 三节累积路径 */
export function splitCrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter((p) => p.length > 0)
  const crumbs: Array<{ name: string; path: string }> = [{ name: "/", path: "/" }]
  let acc = ""
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}

/** 上级目录；根目录返回 null */
export function parentOf(path: string): string | null {
  const parts = path.split("/").filter((p) => p.length > 0)
  if (parts.length === 0) return null
  if (parts.length === 1) return "/"
  return `/${parts.slice(0, -1).join("/")}`
}

/** 数位感知排序（b2 先于 b10）；返回新数组，不改原数组 */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** 目录加载失败文案：按服务端错误码映射中文，未知错误兜底 */
export function describeFsError(err: unknown): string {
  if (err instanceof BoardApiError) {
    switch (err.code) {
      case "invalid_path":
        return "目录必须是绝对路径"
      case "not_found":
        return "目录不存在或已被移除"
      case "forbidden":
        return "无权限读取该目录"
    }
    return err.message || "目录加载失败"
  }
  return "目录加载失败"
}

/**
 * 「重试」的目标目录：优先用户输入框里的路径（刚失败的那个），
 * 否则回退上一次成功列出的目录，都没有则 undefined（服务端列 HOME）。
 */
export function retryTarget(input: string, listing: FsListing | null): string | undefined {
  const typed = input.trim()
  if (typed) return typed
  return listing ? listing.path : undefined
}
