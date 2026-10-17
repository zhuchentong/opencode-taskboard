# shadcn-svelte + Tailwind v4 前端重构设计

- 日期：2026-10-17
- 状态：待用户审阅
- 范围：`webapp/`（前端显示层 + 逻辑层 + 测试），服务端与构建管线不动

## 1. 背景与目标

现有前端是 Svelte 5 runes + Vite 8、零 UI 库、手写 CSS（约 1450 行组件 + 166 行全局样式，逻辑层约 800 行带测试的纯函数）。本次将其**彻底重写**为 shadcn-svelte + Tailwind v4 技术栈：

- 视觉全面转向 shadcn 默认设计语言（中性色、设计令牌体系），不保留现有手写色板。
- 布局骨架不变：竖直泳道、泳道内卡片横向流、详情右侧抽屉。
- 逻辑层（`lib/`）一并重写，既有行为作为回归基线逐条对齐。
- 拖拽从手写 HTML5 DnD（约 140 行）切换为社区库 `svelte-dnd-action`。

成功标准：

1. `bun test` 全绿（`webapp/test/` 重写后）。
2. `bun run build:web` 产物重建入库，看板在真实服务下可用。
3. 手工验收清单（第 12 节）全过：创建→领取→确认→打回→完成→删除、拖拽、键盘、主题、断线恢复。
4. 既有交互不变量（第 11 节）无回归。

## 2. 非目标

- 不改服务端 API 契约——**不引入泳道内排序持久化**（服务端 store 无 order 字段，拖拽语义维持「跨泳道 = 改状态」）。
- 构建管线不变量不动：`outDir: ../src/web`、产物文件名钉死 `assets/board.js`/`assets/board.[ext]`、`emptyOutDir`、`/api` 代理 4370、`index.html` token 占位符全部原样；`vite.config.ts` 仅允许追加 Tailwind 插件与 `$lib` 别名（见第 8 节）。
- 不做移动端适配重设计、不做多看板/聚合视图。
- 仓库「无可用 typecheck」现状不变（webapp 新增 tsconfig 仅供 CLI 与 IDE，不宣称类型检查能力）。

## 3. 技术栈定版（2026-10-17 npm 实测）

| 依赖 | 版本 | peer 实测 | 角色 |
|---|---|---|---|
| tailwindcss + @tailwindcss/vite | 4.3.3 | `vite: ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` ✅ | 样式体系（v4 无 config 文件，配置在 CSS 内） |
| shadcn-svelte（CLI） | 1.7.0 | `svelte ^5` ✅ | 组件生成，落 `src/lib/components/ui/` |
| bits-ui | 2.19.5 | `svelte ^5.33` ✅ | shadcn 底层原语（随 CLI 装入） |
| tailwind-variants / tailwind-merge / clsx | 3.3.1 / — / — | TW `*` ✅ | shadcn 样式工具（随 CLI 装入） |
| tw-animate-css | 1.4.0 | — | 动效（替代 tailwindcss-animate） |
| @lucide/svelte | 1.58.0 | `svelte ^5` ✅ | 图标 |
| svelte-dnd-action | 0.9.80 | `svelte >=3.23 \|\| ^5-next` ✅，活跃维护 | 拖拽排序 |
| svelte-sonner | 1.2.1 | `svelte ^5` ✅ | Toast |
| @tailwindcss/typography | 0.5.20 | TW `>=4` ✅ | Markdown prose |
| markdown-it / svelte 5.57 / vite 8.3 / @sveltejs/vite-plugin-svelte 7.3 | 保留现版 | — | — |

工具链实测：bun 1.4.3、node 24。

## 4. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 拖拽库 | svelte-dnd-action（方案 A） | Svelte 生态最成熟、Svelte 5 支持、任意方向容器 + 嵌套 zone + 跨 zone 拖放 + 键盘无障碍全覆盖；pragmatic-drag-and-drop 需自写 Svelte 适配层（失去引库意义）、@thisux/sveltednd 太年轻，均否决 |
| 落地策略 | 分支上一次性切换 | TW v4 接管 app.css 是全局性动作，渐进迁移导致两套样式体系并存、协调成本更高；总量约 2800 行可控 |
| 拖拽语义 | 跨泳道 = patch `{status}`；同泳道拖放弹回 | 服务端无排序持久化（store 仅按 updatedAt/createdAt 排序），维持产品现状，不改 API |
| Tailwind 接入 | 手动四步（bun add + app.css `@import` + vite 插件 + alias），不走 `sv add tailwindcss` | 避免额外 Svelte CLI 改写配置，改动面最小 |
| shadcn 引入 | 官方 CLI `init` + `add`，`components.json` 入库 | 标准路径、可重现；alias 全配 `$lib` → `./src/lib` |
| 主题写入目标 | `html.dark` 类 + `@custom-variant dark` | shadcn/TW v4 约定；三态循环（auto/light/dark）与 localStorage 持久化逻辑保留 |
| 状态色扩展 | 在 app.css 补 `--warning/--success` 明暗两组令牌 | shadcn 默认无 success/warning，确认列（琥珀）与成功操作需要 |
| Markdown 样式 | @tailwindcss/typography `prose prose-sm dark:prose-invert` | 替代手写排版；markdown-it 引擎保留 |

## 5. 拖拽集成设计

每个 Lane 一个 dndzone（默认同 type，天然跨泳道）：

- `items` 直接传 `Task[]`——`Task.id` 满足库「唯一 id」要求，数据形状跨 zone 一致。
- `onconsider` → 本地视觉态回写（纯前端重排预览）。
- `onfinalize` → 新增纯函数 `drop.ts` 的 `dropTask(fromStatus, toStatus)` 判定：
  - 返回 `null`（同泳道）→ 回写原序（视觉弹回），不发请求；
  - 返回 `{ status }` → 走既有乐观写通道 `writeTask`（遮罩→API→settle）。
- `dropTargetStyle` 用内联样式（`outline: 2px dashed var(--primary)`），**不用** `dropTargetClasses`（其类名依赖 Tailwind 扫描命中，易踩坑）。
- `flipDurationMs: 150`；拖拽视觉为库的「morph 变形 + placeholder」范式，替代现有自绘 ghost 跟手。
- **shadow 态**：placeholder 带库的 `SHADOW_ITEM_MARKER_PROPERTY_NAME` 标记流经 Card 组件，Card 据此渲染占位样式并禁用内部按钮。
- **禁拖不变量**：Agent 认领中的 analyzing/executing 卡片不可拖。库是否支持 item 级禁拖需 spike 验证；兜底方案为 finalize 校验非法 → 回写原序 + toast「该任务正由 Agent 处理」。泳道内全部卡片不可拖时置 zone 级 `dragDisabled`。
- **键盘**：`setKeyboardDragTrigger("space")` 把库的键盘起拖收窄为 Space（卡片 Enter 留给打开详情，消除按键冲突）；`setAriaStrings` 中文化屏幕阅读器文案。现有 **Alt+↑/↓ 跨泳道移动**原样保留，与库键盘模式（Space 起拖 + 方向键 + Tab 跨泳道）按键路径不同、并存。

## 6. 主题与设计令牌

- 三态循环 auto → light → dark 不变，localStorage key `taskboard-theme` 不变；写入从 `data-theme` 属性改为 `document.documentElement.classList` 的 `dark`。
- `app.css` 结构：`@import "tailwindcss"` → `@import "tw-animate-css"` → `@custom-variant dark (&:is(.dark *))` → shadcn 标准令牌（`:root` + `.dark`）→ `--warning/--success` 扩展 → `@plugin "@tailwindcss/typography"` → 基础层 `@layer base`。
- 状态色映射（泳道头圆点、卡片左缘色带、状态签同源）：

| 状态 | 令牌 |
|---|---|
| analyzing / executing | `--primary` |
| analysis_confirm / completion_confirm | `--warning` |
| done | `--muted` |
| 危险操作（打回/删除/失败红闪） | `--destructive` |
| 成功操作（通过） | `--success`（扩展） |
| 排队中 | `--warning` |

## 7. 组件映射

| 现有 | 新实现 |
|---|---|
| Header | 自写布局 + `Button`（新建任务）、`Switch`×2（分析确认/自动领取开关）、`DropdownMenu`（主题三态，替代一键循环按钮——唯一 UX 微调）、自定 `StatusDot`（连接状态，Tailwind 小组件 + Tooltip） |
| 新建任务原生 `<dialog>` | shadcn `Dialog` + `Input`/`Textarea`；「失败保留输入与弹窗、错误走 toast」契约不变 |
| ConfirmDialog | shadcn `AlertDialog`（经 notify.ts 封装，`confirmDialog(): Promise<boolean>` 签名不变） |
| Toasts | svelte-sonner（shadcn Toaster） |
| TaskDetail | shadcn `Sheet`（右侧滑出）+ `Input`/`Textarea`/`Badge`/`Table`×2（计时/消耗）/`ScrollArea`；Esc 关闭语义、关闭后焦点返还卡片、打回必填评论、编辑中快照不顶掉输入，全部保留 |
| Lane | 泳道壳 + dndzone 容器 + `Badge`（计数）+ `Skeleton`（首屏） |
| Card | shadcn Card 定制 + dnd item + shadow 态；快速通过/打回按钮（hover/focus-within 显隐）、inflight 半透明 shimmer、fail-flash 红闪、`tabular-nums`、line-clamp-2、240px 定宽全部保留，改 Tailwind 类实现 |
| Markdown | markdown-it 保留，容器加 prose 类 |
| 拖拽 drag.svelte.ts | 删除，职责移交 svelte-dnd-action |

卡片与泳道**不使用 svelte transition**（与库冲突，README 明确警告）；弹窗/抽屉/开关动画用 bits-ui 自带 + tw-animate-css。

## 8. 逻辑层重写（lib/）

保留行为重写（时序契约逐条对齐现有实现）：

- `types.ts`——API 契约类型，服务端不动则类型不自由发挥。
- `api.ts`——fetchBoard/createTask/putSettings/patchTask/deleteTask + token 注入 + 轮询兜底。
- `events.ts`——SSE 全量快照、断线状态机、轮询兜底。
- `optimistic.ts`——applySnapshot/beginOptimistic/settle/visibleTasks，乐观遮罩→settle 时序契约。
- `board.ts`——STATUSES/STATUS_LABELS/分组/timeAgo。
- `duration.ts` / `usage.ts` / `markdown.ts` / `ticker.svelte.ts`——计时、消耗、渲染、心跳。
- `notify.ts`——sonner toast + AlertDialog 封装。
- **新增** `drop.ts`——`dropTask(fromStatus, toStatus): { status } | null`。
- **删除** `drag.svelte.ts`。
- `theme.ts`——三态循环保留，写 `.dark` 类。

目录：

```
webapp/src/
  app.css                 # TW v4 入口 + shadcn 令牌 + warning/success 扩展
  main.ts  App.svelte  theme.ts
  lib/
    types.ts api.ts events.ts optimistic.ts board.ts
    duration.ts usage.ts markdown.ts notify.ts drop.ts ticker.svelte.ts
    components/ui/…       # shadcn CLI 生成（含 utils.ts 的 cn），不改内部
  components/
    Header.svelte Board.svelte Lane.svelte Card.svelte
    TaskDetail.svelte StatusDot.svelte
webapp/test/              # 全量重写（第 10 节）
webapp/tsconfig.json      # 新增：paths {"$lib": …}，仅供 shadcn CLI 与 IDE
```

新增文件清单（工程基座）：`webapp/tsconfig.json`、`webapp/components.json`、`webapp/src/lib/utils.ts`（CLI 生成）。`vite.config.ts` 仅追加 `tailwindcss()` 插件与 `resolve.alias.$lib`，其余一字不动。

## 9. 实施阶段（分支 `feat/shadcn-frontend`，每阶段一提交）

- **P0 工程基座**：tsconfig + vite 插件/alias + `bun add tailwindcss @tailwindcss/vite` + app.css 重写为 TW v4 入口 + `shadcn-svelte init` + theme.ts 改 `.dark`。验收：`bun test` 全绿（旧测试未动）、`bun run build:web` 成功。旧组件视觉暂坏属分支内预期。
- **P1 组件装入与令牌**：`add` 全部所需组件；app.css 补 warning/success 令牌 + typography 插件。
- **P2 逻辑层重写**：第 8 节全部纯函数 + `webapp/test/` 全量重写。验收：`bun test` 全绿。
- **P3 显示层重写**：第 7 节组件 + dnd 接线 + 装配。首日先做禁拖 spike。验收：`bun test` 全绿 + 手工清单（第 12 节）。
- **P4 交付**：`bun run build:web` 产物重建，与源码同提交；合并回 master。

## 10. 测试计划（bun test，唯一验收门）

| 测试文件 | 覆盖 |
|---|---|
| drop.test.ts | 同泳道 → null；跨泳道 → {status}；非法状态序输入 |
| optimistic.test.ts | 遮罩/settle/失败回滚时序；快照覆盖非编辑态 |
| events.test.ts | 模拟 EventSource：首快照、断线状态、轮询兜底 |
| board.test.ts | 分组、空泳道、timeAgo |
| duration.test.ts / usage.test.ts | 两段计时、排队时长、token 格式化 |
| markdown.test.ts | 渲染契约 |

shadcn 的 `ui/` 组件与视觉层不进单测，由手工清单兜底。

## 11. 回归基线（交互不变量）

乐观遮罩→settle 时序与失败回滚；快速通过静默红闪（防 toast 轰炸）；SSE 快照不顶掉编辑中的输入；SSE 断线轮询兜底与恢复；关闭详情焦点返还卡片；Agent 认领中禁拖 + 禁键盘移动；`invalid_transition` 的人话提示；主题三态循环与持久化；打回必填评论；新建失败保留输入；token 占位符注入（`__TASKBOARD_TOKEN_VALUE__`，bun 测试环境无 DOM 时 api.ts 的惰性读取）。

## 12. 手工验收清单（P3/P4）

`bun run dev` + `bun run dev:web`：

1. 创建任务（成功/标题为空禁用/失败保留输入）。
2. 七泳道流转全路径：领取→分析→（分析确认开关两态）→执行→完成确认→done。
3. 拖拽：跨泳道改状态；同泳道弹回；Agent 认领中卡片禁拖；placeholder 视觉。
4. 键盘：Alt+↑/↓ 移动；Enter 开详情；Esc 关详情/弹窗；Space 键盘拖拽（增强项）。
5. 详情抽屉：编辑标题/描述失焦保存、计时/消耗表、评论添加、打回必填、删除二次确认。
6. 主题三态循环 + 刷新持久化 + auto 跟随系统。
7. 断网：连接状态点变红 → 恢复后快照重同步。
8. `opencode service restart` 后真实插件伺服（src/web 产物）完整走一遍 1–7。

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| svelte-dnd-action 无 item 级禁拖（未证实） | P3 首日 spike；兜底 finalize 校验 + 视觉提示 |
| svelte transition 与库冲突 | 卡片/泳道不用 transition，动效走 CSS |
| `dropTargetClasses` 依赖 TW 扫描命中 | 改用 `dropTargetStyle` 内联样式 |
| CLI init 交互式、产出漂移 | `components.json` 与生成物全部入库 |
| 产物新增 `board.css` | `assetFileNames: assets/board.[ext]` 已钉死 |
| 240px 定宽卡片与 shadcn 尺度违和 | 定宽是布局不变量，内部尺度随令牌；违和明显时再议 |
