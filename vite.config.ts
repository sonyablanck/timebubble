import { defineConfig } from "vitest/config";

// GitHub Pages serves the site under /<repo-name>/. Set BASE_PATH when building
// for Pages (e.g. BASE_PATH=/time-bubble/ npm run build); local dev uses "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
  },
});
