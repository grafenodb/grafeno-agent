import { defineConfig } from "vitest/config";

// Tests against a running Grafeno server, configured from the environment
// (or `.env`). Not part of `npm test`: run with `npm run test:live`.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
