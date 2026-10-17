<script lang="ts">
  import type { ConnState } from "$lib/api"

  let { state }: { state: ConnState } = $props()

  // 连接状态 → 圆点色与中文文案；live 绿 / reconnecting 黄 / polling 红
  const VIEW = {
    live: { dot: "bg-success", text: "实时" },
    reconnecting: { dot: "bg-warning", text: "重连中" },
    polling: { dot: "bg-destructive", text: "轮询中" },
  } as const
  const view = $derived(VIEW[state])
</script>

<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`看板连接状态：${view.text}`}>
  <span class="size-2 rounded-full {view.dot}"></span>{view.text}
</span>
