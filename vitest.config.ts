import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Container start-up and image pulls can be slow on a cold machine.
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});
