<script lang="ts">
  // 确认弹层：notify.confirmState 的唯一渲染出口（shadcn AlertDialog 受控）
  // Esc / 遮罩 / 取消 → false；确认 → true。连续调用覆盖策略见 notify.ts
  import * as AlertDialog from "$lib/components/ui/alert-dialog"
  import { confirmState, settleConfirm } from "$lib/notify"
</script>

<AlertDialog.Root open={$confirmState.open} onOpenChange={(o) => !o && settleConfirm(false)}>
  <AlertDialog.Content class="sm:max-w-[360px]">
    <AlertDialog.Header>
      <AlertDialog.Title>{$confirmState.title}</AlertDialog.Title>
      <AlertDialog.Description>{$confirmState.body}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>取消</AlertDialog.Cancel>
      <!-- onclick 同步先于关闭流程：settleConfirm 幂等护栏保证 true 抢先结算，随后的 onOpenChange(false) 无副作用 -->
      <AlertDialog.Action onclick={() => settleConfirm(true)}>确认</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
