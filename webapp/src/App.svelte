<script lang="ts">
  // Spike 探针：验证 Svelte 5 runes 编译链。正式实现由 Task 4 替换。
  let count = $state(0)
</script>

<main>
  <h1>任务看板（构建探针）</h1>
  <p>token: {window.__TASKBOARD_TOKEN__.slice(0, 6)}…</p>
  <button onclick={() => count++}>点击 {count} 次</button>
</main>
