<script lang="ts">
  import { onDestroy } from "svelte"
  import { fetchTaskContext } from "$lib/api"
  import { emptyHint, roleMeta, toolStateIcon, toolSummary, type ContextMessage } from "$lib/context"
  import { connectLiveContext, liveSessionID, mergeLive, type LiveStatus } from "$lib/live-context"
  import type { Task } from "$lib/types"
  import { formatClock } from "$lib/duration"
  import Markdown from "./Markdown.svelte"

  let { task }: { task: Task } = $props()

  let messages = $state<ContextMessage[]>([])
  let total = $state(0)
  let cursor = $state<string | null>(null)
  let hasMore = $state(false)
  let loading = $state(true)
  let loadingMore = $state(false)
  let error = $state("")
  /** 实时连接态：live=实时中；reconnecting=断线退避重连中；off=未开启/已降级（终态） */
  let liveStatus = $state<LiveStatus>("off")
  /** 最近一次收到的实时消息（组件自持一份）：重拉快照时用它收敛，避免把实时内容冲掉 */
  let liveMessages = $state<ContextMessage[]>([])
  /** 当前实时订阅的键（任务 ID + 会话 ID）：键不变就不重建订阅（普通变量，不进响应式依赖） */
  let liveKey = ""
  /** 当前订阅的收尾函数（关 EventSource + 清退避定时器） */
  let stopLive: (() => void) | null = null
  /** 已拉过快照的任务 ID（普通变量）：换任务才回到「加载中」态，后台刷新不遮住消息列表 */
  let loadedFor = ""

  async function load() {
    const id = task.id
    if (id !== loadedFor) {
      // 只有换任务的首拉显示加载态；同任务的后台刷新保留已渲染的消息（实时视图不被清空）
      loading = true
      loadedFor = id
    }
    error = ""
    try {
      const r = await fetchTaskContext(id)
      // 重拉快照不丢实时内容：按消息 id 收敛（live 是更新的权威内容）
      messages = mergeLive(r.page, liveMessages)
      total = r.total
      cursor = r.nextCursor
      hasMore = r.hasMore
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  /** 向前翻页：更早的消息 prepend 到头部，阅读位置不跳 */
  async function loadMore() {
    if (!cursor || loadingMore) return
    loadingMore = true
    error = ""
    try {
      const r = await fetchTaskContext(task.id, cursor)
      messages = [...r.page, ...messages]
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
    stopLive?.()
    stopLive = null
    liveMessages = []
    liveStatus = "off"
    // 任务无会话（未领取 / 人工执行）→ 根本不开 EventSource：零请求，天然不重试风暴。
    // 任务被 worker 领取后 claim.sessionID 出现 → 本 effect 重跑并开始连实时。
    if (!sessionID) return
    stopLive = connectLiveContext(task.id, {
      onMessages: (live) => {
        // 快照与增量按消息 id 收敛（审查重点 3）：live 覆盖同 id 的快照消息
        liveMessages = live
        messages = mergeLive(messages, live)
      },
      onStatus: (s) => {
        liveStatus = s
        if (s === "off" && !messages.length) void load() // 降级时兜底一次快照
      },
    })
  })

  // 组件销毁时收尾：关流 + 清退避定时器
  onDestroy(() => {
    stopLive?.()
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
      {loadingMore ? "加载中…" : `加载更早的消息（已加载 ${messages.length} / 共 ${total} 条）`}
    </button>
  {:else if messages.length > 0 && total > messages.length}
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
