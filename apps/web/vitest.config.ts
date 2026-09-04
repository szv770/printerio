import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next.js's bundler aliases "server-only" to its no-op stub on the
      // server compilation graph; plain Vitest has no such mechanism, so we
      // do the same thing here. Without this, any lib/** file that does
      // `import "server-only"` throws immediately under test (the real
      // package's index.js unconditionally throws - see its source).
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
