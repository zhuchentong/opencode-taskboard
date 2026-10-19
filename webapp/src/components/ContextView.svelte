<script lang="ts">
  import { fetchTaskContext } from "$lib/api"
  import { emptyHint, roleMeta, toolStateIcon, toolSummary, type ContextMessage } from "$lib/context"
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

  async function load() {
    loading = true
    error = ""
    try {
      const r = await fetchTaskContext(task.id)
      messages = r.page
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

  {#if loading}
    <span class="py-6 text-center text-xs text-muted-foreground">加载上下文…</span>
  {:else if error}
    <div class="grid gap-1.5 rounded-lg border border-destructive/40 p-2.5 text-xs">
      <span class="text-destructive">加载失败：{error}</span>
      <button type="button" class="w-fit rounded-md border px-2 py-0.5 hover:bg-accent" onclick={load}>重试</button>
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
              <div class="prose prose-sm dark:prose-invert max-w-none wrap-anywhere">
                <Markdown source={p.text ?? ""} />
                {#if p.truncated}<span class="text-xs text-muted-foreground">（已截断）</span>{/if}
              </div>
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
