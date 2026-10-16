<script lang="ts">
  // Toast 容器：订阅 notify.ts 的 toasts，右下角固定堆叠
  // hover 单条暂停其自动消失计时，移出恢复（计时逻辑在 notify.ts）
  import { toasts, pauseToast, resumeToast } from "../lib/notify"
</script>

<aside class="toasts" aria-live="polite">
  {#each $toasts as t (t.id)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="toast {t.kind}"
      role="status"
      onmouseenter={() => pauseToast(t.id)}
      onmouseleave={() => resumeToast(t.id)}
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="text">{t.text}</span>
    </div>
  {/each}
</aside>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 50;
    max-width: min(360px, calc(100vw - 32px));
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--card); /* color-mix 不可用时的回退底色 */
    color: var(--text);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    font-size: 13px;
    cursor: default;
    animation: toast-in 0.18s ease-out;
  }

  .toast .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .toast.success {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 10%, var(--card));
  }
  .toast.success .dot {
    background: var(--ok);
  }

  .toast.error {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--card));
  }
  .toast.error .dot {
    background: var(--danger);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
