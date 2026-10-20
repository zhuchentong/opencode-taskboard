<script lang="ts">
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { untrack } from "svelte"
  import { currentOrigin, isValidSidecarUrl, originNeedsAllowOrigin, type TerminalConfig } from "$lib/terminal"

  let {
    config,
    onsave,
    oncancel,
  }: {
    /** 当前已保存的配置（表单初值） */
    config: TerminalConfig
    /** 保存回调（父组件负责写 localStorage 并刷新响应式配置） */
    onsave: (config: TerminalConfig) => void
    /** 取消（收起面板） */
    oncancel?: () => void
  } = $props()

  /** 表单初值：读当前配置一次（面板打开时的快照；面板内的编辑不回写配置） */
  const initial = untrack(() => config)
  /** sidecar 地址输入框 */
  let sidecarUrl = $state(initial.sidecarUrl)
  /** 共享口令输入框 */
  let token = $state(initial.token)
  /** 当前看板 Origin（不在 sidecar 默认白名单时提示加 --allow-origin） */
  const origin = currentOrigin()
  /** Origin 是否需要 --allow-origin */
  const needAllowOrigin = originNeedsAllowOrigin(origin)
  /** 地址格式是否合法（能被解析成 sidecar 的 WS 地址） */
  const urlValid = $derived(isValidSidecarUrl(sidecarUrl))
  /** 配置是否已填写完整（决定「终端」Tab 是否会出现） */
  const filled = $derived(sidecarUrl.trim() !== "" && token.trim() !== "")
  /** 能否保存：填写完整 **且** 地址格式合法 */
  const canSave = $derived(filled && urlValid)
  /** 地址填了但不合法 → 给出中文提示（空地址不算错，还没填而已） */
  const urlInvalid = $derived(sidecarUrl.trim() !== "" && !urlValid)

  function save() {
    onsave({ sidecarUrl: sidecarUrl.trim(), token: token.trim() })
  }
</script>

<div class="grid gap-2.5 rounded-lg border p-2.5 text-xs">
  <div class="grid gap-1">
    <span class="font-medium text-foreground">终端设置（web 终端打开 opencode session）</span>
    <span class="text-muted-foreground">
      终端由一个<strong>独立的 sidecar 进程</strong>提供（不在看板服务进程内运行）。
      首次使用请先在<strong>自己的终端</strong>里手动启动它：
    </span>
    <pre class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">cd tools/terminal-sidecar
npm install
npm start -- --token &lt;至少 8 位的共享口令&gt;</pre>
    <span class="text-muted-foreground">
      详细说明见仓库 <span class="font-mono">tools/terminal-sidecar/README.md</span>（含参数、验收步骤与故障排查）。
    </span>
  </div>

  <div class="grid gap-1">
    <label class="grid gap-1">
      <span class="text-muted-foreground">sidecar 地址</span>
      <Input bind:value={sidecarUrl} placeholder="http://127.0.0.1:7681" aria-label="sidecar 地址" />
    </label>
    {#if urlInvalid}
      <p class="text-destructive">
        地址需带 http(s):// 前缀，例：<span class="font-mono">http://127.0.0.1:7681</span>
      </p>
    {/if}
    <label class="grid gap-1">
      <span class="text-muted-foreground">共享口令（sidecar 启动参数 --token）</span>
      <Input bind:value={token} placeholder="至少 8 位" aria-label="sidecar 共享口令" type="password" />
    </label>
  </div>

  {#if needAllowOrigin}
    <p class="rounded-md border border-warning/40 p-2 text-warning">
      当前看板来源 <span class="font-mono">{origin}</span> 不在 sidecar 的默认 Origin 白名单内（默认只放行
      <span class="font-mono">http://127.0.0.1:4370</span> 与
      <span class="font-mono">http://localhost:4370</span>），
      请在启动 sidecar 时追加 <span class="font-mono">--allow-origin {origin}</span>，否则连接会被 403 拒接。
    </p>
  {/if}

  {#if !canSave}
    <p class="text-muted-foreground">
      {#if urlInvalid}
        地址格式合法、且口令填写完整后，「终端」页签才会出现在<strong>已领取且有会话</strong>的任务详情里。
      {:else}
        填写完整后，「终端」页签才会出现在<strong>已领取且有会话</strong>的任务详情里。
      {/if}
    </p>
  {/if}

  <div class="flex justify-end gap-2">
    {#if oncancel}
      <Button variant="ghost" size="sm" onclick={() => oncancel?.()}>取消</Button>
    {/if}
    <Button size="sm" disabled={!canSave} onclick={save}>保存</Button>
  </div>
</div>
