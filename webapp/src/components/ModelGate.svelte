<script lang="ts">
  // 模型门禁引导:分析/执行模型未配齐时替代泳道区,指引到页头右上「⚙ 设置」弹层配置。
  // 配齐后 App 响应式切回 Board,本组件无 props(门禁判定在 App 用 modelsConfigured 完成)。
</script>

<main class="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4" aria-label="请配置模型">
  <div
    class="mx-auto mt-16 flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-6 py-8 text-center">
    <div class="text-2xl" aria-hidden="true">⚙️</div>
    <h2 class="text-base font-semibold text-foreground">请先配置分析模型与执行模型</h2>
    <p class="text-[13px] leading-relaxed text-muted-foreground">
      自动派发的 worker 会话必须显式指定模型——未配置模型的后台会话有创建即挂起的风险，因此不再支持「跟随
      opencode 默认」。
    </p>
    <ol class="flex flex-col gap-1.5 text-left text-[13px] text-foreground">
      <li>1. 点击页头右上「⚙ 设置」，在「模型」中选择分析模型</li>
      <li>2. 在「模型」中选择执行模型</li>
      <li>3. 配置完成后看板自动恢复，即可创建任务</li>
    </ol>
  </div>
</main>
