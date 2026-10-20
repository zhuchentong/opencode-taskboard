<script lang="ts">
  import { onDestroy } from "svelte"
  import { Terminal } from "@xterm/xterm"
  import { FitAddon } from "@xterm/addon-fit"
  import "@xterm/xterm/css/xterm.css"
  import {
    WS_READY_OPEN,
    encodeTerminalBinary,
    encodeTerminalInput,
    encodeTerminalResize,
    parseTerminalControl,
    sidecarWsUrl,
    terminalConnKey,
    type TerminalConfig,
  } from "$lib/terminal"

  let {
    taskId,
    sessionID,
    config,
    active = false,
  }: {
    /** 任务 ID（连接收敛键的一半） */
    taskId: string
    /** worker 会话 ID：sidecar 用它开 tmux 会话 board-<id> */
    sessionID: string
    /** sidecar 地址与共享口令 */
    config: TerminalConfig
    /** 终端 Tab 是否处于激活态：切出即断开（tmux 保状态，重进秒级重 attach） */
    active?: boolean
  } = $props()

  /** 连接态：idle=未连接；connecting=连接中；connected=已连接；closed=已断开 */
  let status = $state<"idle" | "connecting" | "connected" | "closed">("idle")
  /** 提示条：错误（红色）/ 警告（琥珀色，如 TUI 已退出、断线） */
  let notice = $state<{ kind: "error" | "warn"; text: string } | null>(null)
  /** xterm 挂载点（xterm 需要可测量容器） */
  let host = $state<HTMLDivElement | null>(null)

  // —— 以下都是「非响应式」资源句柄：普通变量，不进响应式依赖 ——
  // （参照 ContextView 的 liveKey 模式：看板快照频繁重渲染不得重建连接）
  /** xterm 实例 */
  let term: Terminal | null = null
  /** 尺寸自适应插件 */
  let fitAddon: FitAddon | null = null
  /** 当前 WebSocket */
  let sock: WebSocket | null = null
  /** 容器尺寸监听 */
  let observer: ResizeObserver | null = null
  /** 当前连接收敛键：键不变就不重建连接（普通变量） */
  let connKey = ""
  /** 是否应当保持连接：连接结束（error / exit / 断线）后置 false，直到用户点「重连」 */
  let wantConn = false

  /** 断开当前连接（不杀 tmux 会话：sidecar 侧会话仍在，重连秒级 attach） */
  function disconnect() {
    const s = sock
    sock = null
    if (!s) return
    // 先摘回调再 close：close 事件不再改状态（重连时不会被旧连接的收尾覆盖）
    s.onopen = null
    s.onmessage = null
    s.onclose = null
    s.onerror = null
    try {
      s.close()
    } catch {
      /* 已断开，忽略 */
    }
  }

  /** 把当前终端尺寸告知 sidecar（文本帧 JSON 控制消息） */
  function sendResize() {
    const s = sock
    const t = term
    if (!s || s.readyState !== WS_READY_OPEN || !t) return
    if (t.cols <= 0 || t.rows <= 0) return
    try {
      s.send(encodeTerminalResize(t.cols, t.rows))
    } catch {
      /* 连接刚好断了，交给 onclose 收尾 */
    }
  }

  /** 按容器尺寸自适应：容器不可见（尺寸为 0）时跳过，否则 fit 会算出 0x0 */
  function fitToContainer() {
    const el = host
    const t = term
    const fit = fitAddon
    if (!el || !t || !fit) return
    if (el.clientWidth <= 0 || el.clientHeight <= 0) return
    try {
      fit.fit()
    } catch {
      return
    }
    sendResize()
  }

  /** 建立连接：文本帧 = JSON 控制消息；二进制帧 = 终端原始字节流 */
  function connect() {
    const url = sidecarWsUrl(config.sidecarUrl, sessionID, config.token)
    if (!url) {
      status = "idle"
      wantConn = false
      notice = { kind: "error", text: "终端地址或口令无效，无法连接（请检查「终端设置」）" }
      return
    }
    disconnect()
    status = "connecting"
    notice = null
    wantConn = true
    term?.reset()

    let s: WebSocket
    try {
      s = new WebSocket(url)
    } catch (e) {
      status = "closed"
      wantConn = false
      notice = { kind: "error", text: `无法建立连接：${e instanceof Error ? e.message : String(e)}` }
      return
    }
    sock = s
    s.binaryType = "arraybuffer"
    let opened = false

    s.onopen = () => {
      opened = true
      status = "connected"
      // 连接建立后尽早发一次尺寸：sidecar 侧有早到帧缓冲，先发也不丢
      fitToContainer()
      sendResize()
      term?.focus()
    }

    s.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // 文本帧 = JSON 控制消息（error / exit / resize）
        const ctl = parseTerminalControl(ev.data)
        if (!ctl) return
        if (ctl.type === "error") {
          notice = { kind: "error", text: ctl.message }
          status = "closed"
          wantConn = false
        } else if (ctl.type === "exit") {
          // TUI 已退出 ⇔ tmux 会话已随之销毁：重连 = 重起一个全新 TUI（旧滚动内容不在）
          notice = {
            kind: "warn",
            text: "TUI 已退出（tmux 会话已随之销毁）。点击「重连」会重新打开一个新 TUI，旧的滚动内容不在。",
          }
          status = "closed"
          wantConn = false
        }
        return
      }
      // 二进制帧 = 终端输出字节
      if (ev.data instanceof ArrayBuffer) term?.write(new Uint8Array(ev.data))
    }

    s.onclose = () => {
      if (sock !== s) return // 已被重连取代的旧连接：不碰状态
      sock = null
      status = "closed"
      wantConn = false
      if (notice) return // 已有更具体的原因（error / exit 帧），不覆盖
      notice = opened
        ? { kind: "warn", text: "连接已断开（tmux 会话仍在，可点击「重连」恢复）" }
        : {
            kind: "error",
            text: "连接失败：请确认 sidecar 已启动（默认 http://127.0.0.1:7681），且口令与 Origin 白名单匹配",
          }
    }

    s.onerror = () => {
      /* 浏览器不暴露握手失败细节，统一由 onclose 给出中文提示 */
    }
  }

  /** 手动重连（error / exit / 断线后的恢复入口） */
  function reconnect() {
    wantConn = true
    connKey = terminalConnKey(taskId, sessionID, config.sidecarUrl, config.token)
    connect()
  }

  // xterm 实例：随挂载点创建、随组件销毁释放
  $effect(() => {
    const el = host
    if (!el) return
    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#111113",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#3f3f46",
      },
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    term = t
    fitAddon = fit

    // 输入：xterm 的 onData 给的是字符串 → 必须编码成字节按**二进制帧**发。
    // 直接发字符串会变成文本帧，被 sidecar 当成控制消息忽略（终端表现为敲键盘没反应）。
    t.onData((data) => {
      const s = sock
      if (!s || s.readyState !== WS_READY_OPEN) return
      try {
        s.send(encodeTerminalInput(data))
      } catch {
        /* 连接刚好断了，交给 onclose 收尾 */
      }
    })
    // 8 位二进制输入（Ctrl+字母等）：每个字符码一个字节
    t.onBinary((data) => {
      const s = sock
      if (!s || s.readyState !== WS_READY_OPEN) return
      try {
        s.send(encodeTerminalBinary(data))
      } catch {
        /* 忽略 */
      }
    })
    // 尺寸变化：把新尺寸告知 sidecar
    t.onResize(() => sendResize())
    // 容器尺寸变化（面板缩放 / Tab 显隐）→ 重新 fit
    const ro = new ResizeObserver(() => fitToContainer())
    ro.observe(el)
    observer = ro

    return () => {
      ro.disconnect()
      observer = null
      t.dispose()
      term = null
      fitAddon = null
    }
  })

  // 连接生命周期：按「任务 ID + 会话 ID + sidecar 地址 + 口令」收敛。
  // 键不变 → 不重建（看板快照频繁重渲染不得重建连接）；
  // 切出终端 Tab → 主动断开（tmux 保状态，重进秒级重 attach）。
  // 注意：这里不用 effect 的 cleanup 断连——cleanup 会在任何依赖变化时先跑，
  // 连带把「配置对象被整体替换但值没变」这种无关重跑也变成断连（连接被误杀）。
  $effect(() => {
    const key = terminalConnKey(taskId, sessionID, config.sidecarUrl, config.token)
    if (!active) {
      // 切出终端 Tab：断开（tmux 保状态，重进秒级重 attach）
      connKey = ""
      wantConn = false
      disconnect()
      return
    }
    // 键未变且连接还在：保持现状（不重连、不重建 xterm）
    if (key === connKey && wantConn) return
    connKey = key
    connect()
  })

  // 组件销毁：断开 + 释放监听（xterm 实例由上面的 effect 清理负责）
  onDestroy(() => {
    disconnect()
    observer?.disconnect()
    observer = null
  })
</script>

<div class="grid gap-2">
  <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span
      class="mr-1 {status === 'connected' ? 'text-emerald-500' : status === 'connecting' ? 'text-warning' : 'text-destructive'}"
      aria-hidden="true">●</span
    >
    <span>
      {status === "connected" ? "已连接" : status === "connecting" ? "连接中…" : status === "closed" ? "已断开" : "未连接"}
    </span>
    <span class="font-mono text-[11px]">{sessionID}</span>
    <button
      type="button"
      class="rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
      onclick={reconnect}
      title="重新连接 sidecar（TUI 已退出时重连会重起一个新 TUI）"
    >
      重连
    </button>
  </div>

  {#if notice}
    <div
      class="rounded-lg border p-2 text-xs {notice.kind === 'error'
        ? 'border-destructive/40 text-destructive'
        : 'border-warning/40 text-warning'}"
    >
      {notice.text}
    </div>
  {/if}

  <!-- xterm 挂载点：必须有确定高度，fit 插件才能算出行列数 -->
  <div bind:this={host} class="h-[420px] overflow-hidden rounded-lg border bg-[#111113] p-1"></div>
</div>
