import { Plugin } from "@opencode/plugin"

// Task 1 探针版：验证 Bun.serve / storage 作用域 / 工具生效名 / 命令注册。
// 后续 Task 6 将整体重写为本体插件。
export default Plugin.define({
  id: "taskboard-spike",
  async setup(ctx) {
    console.log(`[taskboard] spike setup dir=${ctx.location.directory} app=v${ctx.app.version}`)

    // 1) Bun.serve 可用性
    let serve: { hostname: string; port: number; stop(close?: boolean): void } | undefined
    try {
      serve = Bun.serve({
        hostname: "127.0.0.1",
        port: 4390,
        fetch: () => Response.json({ ok: true }),
      })
      console.log(`[taskboard] Bun.serve OK http://${serve.hostname}:${serve.port}`)
    } catch (e) {
      console.error("[taskboard] Bun.serve FAILED", e)
    }

    // 2) storage 读写与扫描
    try {
      await ctx.storage.set("spike/probe", { dir: ctx.location.directory, ts: Date.now() })
      const scanned = await ctx.storage.scan({ prefix: "spike/" })
      console.log(`[taskboard] storage.scan(spike/) => ${JSON.stringify(scanned)}`)
    } catch (e) {
      console.error("[taskboard] storage FAILED", e)
    }

    // 3) 工具命名空间与生效名
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "spike", description: "spike 探针工具" })
      editor.add({
        name: "hello",
        description: "spike 探针：返回问候文本",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "spike" },
        execute: async () => ({ content: "hello from spike" }),
      })
    })
    const tools = await ctx.tool.list()
    console.log(`[taskboard] tool.list => ${tools.map((t) => t.id).join(",")}`)

    // 4) 命令注册与浏览器拉起
    await ctx.command.transform((editor) => {
      editor.add({
        name: "spike-open",
        description: "spike 探针：打开看板地址",
        execute: async () => {
          try {
            Bun.spawn(["xdg-open", "http://127.0.0.1:4390"])
            console.log("[taskboard] xdg-open spawned OK")
          } catch (e) {
            console.error("[taskboard] xdg-open FAILED", e)
          }
        },
      })
    })

    return () => {
      serve?.stop(true)
      console.log("[taskboard] spike cleanup")
    }
  },
})
