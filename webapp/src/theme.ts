import { writable, type Writable } from "svelte/store"

export type ThemeMode = "auto" | "light" | "dark"

const STORAGE_KEY = "taskboard-theme"

const darkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null

function storedMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === "light" || raw === "dark" ? raw : "auto"
  } catch {
    return "auto"
  }
}

/** auto 解析为系统当前偏好，其余原样返回 */
function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "auto" ? (darkQuery?.matches ? "dark" : "light") : mode
}

/** 三态主题（auto 跟随系统 / light / dark），持久化到 localStorage，默认 auto */
export const themeMode: Writable<ThemeMode> = writable(storedMode())

/** 循环切换：auto → light → dark → auto */
export function cycleThemeMode(): void {
  themeMode.update((m) => (m === "auto" ? "light" : m === "light" ? "dark" : "auto"))
}

/** 直接指定主题（Header 的主题菜单用） */
export function setThemeMode(mode: ThemeMode): void {
  themeMode.set(mode)
}

/**
 * 订阅 themeMode，把解析后的主题写到 documentElement 的 dark 类（shadcn 约定）；
 * auto 模式下监听 prefers-color-scheme 变化实时跟随。
 * 返回清理函数（测试 / HMR 用）。
 */
export function initTheme(): () => void {
  let current: ThemeMode = "auto"

  const apply = (mode: ThemeMode) => {
    current = mode
    document.documentElement.classList.toggle("dark", resolveTheme(mode) === "dark")
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // 存储不可用时主题仅本次会话生效
    }
  }

  const unsubscribe = themeMode.subscribe(apply)

  const onSystemChange = () => {
    if (current === "auto") document.documentElement.classList.toggle("dark", resolveTheme("auto") === "dark")
  }
  darkQuery?.addEventListener("change", onSystemChange)

  return () => {
    unsubscribe()
    darkQuery?.removeEventListener("change", onSystemChange)
  }
}
