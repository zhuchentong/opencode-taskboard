import { describe, expect, test } from "bun:test"
import {
  TerminalConfigError,
  discoverDaemon,
  normalizeDaemonUrl,
  parseServiceJson,
  resolveServiceFilePath,
} from "../../src/terminal/service"

describe("opencode 服务发现", () => {
  test("服务注册文件路径：XDG 优先，其次 ~/.local/state", () => {
    expect(resolveServiceFilePath({ env: { XDG_STATE_HOME: "/xdg" }, home: "/home/u" })).toBe(
      "/xdg/opencode/service.json",
    )
    expect(resolveServiceFilePath({ env: {}, home: "/home/u" })).toBe(
      "/home/u/.local/state/opencode/service.json",
    )
    expect(resolveServiceFilePath({ serviceFile: "/custom/s.json", env: {}, home: "/home/u" })).toBe(
      "/custom/s.json",
    )
  })

  test("parseServiceJson:取 url 与 password，url 去尾斜杠", () => {
    const info = parseServiceJson(JSON.stringify({ id: "x", url: "http://127.0.0.1:49898/", password: "pw" }))
    expect(info).toEqual({ url: "http://127.0.0.1:49898", password: "pw" })
  })

  test("parseServiceJson:坏 JSON/缺 url/缺 password 一律中文错误", () => {
    expect(() => parseServiceJson("{", "/a/b.json")).toThrow(/解析失败/)
    expect(() => parseServiceJson(JSON.stringify({ password: "pw" }), "/a/b.json")).toThrow(/缺少 url 字段/)
    expect(() => parseServiceJson(JSON.stringify({ url: "http://x" }), "/a/b.json")).toThrow(/缺少 password 字段/)
    expect(() => parseServiceJson(JSON.stringify({ url: "ftp://x", password: "p" }))).toThrow(TerminalConfigError)
  })

  test("normalizeDaemonUrl:必须 http(s) 开头且去尾斜杠", () => {
    expect(normalizeDaemonUrl("http://127.0.0.1:1/")).toBe("http://127.0.0.1:1")
    expect(() => normalizeDaemonUrl("127.0.0.1:1")).toThrow(/必须以 http/)
    expect(() => normalizeDaemonUrl("")).toThrow(/不能为空/)
  })

  test("discoverDaemon:读文件成功返回地址与凭据", async () => {
    const info = await discoverDaemon({
      serviceFilePath: "/tmp/svc.json",
      readFileImpl: async () => JSON.stringify({ url: "http://127.0.0.1:49898", password: "pw" }),
    })
    expect(info).toEqual({ url: "http://127.0.0.1:49898", password: "pw" })
  })

  test("discoverDaemon:文件不存在 → 中文错误（提示先启动服务）", async () => {
    const err = new Error("no such file") as NodeJS.ErrnoException
    err.code = "ENOENT"
    await expect(
      discoverDaemon({
        serviceFilePath: "/tmp/missing.json",
        readFileImpl: async () => {
          throw err
        },
      }),
    ).rejects.toThrow(/未找到 opencode 服务注册文件/)
  })

  test("discoverDaemon:读取失败 → 中文错误", async () => {
    await expect(
      discoverDaemon({
        serviceFilePath: "/tmp/x.json",
        readFileImpl: async () => {
          throw new Error("权限不足")
        },
      }),
    ).rejects.toThrow(/读取 opencode 服务注册文件失败/)
  })
})
