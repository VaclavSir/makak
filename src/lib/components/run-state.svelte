<script lang="ts">
  import { runLabel, runTone } from "#lib/runs.ts";

  interface Run {
    exitCode: number | undefined;
    state: "exited" | "lost" | "running" | "stopped";
  }

  let { run }: { run: Run } = $props();
</script>

<span
  class={["state", runTone(run)]}
  title={run.state === "lost"
    ? "It stopped without an exit code, e.g. because its sandbox stopped."
    : undefined}>{runLabel(run)}</span
>

<style>
  .state {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.6rem;
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .running {
    color: var(--running);
  }

  .ok {
    color: var(--muted);
  }

  .bad {
    color: var(--error-text);
  }
</style>
