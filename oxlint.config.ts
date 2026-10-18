import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import svelte from "ultracite/oxlint/svelte";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, svelte, vitest],
  ignorePatterns: core.ignorePatterns,
});
