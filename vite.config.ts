import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/webview",
  base: "",
  build: {
    outDir: "../../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/webview/index.html")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  }
});
