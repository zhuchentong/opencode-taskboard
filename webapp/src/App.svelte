<script lang="ts">
  import { onMount } from "svelte"
  import { get } from "svelte/store"
  import { cycleThemeMode, themeMode, initTheme, type ThemeMode } from "./theme"
  import { fetchBoard, createTask, putSettings, type ConnState } from "./lib/api"
  import { applySnapshot, beginOptimistic, emptyState, visibleTasks, type BoardState } from "./lib/optimistic"
  import { notify } from "./lib/notify"
  import Header from "./components/Header.svelte"
  import Board from "./components/Board.svelte"
  import Toasts from "./components/Toasts.svelte"
  import ConfirmDialog from "./components/ConfirmDialog.svelte"
  import type { Task } from "./lib/types"

  const MODE_LABEL: Record<ThemeMode, string> = {
    auto: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色",
  }

  let board = $state<BoardState>(emptyState({ requireAnalysisConfirm: false }))
  let conn = $state<ConnState>("polling")
  let loaded = $state(false)
  let mode = $state<ThemeMode>(get(themeMode))

  const visible = $derived(visibleTasks(board))

  async function refresh() {
    try {
      const snap = await fetchBoard()
      board = applySnapshot(board, snap.tasks, snap.settings)
      loaded = true
    } catch {
      /* 轮询失败保留现状，下轮重试 */
    }
  }

  onMount(() => {
    initTheme()
    const unsub = themeMode.subscribe((m) => (mode = m))
    // 临时 2s 轮询：Task 9 由 SSE + 30s 对账轮询替换
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      clearInterval(timer)
      unsub()
    }
  })

  function handleCreate(title: string, description: string) {
    createTask(title, description || undefined)
      .then(refresh)
      .catch((e) => notify("error", `创建失败：${e.message}`))
  }

  function handleToggle(requireAnalysisConfirm: boolean) {
    // 乐观更新设置，失败回滚（applySnapshot 新对象引用触发重渲染）
    const prev = board.settings
    putSettings(requireAnalysisConfirm)
      .then(refresh)
      .catch((e) => {
        board = applySnapshot(board, board.server, { ...prev })
        notify("error", `设置失败：${e.message}`)
      })
  }

  // Task 11 由详情侧滑面板替换
  const openDetail = (_task: Task) => {}
</script>

<Header
  settings={board.settings}
  {conn}
  {mode}
  modeLabel={MODE_LABEL[mode]}
  oncreate={handleCreate}
  ontoggle={handleToggle}
  oncyclemode={cycleThemeMode}
/>

{#if loaded}
  <Board tasks={visible} onopen={openDetail} />
{:else}
  <main class="board skeleton" aria-label="加载中">
    {#each Array(7) as _, i (i)}
      <div class="skel-col">
        <div class="skel-head"></div>
        {#each Array(2) as _, j (j)}
          <div class="skel-card"></div>
        {/each}
      </div>
    {/each}
  </main>
{/if}

<Toasts />
<ConfirmDialog />

<style>
  .skeleton {
    display: grid;
    grid-template-columns: repeat(7, minmax(168px, 1fr));
    gap: 10px;
  }
  .skel-col {
    background: var(--col);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px;
    display: grid;
    gap: 8px;
    align-content: start;
  }
  .skel-head,
  .skel-card {
    border-radius: 6px;
    background: linear-gradient(100deg, var(--line) 40%, var(--card) 50%, var(--line) 60%);
    background-size: 200% 100%;
    animation: shimmer 1.2s infinite;
  }
  .skel-head {
    height: 14px;
    width: 60%;
  }
  .skel-card {
    height: 72px;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
</style>
