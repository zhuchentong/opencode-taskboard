// Mock 模式：内存 store + 真实 server，浏览器直接调试前端，无需 OpenCode。
// 用法：bun run src/dev.ts → http://127.0.0.1:4370/（token 固定为 dev）
import { createStore, memoryBackend } from "./store"
import { createServer } from "./server"

const store = createStore(memoryBackend(), { requireAnalysisConfirm: false, directory: process.cwd() })

// 预置三条不同阶段的样例任务
await store.create({ title: "示例：梳理登录模块的问题", description: "处于待规划，补充清楚目标后再拖到待领取" })
const pending = await store.create({ title: "示例：修复看板拖拽偶发失效", description: "已规划完毕，等待 Agent 认领" })
await store.patch(pending.id, { status: "pending" })
const done = await store.create({ title: "示例：升级依赖版本", description: "已完成" })
await store.patch(done.id, { status: "pending" })
await store.patch(done.id, { status: "done" })

const handle = createServer(store, {
  port: Number(process.env.TASKBOARD_PORT) || 4370,
  token: "dev",
  webDir: new URL("./web/", import.meta.url).pathname,
  primary: true,
  logs: () => ["dev 模式运行中"],
})

console.log(`[taskboard] dev 看板已启动：http://127.0.0.1:${handle.actualPort}/ （token=dev，Ctrl+C 退出）`)
