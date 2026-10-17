import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"

// Taskboard 看板构建配置：产物固定文件名（避免 hash 污染 git 历史），直接落到插件伺服目录。
export default defineConfig({
  plugins: [svelte()],
  server: {
    // dev:web 的 /api 转发到 bun run dev 起的看板服务（token=dev）
    proxy: {
      "/api": "http://127.0.0.1:4370",
    },
  },
  build: {
    outDir: "../src/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/board.js",
        chunkFileNames: "assets/board.js",
        assetFileNames: "assets/board.[ext]",
      },
    },
  },
})
