import { defineConfig } from "vitest/config";

// Tests against real services, not part of `npm test`:
// `npm run test:live` (the Grafeno server in `.env`) and
// `npm run test:live:model` (Claude through the user's Claude Code login,
// which spends a little of the plan's usage).
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
