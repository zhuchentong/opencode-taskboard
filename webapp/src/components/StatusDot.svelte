<script lang="ts">
  import type { ConnState } from "$lib/api"

  let { state }: { state: ConnState } = $props()

  // 连接状态 → 圆点色与中文文案；live 绿 / 重连与轮询黄（均为降级态非故障；polling 已是最差连接态，无更深红）
  const VIEW = {
    live: { dot: "bg-success", text: "实时" },
    reconnecting: { dot: "bg-warning", text: "重连中" },
    polling: { dot: "bg-warning", text: "轮询中", tip: "数据可能延迟" },
  } as const
  const view = $derived(VIEW[state])
</script>

<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`看板连接状态：${view.text}${"tip" in view ? `（${view.tip}）` : ""}`}>
  <span class="size-2 rounded-full {view.dot}" title={"tip" in view ? view.tip : undefined}></span>{view.text}
</span>
