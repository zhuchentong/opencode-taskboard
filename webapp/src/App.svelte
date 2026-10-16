<script lang="ts">
  import { onMount } from "svelte"
  import { get } from "svelte/store"
  import { cycleThemeMode, themeMode, type ThemeMode } from "./theme"
  import { fetchBoard, createTask, putSettings, patchTask, deleteTask, type ConnState } from "./lib/api"
  import { applySnapshot, beginOptimistic, emptyState, settle, visibleTasks, type BoardState } from "./lib/optimistic"
  import { notify } from "./lib/notify"
  import { initDrag } from "./lib/drag.svelte"
  import { connectEvents } from "./lib/events"
  import Header from "./components/Header.svelte"
  import Board from "./components/Board.svelte"
  import TaskDetail from "./components/TaskDetail.svelte"
  import Toasts from "./components/Toasts.svelte"
  import ConfirmDialog from "./components/ConfirmDialog.svelte"
  import type { Status, Task } from "./lib/types"

  const MODE_LABEL: Record<ThemeMode, string> = {
    auto: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色",
  }

  let board = $state<BoardState>(emptyState({ requireAnalysisConfirm: false }))
  let conn = $state<ConnState>("polling")
  let loaded = $state(false)
  let mode = $state<ThemeMode>(get(themeMode))
  let detailId = $state<string | null>(null)

  const visible = $derived(visibleTasks(board))
  const detailTask = $derived(detailId ? (visible.find((t) => t.id === detailId) ?? null) : null)

  function openDetail(task: Task) {
    detailId = task.id
  }

  function closeDetail() {
    const id = detailId
    detailId = null
    if (id) document.querySelector(`[data-task-id="${id}"]`)?.focus() // 焦点返还卡片
  }

  // 统一写通道：乐观遮罩 → API → 快照落地后摘遮罩（settle 时序契约）
  function writeTask(taskId: string, mask: Partial<Task>, apiPatch: Record<string, unknown>, failMsg: string) {
    board = beginOptimistic(board, taskId, mask)
    patchTask(taskId, apiPatch)
      .then(async () => {
        await refresh()
        board = settle(board, taskId, true)
      })
      .catch((e) => {
        board = settle(board, taskId, false)
        notify("error", `${failMsg}：${e.message}`)
      })
  }

  // 删除：await 后由 SSE 广播的快照自动刷新看板（服务端删除也会 emit snapshot）
  async function removeTask(taskId: string) {
    try {
      await deleteTask(taskId)
      if (detailId === taskId) detailId = null
      refresh()
    } catch (e) {
      notify("error", `删除失败：${e.message}`)
    }
  }

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
    const unsub = themeMode.subscribe((m) => (mode = m))
    const uninitDrag = initDrag(handleDrop)
    const disposeEvents = connectEvents({
      onSnapshot: (tasks, settings) => {
        board = applySnapshot(board, tasks, settings)
        loaded = true
      },
      onStatus: (s) => (conn = s),
    })
    refresh() // SSE 建连前的首屏兜底
    return () => {
      disposeEvents()
      unsub()
      uninitDrag()
    }
  })

  function handleDrop(taskId: string, toStatus: Status) {
    writeTask(taskId, { status: toStatus }, { status: toStatus }, "移动失败")
  }

  function handleCreate(title: string, description: string) {
    createTask(title, description || undefined)
      .then(refresh)
      .catch((e) => notify("error", `创建失败：${e.message}`))
  }

  function handleToggle(requireAnalysisConfirm: boolean) {
    // 乐观更新设置：先本地生效（新对象引用触发重渲染），失败回滚到原设置
    const prev = board.settings
    board = applySnapshot(board, board.server, { ...prev, requireAnalysisConfirm })
    putSettings(requireAnalysisConfirm)
      .then(refresh)
      .catch((e) => {
        board = applySnapshot(board, board.server, prev)
        notify("error", `设置失败：${e.message}`)
      })
  }


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

{#if detailTask}
  <TaskDetail task={detailTask} onclose={closeDetail} onwrite={writeTask} ondelete={removeTask} />
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
