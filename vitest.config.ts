import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/live/**"],
    env: {
      // Git as on CI, whatever the machine: the developer's global and system
      // settings (a global `commit.gpgsign` signs every commit and merge the
      // tests make, with ssh-keygen) neither leak into nor slow down the tests.
      GIT_CONFIG_GLOBAL: fileURLToPath(new URL("test/fixtures/gitconfig", import.meta.url)),
      GIT_CONFIG_NOSYSTEM: "1",
      // No one's own skills (in their home folder) reach the tests.
      AGENT_SKILLS_HOME: fileURLToPath(new URL("test/fixtures/no-home", import.meta.url)),
    },
  },
});
