<script lang="ts">
  import { onDestroy } from "svelte"
  import { fetchTaskContext } from "$lib/api"
  import { emptyHint, roleMeta, toolStateIcon, toolSummary, type ContextMessage } from "$lib/context"
  import {
    connectLiveContext,
    liveSessionID,
    mergeLive,
    shouldReloadSnapshot,
    type LiveContextHandle,
    type LiveStatus,
  } from "$lib/live-context"
  import type { Task } from "$lib/types"
  import { formatClock } from "$lib/duration"
  import Markdown from "./Markdown.svelte"

  let { task }: { task: Task } = $props()

  /** 快照侧：服务端分页读出的消息（最新在前）；load 覆盖它、loadMore 追加到尾部 */
  let snapshotMessages = $state<ContextMessage[]>([])
  /** 实时侧：订阅状态机累积的实时消息（最新在前）；订阅键变化时清空 */
  let liveMessages = $state<ContextMessage[]>([])
  /**
   * 展示用消息列表 = 快照侧 + 实时侧收敛（派生值，不可直接赋值）。
   * 两侧分开存是硬要求：混装在一个数组里时，翻页拿回的旧页会与实时侧累出的旧消息
   * 撞出重复 id（keyed each 不支持重复 key → 整段列表崩）。
   */
  const messages = $derived(mergeLive(snapshotMessages, liveMessages))
  let total = $state(0)
  let cursor = $state<string | null>(null)
  let hasMore = $state(false)
  let loading = $state(true)
  let loadingMore = $state(false)
  let error = $state("")
  /** 实时连接态：live=实时中；reconnecting=断线退避重连中；off=未开启/已降级（终态） */
  let liveStatus = $state<LiveStatus>("off")
  /** 当前实时订阅的键（任务 ID + 会话 ID）：键不变就不重建订阅（普通变量，不进响应式依赖） */
  let liveKey = ""
  /** 当前订阅句柄（seed 播种快照、dispose 收尾） */
  let stopLive: LiveContextHandle | null = null
  /** 已拉过快照的任务 ID（普通变量）：换任务才回到「加载中」态，后台刷新不遮住消息列表 */
  let loadedFor = ""
  /**
   * 快照首页（最近一页）：播种给实时状态机用。
   * 只存首页——loadMore 拿回的更早页不播种：增量只流向最新消息，
   * 老页播种只会让状态机数组无界膨胀。
   */
  let firstPage: ContextMessage[] = []
  /** firstPage 所属的任务 ID：换任务前的老快照不得播进新任务的状态机 */
  let firstPageFor = ""

  async function load() {
    const id = task.id
    if (id !== loadedFor) {
      // 只有换任务的首拉显示加载态；同任务的后台刷新保留已渲染的消息（实时视图不被清空）
      loading = true
      loadedFor = id
      firstPage = []
      firstPageFor = ""
    }
    error = ""
    try {
      const r = await fetchTaskContext(id)
      // 任务已切换：过期响应作废（否则旧任务的快照会覆盖新任务，
      // 还会被播进新任务的实时状态机——断线重拉让并发 load 变多，这条更得守住）
      if (id !== task.id) return
      // 只覆盖快照侧；实时侧独立保存，两者由派生值 messages 收敛（实时内容不会被快照冲掉）
      snapshotMessages = r.page
      total = r.total
      cursor = r.nextCursor
      hasMore = r.hasMore
      // 播种首页到实时状态机：实时流首帧常是增量片段，没有播种就会用片段整体替换快照正文（正文被抹）
      firstPage = r.page
      firstPageFor = id
      stopLive?.seed(r.page)
    } catch (e) {
      if (id !== task.id) return
      error = e instanceof Error ? e.message : String(e)
    } finally {
      if (id === task.id) loading = false
    }
  }

  /** 向前翻页：把更早的一页追加到快照侧尾部（快照页本身是「最新在前」，追加后全局仍是最新在前） */
  async function loadMore() {
    if (!cursor || loadingMore) return
    loadingMore = true
    error = ""
    try {
      const r = await fetchTaskContext(task.id, cursor)
      // 追加而非前置：更早的一页本来就比已加载的更旧，前置会把顺序倒过来
      snapshotMessages = [...snapshotMessages, ...r.page]
      cursor = r.nextCursor
      hasMore = r.hasMore
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loadingMore = false
    }
  }

  // 首次挂载（标签页激活）才拉取；任务切换时重置重拉
  $effect(() => {
    void task.id
    void load()
  })

  // 实时订阅：任务或会话变化才重建。
  // 依赖收敛成「任务 ID + 会话 ID」两个字符串——父组件每次看板快照都会换新的 task 对象，
  // 若直接依赖 task，订阅会被反复重建（连接抖动，且状态机内部的消息数组每次清零 → 丢内容）。
  $effect(() => {
    const sessionID = liveSessionID(task)
    const key = `${task.id}\u0000${sessionID}`
    if (key === liveKey) return // 键未变：保持现有订阅
    liveKey = key
    stopLive?.dispose()
    stopLive = null
    liveMessages = []
    liveStatus = "off"
    // 任务无会话（未领取 / 人工执行）→ 根本不开 EventSource：零请求，天然不重试风暴。
    // 任务被 worker 领取后 claim.sessionID 出现 → 本 effect 重跑并开始连实时。
    if (!sessionID) return
    stopLive = connectLiveContext(task.id, {
      onMessages: (live) => {
        // 实时侧整体覆盖（状态机自持的累积结果）；展示列表由派生值 messages 收敛
        liveMessages = live
      },
      onStatus: (s) => {
        liveStatus = s
        // 断线 → 重拉快照（规格 §4.3/§6）：断线窗口内产生的消息永远不上屏。
        // reconnecting 每次重试都拉一次可接受（本地 HTTP 便宜）；load() 会把快照侧重置回首页，
        // 属收敛优先的可接受行为（翻页加载的更早页会在下次刷新时重新拉回）。
        if (shouldReloadSnapshot(s)) void load()
      },
    })
    // 重建订阅（换任务 / 换会话）后重播快照：新状态机是空数组，
    // 没有重播的话实时流首帧（增量片段）会整体替换掉快照正文
    if (firstPageFor === task.id) stopLive.seed(firstPage)
  })

  // 组件销毁时收尾：关流 + 清退避定时器
  onDestroy(() => {
    stopLive?.dispose()
    stopLive = null
  })
</script>

<div class="grid gap-2.5">
  {#if hasMore}
    <button
      type="button"
      class="mx-auto rounded-md border px-3 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      onclick={loadMore}
      disabled={loadingMore}
    >
      {loadingMore ? "加载中…" : `加载更早的消息（已加载 ${snapshotMessages.length} / 共 ${total} 条）`}
    </button>
  {:else if snapshotMessages.length > 0 && total > snapshotMessages.length}
    <span class="text-center text-xs text-muted-foreground">已加载全部 {total} 条</span>
  {:else if messages.length > 0}
    <span class="text-center text-xs text-muted-foreground">共 {total} 条消息</span>
  {/if}

  {#if liveStatus !== "off"}
    <span class="text-xs text-muted-foreground">
      <span class="mr-1 {liveStatus === 'live' ? 'text-emerald-500' : 'text-warning'}" aria-hidden="true">●</span>{liveStatus === "live" ? "实时" : "重连中…"}
    </span>
  {/if}

  {#if loading}
    <span class="py-6 text-center text-xs text-muted-foreground">加载上下文…</span>
  {:else if error}
    <div class="grid gap-1.5 rounded-lg border border-destructive/40 p-2.5 text-xs">
      <span class="text-destructive">加载失败：{error}</span>
      <button
        type="button"
        class="w-fit rounded-md border px-2 py-0.5 hover:bg-accent"
        onclick={() => {
          loading = true
          void load()
        }}
      >
        重试
      </button>
    </div>
  {:else if messages.length === 0}
    <span class="py-6 text-center text-xs text-muted-foreground">{emptyHint(task)}</span>
  {:else}
    {#each messages as m (m.id)}
      <div class="grid gap-1.5 rounded-lg border p-2.5">
        <div class="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <span>{roleMeta(m.role).icon} {roleMeta(m.role).label}</span>
          <span class="tabular-nums">{formatClock(m.time)}</span>
        </div>
        <div class="grid gap-1.5">
          {#each m.parts as p, i (i)}
            {#if p.type === "text"}
              {#if m.streaming}
                <!-- 流式态：纯文本 + 闪烁光标（逐帧解析 markdown 太贵，半截 markdown 也会闪） -->
                <pre class="whitespace-pre-wrap break-all text-sm">{p.text ?? ""}<span class="animate-caret-blink" aria-hidden="true">▍</span></pre>
                {#if p.truncated}<span class="text-xs text-muted-foreground">（已截断）</span>{/if}
              {:else}
                <div class="prose prose-sm dark:prose-invert max-w-none wrap-anywhere">
                  <Markdown source={p.text ?? ""} />
                  {#if p.truncated}<span class="text-xs text-muted-foreground">（已截断）</span>{/if}
                </div>
              {/if}
            {:else if p.type === "reasoning"}
              <div class="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                <span class="mr-1" aria-hidden="true">💭</span>{p.text}
                {#if p.truncated}（已截断）{/if}
              </div>
            {:else if p.type === "tool"}
              <details class="rounded-md border text-xs">
                <summary class="cursor-pointer select-none px-2 py-1 hover:bg-accent">
                  <span class="mr-1 tabular-nums" aria-hidden="true">{toolStateIcon(p)}</span>
                  <span class="font-mono">{toolSummary(p)}</span>
                  {#if p.truncated}<span class="text-muted-foreground">（已截断）</span>{/if}
                </summary>
                <div class="grid gap-1 border-t px-2 py-1.5">
                  {#if p.input}
                    <span class="text-muted-foreground">输入</span>
                    <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{p.input}</pre>
                  {/if}
                  {#if p.output}
                    <span class="text-muted-foreground">输出</span>
                    <pre class="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{p.output}</pre>
                  {/if}
                </div>
              </details>
            {:else if p.type === "patch"}
              <div class="text-xs text-muted-foreground">
                <span aria-hidden="true">✏️</span> 改动 {p.files?.length ?? 0} 个文件
                {#if p.files?.length}
                  <div class="mt-0.5 grid font-mono text-[11px] leading-relaxed">
                    {#each p.files as f (f)}<span class="wrap-anywhere">{f}</span>{/each}
                  </div>
                {/if}
              </div>
            {:else if p.type === "file"}
              <div class="text-xs text-muted-foreground"><span aria-hidden="true">📎</span> {p.filename ?? "附件"}</div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
