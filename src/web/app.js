/* 任务看板前端：原生 JS，无依赖。数据流：2s 轮询 /api/tasks 与 /api/settings。 */
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

const STATUS_TEXT = {
  planning: "待规划",
  pending: "待领取",
  analyzing: "分析中",
  analysis_confirm: "分析确认",
  executing: "执行中",
  completion_confirm: "完成确认",
  done: "已完成",
}

let tasks = []
let settings = { requireAnalysisConfirm: false }
let rejectTargetId = null

const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

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
    tasks = t
    if (JSON.stringify(s) !== JSON.stringify(settings)) {
      settings = s
      document.getElementById("require-analysis").checked = !!s.requireAnalysisConfirm
    }
    render()
  } catch {
    /* 服务不可达时保留上次渲染，下轮重试 */
  }
}

function cardHTML(t) {
  const claim = t.claim
    ? t.claim.agent === "human"
      ? `<span class="claimer-human">👤 用户执行中</span>`
      : `<span>🤖 ${esc(t.claim.agent)} · ${esc(t.claim.sessionID.slice(0, 8))}</span>`
    : ""
  const lastComment = t.comments.length ? t.comments[t.comments.length - 1] : null
  const actions = CONFIRM_COLS.has(t.status)
    ? `<div class="actions">
         <button data-act="confirm" data-id="${esc(t.id)}">通过</button>
         <button data-act="reject" data-id="${esc(t.id)}" class="danger">打回</button>
       </div>`
    : ""
  return `<div class="card" draggable="true" data-id="${esc(t.id)}">
    <div class="title">${esc(t.title)}</div>
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
    ${t.analysis ? `<div class="desc">📌 ${esc(t.analysis)}</div>` : ""}
    ${t.result ? `<div class="desc">✅ ${esc(t.result)}</div>` : ""}
    <div class="meta">
      ${claim}
      ${lastComment ? `<span class="comment">💬 [${esc(lastComment.author)}] ${esc(lastComment.text)}</span>` : ""}
      ${t.comments.length > 1 ? `<span>共 ${t.comments.length} 条评论</span>` : ""}
    </div>
    ${actions}
  </div>`
}

function render() {
  const board = document.getElementById("board")
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
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id
      if (btn.dataset.act === "confirm") {
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ action: "confirm" }),
          })
          refresh()
        } catch (err) {
          alert(`操作失败：${err.message}`)
        }
      } else {
        rejectTargetId = id
        document.getElementById("reject-comment").value = ""
        document.getElementById("reject-dialog").showModal()
      }
    })
  })
}

document.getElementById("new-task").addEventListener("submit", async (e) => {
  e.preventDefault()
  const title = document.getElementById("new-title").value.trim()
  if (!title) return
  const description = document.getElementById("new-desc").value.trim()
  try {
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ title, description }) })
    document.getElementById("new-title").value = ""
    document.getElementById("new-desc").value = ""
    refresh()
  } catch (err) {
    alert(`创建失败：${err.message}`)
  }
})

document.getElementById("require-analysis").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ requireAnalysisConfirm: e.target.checked }),
    })
    refresh()
  } catch (err) {
    alert(`设置失败：${err.message}`)
    e.target.checked = !e.target.checked
  }
})

document.getElementById("reject-cancel").addEventListener("click", () => {
  document.getElementById("reject-dialog").close()
})
document.getElementById("reject-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const comment = document.getElementById("reject-comment").value.trim()
  if (!comment || !rejectTargetId) return
  try {
    await api(`/api/tasks/${encodeURIComponent(rejectTargetId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "reject", comment }),
    })
    document.getElementById("reject-dialog").close()
    refresh()
  } catch (err) {
    alert(`打回失败：${err.message}`)
  }
})

refresh()
setInterval(refresh, 2000)
