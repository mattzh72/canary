import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "canary-core": path.resolve(__dirname, "../canary-core/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
