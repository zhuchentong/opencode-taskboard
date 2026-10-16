<script lang="ts">
  import type { ConnState } from "../lib/api"

  let { state }: { state: ConnState } = $props()

  const META: Record<ConnState, { color: string; label: string }> = {
    live: { color: "var(--ok)", label: "实时已连接" },
    reconnecting: { color: "var(--warn)", label: "实时连接中断，重连中" },
    polling: { color: "var(--accent)", label: "轮询模式" },
  }

  const meta = $derived(META[state])
</script>

<span class="status-dot" title={meta.label}>
  <span class="dot" style:background={meta.color}></span>
  <span class="label">{meta.label}</span>
</span>

<style>
  .status-dot {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
</style>
