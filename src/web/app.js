/* 任务看板前端：原生 ES Module，无依赖。数据流：2s 轮询 /api/tasks 与 /api/settings，
   内容指纹（boardKey）未变时跳过重绘，拖拽进行中推迟重绘，避免打断交互。 */
import { boardKey } from "./viewmodel.js"

const TOKEN = window.__TASKBOARD_TOKEN__
const HEADERS = { "Content-Type": "application/json", "X-Taskboard-Token": TOKEN }

const COLUMNS = [
  ["planning", "待规划"],
  ["pending", "待领取"],
  ["analyzing", "分析中"],
  ["analysis_confirm", "分析确认"],
  ["executing", "执行中"],
  ["completion_confirm", "完成确认"],
  ["done", "已完成"],
]
const CONFIRM_COLS = new Set(["analysis_confirm", "completion_confirm"])

let tasks = []
let settings = { requireAnalysisConfirm: false }
let lastKey = ""
let dialogMode = "reject" // "reject" | "comment"
let dialogTargetId = null
let editTargetId = null

const $ = (id) => document.getElementById(id)
const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const fmtTime = (ts) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error?.message) msg = body.error.message
    } catch {}
    throw new Error(msg)
  }
  return res.json()
}

async function refresh() {
  try {
    const [t, s] = await Promise.all([
      fetch("/api/tasks").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ])
    const nextSettings = s ?? settings
    const key = boardKey(t, nextSettings)
    if (key === lastKey) return
    tasks = t
    if (JSON.stringify(nextSettings) !== JSON.stringify(settings)) {
      settings = nextSettings
      $("require-analysis").checked = !!settings.requireAnalysisConfirm
    }
    render()
    lastKey = key
  } catch {
    /* 服务不可达时保留上次渲染，下轮重试 */
  }
}

function render() {
  if (document.querySelector(".card.dragging")) {
    setTimeout(refresh, 400) // 拖拽进行中推迟本轮重绘
    return
  }
  const board = $("board")
  board.innerHTML = COLUMNS.map(([status, label]) => {
    const list = tasks.filter((t) => t.status === status)
    return `<section class="column" data-status="${status}">
      <h2>${label}<span class="count">${list.length}</span></h2>
      ${list.map(cardHTML).join("")}
    </section>`
  }).join("")

  board.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.id)
      el.classList.add("dragging")
    })
    el.addEventListener("dragend", () => el.classList.remove("dragging"))
  })
  board.querySelectorAll(".column").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault()
      col.classList.add("drag-over")
    })
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"))
    col.addEventListener("drop", async (e) => {
      e.preventDefault()
      col.classList.remove("drag-over")
      const id = e.dataTransfer.getData("text/plain")
      const status = col.dataset.status
      const task = tasks.find((t) => t.id === id)
      if (!task || task.status === status) return
      try {
        await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) })
        refresh()
      } catch (err) {
        alert(`移动失败：${err.message}`)
      }
    })
  })
  board.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn.dataset.act, btn.dataset.id))
  })
}

async function handleAction(act, id) {
  try {
    if (act === "confirm") {
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ action: "confirm" }) })
      refresh()
      return
    }
    if (act === "delete") {
      if (!confirm("删除该任务？此操作不可恢复。")) return
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
      refresh()
      return
    }
    if (act === "edit") {
      renderEditDialog(await api(`/api/tasks/${encodeURIComponent(id)}`))
      return
    }
    dialogTargetId = id
    const commentBox = $("dialog-comment")
    if (act === "reject") {
      dialogMode = "reject"
      $("dialog-title").textContent = "打回任务"
      commentBox.placeholder = "打回原因（必填，将作为评论保留）"
    } else if (act === "comment") {
      dialogMode = "comment"
      $("dialog-title").textContent = "添加评论"
      commentBox.placeholder = "评论内容（必填）"
    }
    commentBox.value = ""
    $("dialog").showModal()
  } catch (err) {
    alert(`操作失败：${err.message}`)
  }
}

function cardHTML(t) {
  const claim = t.claim
    ? t.claim.agent === "human"
      ? `<span class="claimer-human">👤 用户执行中</span>`
      : `<span>🤖 ${esc(t.claim.agent)} · ${esc(t.claim.sessionID.slice(0, 8))}</span>`
    : ""
  const shown = t.comments.slice(-3)
  const rest = t.comments.length - shown.length
  const actions = `<div class="actions">
      ${CONFIRM_COLS.has(t.status) ? `<button data-act="confirm" data-id="${esc(t.id)}">通过</button>` : ""}
      ${CONFIRM_COLS.has(t.status) ? `<button data-act="reject" data-id="${esc(t.id)}" class="danger">打回</button>` : ""}
      <button data-act="comment" data-id="${esc(t.id)}" class="ghost">💬</button>
      <button data-act="edit" data-id="${esc(t.id)}" class="ghost">✎</button>
      <button data-act="delete" data-id="${esc(t.id)}" class="ghost">🗑</button>
    </div>`
  return `<div class="card" draggable="true" data-id="${esc(t.id)}">
    <div class="title">${esc(t.title)}</div>
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
    ${t.analysis ? `<div class="desc">📌 ${esc(t.analysis)}</div>` : ""}
    ${t.result ? `<div class="desc">✅ ${esc(t.result)}</div>` : ""}
    <div class="meta">
      <span>${fmtTime(t.updatedAt)}</span>
      ${claim}
      ${shown.map((c) => `<span class="comment">💬 [${esc(c.author)}] ${esc(c.text)}</span>`).join("")}
      ${rest > 0 ? `<span>…还有 ${rest} 条评论</span>` : ""}
    </div>
    ${actions}
  </div>`
}

function renderEditDialog(task) {
  $("edit-title").value = task.title
  $("edit-desc").value = task.description
  editTargetId = task.id
  $("edit-dialog").showModal()
}

$("new-task").addEventListener("submit", async (e) => {
  e.preventDefault()
  const title = $("new-title").value.trim()
  if (!title) return
  const description = $("new-desc").value.trim()
  try {
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ title, description }) })
    $("new-title").value = ""
    $("new-desc").value = ""
    refresh()
  } catch (err) {
    alert(`创建失败：${err.message}`)
  }
})

$("require-analysis").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ requireAnalysisConfirm: e.target.checked }) })
    refresh()
  } catch (err) {
    alert(`设置失败：${err.message}`)
    e.target.checked = !e.target.checked
  }
})

$("dialog-cancel").addEventListener("click", () => $("dialog").close())
$("dialog-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const text = $("dialog-comment").value.trim()
  if (!text) return
  const action = dialogMode === "reject" ? "reject" : "comment"
  try {
    await api(`/api/tasks/${encodeURIComponent(dialogTargetId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action, comment: text }),
    })
    $("dialog").close()
    refresh()
  } catch (err) {
    alert(`${dialogMode === "reject" ? "打回" : "评论"}失败：${err.message}`)
  }
})

$("edit-cancel").addEventListener("click", () => $("edit-dialog").close())
$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const title = $("edit-title").value.trim()
  if (!title || !editTargetId) return
  try {
    await api(`/api/tasks/${encodeURIComponent(editTargetId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title, description: $("edit-desc").value.trim() }),
    })
    $("edit-dialog").close()
    refresh()
  } catch (err) {
    alert(`保存失败：${err.message}`)
  }
})

// 编辑入口在 handleAction 的 "edit" 分支

refresh()
setInterval(refresh, 2000)
