import { describe, expect, test } from "bun:test"
import { createServer } from "../src/server"
import { clientStore } from "../src/client"
import { createStore, memoryBackend } from "../src/store"

/** 同项目双实例场景：次要实例（4371 角色）经 clientStore 把写代理到主实例（4370 角色） */
describe("双实例代理（次要实例写路径）", () => {
  test("经次要端口的 claim/patch 落到主实例存储；次要端 GET 反映主实例数据", async () => {
    const primaryStore = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const primary = createServer(primaryStore, {
      port: 0,
      token: "tok-primary",
      webDir: import.meta.dir + "/fixtures-web",
      primary: true,
      projectID: "proj-dual",
    })
    const primaryPort = primary.actualPort

    const secondaryStore = clientStore(`http://127.0.0.1:${primaryPort}`, "tok-primary")
    const secondary = createServer(secondaryStore, {
      port: 0,
      token: "tok-primary",
      webDir: import.meta.dir + "/fixtures-web",
      primary: false,
      projectID: "proj-dual",
    })

    const auth = { "Content-Type": "application/json", "X-Taskboard-Token": "tok-primary" }
    const sec = `http://127.0.0.1:${secondary.actualPort}`

    // 次要端口健康检查暴露 primary:false
    const health = await (await fetch(`${sec}/api/health`)).json()
    expect(health).toMatchObject({ ok: true, primary: false, projectID: "proj-dual" })

    // 经次要端口创建并推到待领取（写代理）
    const created = await (
      await fetch(`${sec}/api/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ title: "代理写验证" }) })
    ).json()
    expect(created.id).toBeTruthy()
    await fetch(`${sec}/api/tasks/${created.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "pending" }) })

    // 经次要端口 claim
    const claimed = await (
      await fetch(`${sec}/api/claim`, { method: "POST", headers: auth, body: JSON.stringify({ sessionID: "ses-secondary" }) })
    ).json()
    expect(claimed.status).toBe("analyzing")

    // 主实例存储直接核验
    const onPrimary = await primaryStore.get(created.id)
    expect(onPrimary?.status).toBe("analyzing")
    expect(onPrimary?.claim?.sessionID).toBe("ses-secondary")

    for (const h of [primary, secondary]) h.stop()
  })
})
