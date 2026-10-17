<script lang="ts">
  import { onMount } from "svelte"
  import { get } from "svelte/store"
  import { setThemeMode, themeMode, type ThemeMode } from "./theme"
  import { fetchBoard, createTask, putSettings, patchTask, deleteTask, BoardApiError, type ConnState } from "./lib/api"
  import { applySnapshot, beginOptimistic, emptyState, settle, visibleTasks, type BoardState } from "./lib/optimistic"
  import { STATUSES } from "./lib/board"
  import { notify } from "./lib/notify"
  import { initDrag } from "./lib/drag.svelte"
  import { needsTicker } from "./lib/duration"
  import { startTicker, stopTicker } from "./lib/ticker.svelte"
  import { connectEvents } from "./lib/events"
  import { Skeleton } from "$lib/components/ui/skeleton"
  import { Toaster } from "$lib/components/ui/sonner"
  import Header from "./components/Header.svelte"
  import Board from "./components/Board.svelte"
  import TaskDetail from "./components/TaskDetail.svelte"
  import ConfirmDialog from "./components/ConfirmDialog.svelte"
  import type { Status, Task } from "./lib/types"

  const MODE_LABEL: Record<ThemeMode, string> = {
    auto: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色",
  }

  let board = $state<BoardState>(emptyState({ requireAnalysisConfirm: false, autoDispatch: false }))
  let conn = $state<ConnState>("polling")
  let loaded = $state(false)
  let mode = $state<ThemeMode>(get(themeMode))
  let detailId = $state<string | null>(null)
  let detailInitialReject = $state(false)

  const visible = $derived(visibleTasks(board))
  const detailTask = $derived(detailId ? (visible.find((t) => t.id === detailId) ?? null) : null)
  // 乐观写入的视觉态：在途（半透明+pulse）与失败回滚（红闪一拍）
  let flashIds = $state<Set<string>>(new Set())

  function flashFail(taskId: string) {
    const next = new Set(flashIds)
    next.add(taskId)
    flashIds = next
    setTimeout(() => {
      const s = new Set(flashIds)
      s.delete(taskId)
      flashIds = s
    }, 650)
  }

  function openDetail(task: Task) {
    detailInitialReject = false
    detailId = task.id
  }

  function quickReject(task: Task) {
    detailInitialReject = true
    detailId = task.id
  }

  function closeDetail() {
    const id = detailId
    detailId = null
    detailInitialReject = false
    if (id) document.querySelector(`[data-task-id="${id}"]`)?.focus() // 焦点返还卡片
  }

  // 统一写通道：乐观遮罩 → API → 快照落地后摘遮罩（settle 时序契约）。
  // silent：失败只红闪不弹 toast（快速通过等高频路径，避免重复轰炸）；红闪已表达失败+自动回滚
  function writeTask(
    taskId: string,
    mask: Partial<Task>,
    apiPatch: Record<string, unknown>,
    failMsg: string,
    silent = false,
  ) {
    board = beginOptimistic(board, taskId, mask)
    patchTask(taskId, apiPatch)
      .then(async () => {
        await refresh()
        board = settle(board, taskId, true)
      })
      .catch((e) => {
        board = settle(board, taskId, false)
        flashFail(taskId)
        if (!silent) notify("error", `${failMsg}：${friendlyError(e)}`)
      })
  }

  // 乐观协议失败大多源于「状态已被他端改变」——把 invalid_transition 翻译成人话
  function friendlyError(e: unknown): string {
    if (e instanceof BoardApiError && e.code === "invalid_transition") {
      return "任务状态已被其他操作改变（例如 Agent 刚领取），请稍后刷新再试"
    }
    return e instanceof Error ? e.message : String(e)
  }

  // 键盘跨泳道移动：状态序 ±1，首尾截停；与拖拽同一乐观通道
  function moveTask(task: Task, dir: -1 | 1) {
    const i = STATUSES.indexOf(task.status)
    const next = STATUSES[i + dir]
    if (!next) return
    writeTask(task.id, { status: next }, { status: next }, "移动失败")
  }

  // 删除：await 后由 SSE 广播的快照自动刷新看板（服务端删除也会 emit snapshot）
  async function removeTask(taskId: string) {
    try {
      await deleteTask(taskId)
      if (detailId === taskId) {
        detailId = null
        detailInitialReject = false
      }
      refresh()
    } catch (e) {
      notify("error", `删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 快速通过：确认列卡片一键放行（乐观通道；失败静默红闪——双击重复操作高发，toast 会轰炸）
  function quickConfirm(task: Task) {
    const nextStatus = task.status === "analysis_confirm" ? "executing" : "done"
    writeTask(task.id, { status: nextStatus }, { action: "confirm" }, "确认失败", true)
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

  // 心跳：仅当存在进行中的计时段时才每秒跳动（无任务在跑则停摆，不空转）。
  // 依赖 visible，随 SSE 快照自动起停。
  $effect(() => {
    if (visible.some((t) => needsTicker(t))) startTicker()
    else stopTicker()
  })

  // 拖拽落定与键盘移动同一乐观通道
  function handleDrop(taskId: string, toStatus: Status) {
    writeTask(taskId, { status: toStatus }, { status: toStatus }, "移动失败")
  }

  function handleCreate(title: string, description: string): Promise<void> {
    // 成功返回 resolve（弹窗关闭清空）；失败 reject（弹窗保留输入），错误提示走 toast
    return createTask(title, description || undefined)
      .then((t) => {
        refresh()
        notify("success", `任务已创建（${t.id}）`)
      })
      .catch((e) => {
        notify("error", `创建失败：${e instanceof Error ? e.message : String(e)}`)
        throw e
      })
  }

  function handleToggle(requireAnalysisConfirm: boolean) {
    void changeSettings({ requireAnalysisConfirm })
  }

  // 设置统一通道：乐观生效，失败回滚
  function changeSettings(patch: Partial<{ requireAnalysisConfirm: boolean; autoDispatch: boolean }>) {
    const prev = board.settings
    board = applySnapshot(board, board.server, { ...prev, ...patch })
    return putSettings(patch)
      .then(refresh)
      .catch((e) => {
        board = applySnapshot(board, board.server, prev)
        notify("error", `设置失败：${e instanceof Error ? e.message : String(e)}`)
        throw e
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
  ondispatch={(autoDispatch: boolean) => void changeSettings({ autoDispatch })}
  onsetmode={setThemeMode}
/>

{#if loaded}
  <Board
    tasks={visible}
    pendingIds={board.pending}
    flashIds={flashIds}
    onopen={openDetail}
    onconfirm={quickConfirm}
    onquickreject={quickReject}
    onmove={moveTask}
  />
{:else}
  <main class="mx-auto flex max-w-7xl flex-col gap-2.5 p-4" aria-label="加载中">
    {#each Array(7) as _, i (i)}
      <div class="flex items-center gap-2.5 rounded-lg border p-3">
        <Skeleton class="h-3.5 w-22" />
        <div class="flex flex-1 flex-wrap gap-2.5">
          <Skeleton class="h-24 w-60" />
          <Skeleton class="h-24 w-60" />
        </div>
      </div>
    {/each}
  </main>
{/if}

{#if detailTask}
  <TaskDetail
    task={detailTask}
    onclose={closeDetail}
    onwrite={writeTask}
    ondelete={removeTask}
    initialReject={detailInitialReject}
  />
{/if}

<Toaster richColors position="bottom-right" />
<ConfirmDialog />
