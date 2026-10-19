<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import Spinner from "$lib/components/ui/spinner/spinner.svelte"
  import { listDir } from "$lib/api"
  import { describeFsError, retryTarget, sortEntries, splitCrumbs, type FsListing } from "$lib/fsbrowse"

  let {
    open = $bindable(false),
    initial = "",
    onpick,
  }: {
    /** 开关（由父组件 $bindable 双向绑定） */
    open?: boolean
    /** 打开时起始目录；空串则服务端列用户 HOME */
    initial?: string
    /** 选定目录回调（把绝对路径回填到项目工作区输入框） */
    onpick: (path: string) => void
  } = $props()

  let listing = $state<FsListing | null>(null)
  let pathInput = $state("")
  let loading = $state(false)
  let error = $state<string | null>(null)

  const crumbs = $derived(listing ? splitCrumbs(listing.path) : [])
  const entries = $derived(listing ? sortEntries(listing.entries) : [])
  const canPick = $derived(!!listing && !loading)

  async function load(path?: string) {
    loading = true
    error = null
    try {
      const res = await listDir(path)
      listing = res
      pathInput = res.path
    } catch (err) {
      // 保留上一次成功列出的目录，便于用户改一处再试
      error = describeFsError(err)
    } finally {
      loading = false
    }
  }

  function gotoPath() {
    const p = pathInput.trim()
    if (!p) return
    void load(p)
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") gotoPath()
  }

  function pick() {
    if (!listing) return
    onpick(listing.path)
    open = false
  }

  // 每次打开（open 由 false 变 true）从起始目录重新加载
  $effect(() => {
    if (open) void load(initial || undefined)
  })
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[560px]">
    <Dialog.Header class="gap-1">
      <Dialog.Title class="text-sm">选择工作区目录</Dialog.Title>
      <Dialog.Description class="sr-only">浏览本机目录，选定项目 worker 的工作区</Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-2">
      <div class="flex gap-1.5">
        <Input
          bind:value={pathInput}
          placeholder="绝对路径，回车跳转"
          aria-label="目录路径"
          class="flex-1 font-mono text-xs"
          onkeydown={onInputKeydown}
        />
        <Button type="button" variant="outline" size="sm" onclick={gotoPath} disabled={loading}>跳转</Button>
      </div>

      <div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {#each crumbs as c (c.path)}
          <button
            type="button"
            class="hover:text-foreground max-w-[180px] truncate rounded px-1 py-0.5 hover:bg-accent"
            title={c.path}
            onclick={() => load(c.path)}>{c.name}</button>
          {#if c.path !== crumbs[crumbs.length - 1].path}<span aria-hidden="true">/</span>{/if}
        {/each}
        {#if listing && listing.home !== listing.path}
          <Button type="button" variant="ghost" size="sm" class="ml-auto h-6 px-1.5 text-xs" onclick={() => load(listing!.home)}>
            HOME
          </Button>
        {/if}
      </div>

      {#if error}
        <div class="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <span class="min-w-0 flex-1 truncate" title={error}>{error}</span>
          <Button type="button" variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => load(retryTarget(pathInput, listing))}>重试</Button>
        </div>
      {/if}

      <div class="grid max-h-[45vh] gap-0.5 overflow-y-auto rounded border">
        {#if loading}
          <div class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner /> 加载中…
          </div>
        {:else if !listing}
          <div class="py-6 text-center text-xs text-muted-foreground">未加载到目录</div>
        {:else}
          {#if listing.parent}
            <button
              type="button"
              class="hover:bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm"
              onclick={() => load(listing!.parent ?? undefined)}
            >
              <span class="text-muted-foreground">..</span>
              <span class="truncate text-xs text-muted-foreground">上级目录</span>
            </button>
          {/if}
          {#each entries as e (e.path)}
            <button
              type="button"
              class="hover:bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm"
              title={e.path}
              onclick={() => load(e.path)}
            >
              <span class="truncate">{e.name}</span>
            </button>
          {:else}
            <div class="py-4 text-center text-xs text-muted-foreground">该目录下没有子目录</div>
          {/each}
        {/if}
      </div>

      <Dialog.Footer class="gap-2">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>取消</Button>
        <Button type="button" onclick={pick} disabled={!canPick}>
          {listing ? `选择此目录（${listing.path}）` : "选择此目录"}
        </Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
