<script lang="ts">
  import { dndzone, type DndEvent } from "svelte-dnd-action"
  import { Badge } from "$lib/components/ui/badge"
  import { dropTask } from "$lib/drop"
  import { notify } from "$lib/notify"
  import type { Status, Task } from "$lib/types"
  import Card from "./Card.svelte"

  let {
    status,
    label,
    tasks,
    empty,
    onopen,
    onconfirm,
    onquickreject,
    onmove,
    ondrop,
    pendingIds,
    flashIds,
  }: {
    status: Status
    label: string
    tasks: Task[]
    empty?: string
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
    /** 拖拽落定：跨泳道时回调（App 走乐观写通道） */
    ondrop?: (taskId: string, toStatus: Status) => void
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
  } = $props()

  // 泳道内全部任务都被 Agent 认领中 → 整个 zone 禁拖（库仅有 zone 级 dragDisabled，
  // 单卡禁拖靠 finalize 校验弹回，见 handleFinalize）
  const agentBusy = (t: Task) => !!t.claim && t.claim.agent !== "human" && (t.status === "analyzing" || t.status === "executing")
  const zoneDragDisabled = $derived(tasks.length > 0 && tasks.every(agentBusy))

  // 库要求 host 对 consider/finalize 都回写 items；tasks 是派生 prop 不可变，
  // 故持本地副本：快照到达（tasks 引用变化）时重置，拖拽预览期间由事件回写
  let items = $state<Task[]>([])
  $effect(() => {
    items = tasks
  })

  const flipDurationMs = 150

  function handleConsider(e: DndEvent<Task>) {
    items = e.detail.items // 纯视觉重排预览
  }

  function handleFinalize(e: DndEvent<Task>) {
    const dragged = e.detail.items.find((t) => t.id === e.detail.info.id)
    if (!dragged) {
      items = e.detail.items // 源泳道：采纳移除后的新序（快照回来后整体重置）
      return
    }
    const from = dragged.status // 对象来自源泳道，status 字段仍是源状态
    const guard = agentBusy(dragged) // Agent 认领中 → 视同非法，弹回
    const patch = guard ? null : dropTask(from, status)
    if (!patch) {
      if (guard) notify("error", "该任务正由 Agent 处理，不能移动")
      items = tasks // 弹回：丢弃本地重排
      return
    }
    items = e.detail.items
    ondrop?.(dragged.id, patch.status)
  }

  // 状态令牌映射（与 Card 的色带/圆点同源）：泳道头圆点
  const DOT_BY_STATUS: Record<string, string> = {
    analyzing: "bg-primary",
    executing: "bg-primary",
    analysis_confirm: "bg-warning",
    completion_confirm: "bg-warning",
    done: "bg-muted-foreground/60",
  }
</script>

<section
  class="flex flex-col gap-2 rounded-lg border bg-card/50 p-3"
  data-status={status}
  aria-label={`泳道：${label}`}
>
  <h2 class="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
    <span class="size-2 rounded-full {DOT_BY_STATUS[status] ?? 'bg-muted-foreground/60'}"></span>
    {label}
    <Badge variant="secondary" class="px-1.5 text-[11px] text-muted-foreground">{tasks.length}</Badge>
  </h2>
  {#if tasks.length === 0}
    <p class="flex min-h-10 items-center text-xs text-muted-foreground/70">{empty ?? ""}</p>
  {/if}
  <!-- 空泳道也要保留 dndzone 容器：拖入第一张卡的落点 -->
  <div
    class="flex min-h-10 flex-wrap gap-2.5"
    aria-label={`泳道 ${label} 的卡片列表`}
    use:dndzone={{ items, flipDurationMs, dragDisabled: zoneDragDisabled, dropTargetStyle: { outline: "2px solid var(--primary)", outlineOffset: "-2px" } }}
    onconsider={handleConsider}
    onfinalize={handleFinalize}
  >
    {#each items as task (task.id)}
      <Card {task} {onopen} {onconfirm} {onquickreject} {pendingIds} {flashIds} {onmove} />
    {/each}
  </div>
</section>
