<script lang="ts">
  // 确认弹层（单例）：绑定 notify.ts 模块级 confirmState 渲染原生 <dialog>
  // - 确定 → settleConfirm(true)；取消/Esc → settleConfirm(false)
  // - 原生 showModal 自带模态焦点圈定（Tab 在弹层内循环）与 Esc cancel 事件
  import { confirmState, settleConfirm } from "../lib/notify"

  let dlg: HTMLDialogElement | undefined = $state()
  let okBtn: HTMLButtonElement | undefined = $state()

  const open = $derived($confirmState.open)

  // 开合跟随单例状态；打开时焦点落入「确定」按钮
  $effect(() => {
    if (open) {
      dlg?.showModal()
      okBtn?.focus()
    } else {
      dlg?.close()
    }
  })

  // Esc 触发原生 cancel 事件：拦截默认关闭，走统一结算（复位状态 + resolve(false)）
  function onCancel(e: Event): void {
    e.preventDefault()
    settleConfirm(false)
  }
</script>

<dialog bind:this={dlg} class="confirm" cancel={onCancel} aria-labelledby="confirm-title" aria-describedby="confirm-body">
  <h3 id="confirm-title">{$confirmState.title}</h3>
  <p id="confirm-body">{$confirmState.body}</p>
  <div class="actions">
    <button class="ghost" onclick={() => settleConfirm(false)}>取消</button>
    <button bind:this={okBtn} onclick={() => settleConfirm(true)}>确定</button>
  </div>
</dialog>

<style>
  dialog.confirm {
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px 18px;
    min-width: 320px;
    max-width: min(420px, 90vw);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }

  dialog.confirm::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }

  dialog.confirm h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }

  dialog.confirm p {
    margin: 0 0 16px;
    color: var(--muted);
    font-size: 13px;
    white-space: pre-line;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
