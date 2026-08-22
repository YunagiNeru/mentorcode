import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/landing",
  base: "",
  publicDir: resolve(__dirname, "media"),
  build: {
    outDir: "../../dist/landing",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/landing/index.html")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: false
  }
});
