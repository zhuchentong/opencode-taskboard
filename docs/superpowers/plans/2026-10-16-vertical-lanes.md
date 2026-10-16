# 竖直泳道体验优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板布局从横向七列改为竖直泳道（状态 band 纵向堆叠、卡片 wrap），并叠加快速操作、乐观态可视化、状态色系、键盘移动与错误文案打磨。

**Architecture:** 纯前端改动。协议（optimistic.ts）与 SSE 层零改动；拖拽插入判定抽纯函数 `insertIndex` 并补测试；`Column→Lane` 重命名同步 `drag.svelte.ts` 选择器。

**Tech Stack:** Svelte 5 + Vite（既有链），bun test。

**Spec:** `docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md` §8（Task 5 补记竖直泳道决策）。

## Global Constraints

- 沿用仓库既有约束（token 占位符、固定产物名、中文文案、`<type>: <emoji> <subject>` 提交格式）
- 状态顺序 verbatim：planning/pending/analyzing/analysis_confirm/executing/completion_confirm/done
- 仅桌面端；协议与 SSE 零改动

## Review Focus

1. 拖拽目标选择器与 Lane 类名同步（改 `lane` 必须同步 `drag.svelte.ts`）——Task 1 钉住
2. 快速操作按钮 `stopPropagation`，否则误开详情——Task 2
3. `insertIndex` 边界（空序列/首尾/中线）——Task 1 单测
4. Alt+↑/↓ 与浏览器快捷键冲突（↑/↓ 安全，←/→ 才是历史导航）——Task 4
5. 失败提示不重复轰炸（红闪 vs toast 分工）——Task 5

---

### Task 1: 竖直泳道重构

- [ ] lane.ts `insertIndex(count, clientX, getRect)` RED→GREEN（空序列 0 / 中线前后 / 首尾）
- [ ] Lane.svelte（band 根 `class="lane"` + data-status；卡片 flex wrap 240px；空 band 薄投递区 40px）
- [ ] drag.svelte.ts：选择器改 `lane`；插入判定改用 insertIndex（X 轴）
- [ ] Board.svelte 纵向容器；app.css 布局调整
- [ ] 构建 + Mock 冒烟 + 全量测试；Commit `refactor: 🔀 竖直泳道布局与横向插入判定`

### Task 2: 卡片快速操作

- [ ] 确认列卡片 hover 迷你条：通过（乐观确认）/ 打回（stopPropagation → 以 initialReject 打开详情）
- [ ] TaskDetail `initialReject?: boolean`：初始化展开打回表单 + 聚焦
- [ ] Mock 冒烟；Commit `feat: ✨ 确认列卡片快速操作`

### Task 3: 乐观态可视化

- [ ] App 派生 `pendingIds` 透传 Card；在途半透明+shimmer；失败红闪一拍
- [ ] Mock 冒烟；Commit `feat: 🎞 乐观写入的卡片在途态`

### Task 4: 布局与交互打磨

- [ ] 状态色系（data-status：analyzing 蓝 / 确认列琥珀 / done 灰）band 头圆点+卡片左缘色条
- [ ] planning 空引导；Header 左右分组
- [ ] 卡片 focus + Alt+↑/↓ 跨 band 移动（writeTask 通道，首尾截停）
- [ ] 拖拽视口上下缘自动纵滚（rAF scrollBy）
- [ ] `writeTask` 按 error.code 映射可读文案（invalid_transition → 状态已被改变提示）
- [ ] Commit `feat: 🎨 状态色系、键盘移动与错误文案`

### Task 5: 收尾

- [ ] 失败提示分工（红闪路径不重复 toast）；构建产物入库；全量测试
- [ ] Mock + 真实 playground 冒烟；spec §8 补记竖直泳道 + 「列」→「泳道」措辞
- [ ] Commit `docs: 📝 竖直泳道验收与 spec 措辞修订`

### Task 6: 终审

- [ ] 轻量子代理复审本轮提交 + 修复轮 + 台账
