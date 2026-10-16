import { mount } from "svelte"
import App from "./App.svelte"
import { initTheme } from "./theme"
import "./app.css"

// 挂载前先落 data-theme，避免首帧主题闪烁
initTheme()

const target = document.getElementById("app")
if (target) mount(App, { target })
