import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: { "/v1": process.env.KAENO_URL ?? "http://localhost:8080" },
  },
});
