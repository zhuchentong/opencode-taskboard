<script lang="ts">
  import { onMount } from "svelte"
  import { get } from "svelte/store"
  import { cycleThemeMode, themeMode, type ThemeMode } from "./theme"
  import type { Status } from "./lib/types"

  const MODE_LABEL: Record<ThemeMode, string> = {
    auto: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色",
  }

  // 七列静态壳：Task 6 由 Board/Column 组件替换为真实分组渲染
  const COLUMNS: { status: Status; label: string }[] = [
    { status: "planning", label: "待规划" },
    { status: "pending", label: "待领取" },
    { status: "analyzing", label: "分析中" },
    { status: "analysis_confirm", label: "分析确认" },
    { status: "executing", label: "执行中" },
    { status: "completion_confirm", label: "完成确认" },
    { status: "done", label: "已完成" },
  ]

  let mode = $state<ThemeMode>(get(themeMode))

  onMount(() => themeMode.subscribe((m) => (mode = m)))

  const modeLabel = $derived(MODE_LABEL[mode])
</script>

<header class="app-header">
  <h1>任务看板</h1>
  <span class="note">Header 占位：新建表单与设置开关由后续任务接入</span>
  <span class="spacer"></span>
  <button class="ghost" onclick={cycleThemeMode} title="切换主题（自动 → 浅色 → 深色）">
    {modeLabel}
  </button>
</header>

<main class="board">
  {#each COLUMNS as col (col.status)}
    <section class="column" data-status={col.status}>
      <h2>{col.label}</h2>
      <p class="empty">暂无任务</p>
    </section>
  {/each}
</main>
