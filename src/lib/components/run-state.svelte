<script lang="ts">
  interface Run {
    exitCode: number | undefined;
    state: "exited" | "lost" | "running" | "stopped";
  }

  let { run }: { run: Run } = $props();

  const label = $derived.by(() => {
    if (run.state === "running") {
      return "running";
    }
    if (run.state === "lost") {
      return "ended unrecorded";
    }
    if (run.state === "stopped") {
      return "stopped";
    }
    return run.exitCode === 0 ? "done" : `failed (${run.exitCode})`;
  });
  const tone = $derived.by(() => {
    if (run.state === "running") {
      return "running";
    }
    return run.state === "stopped" ||
      (run.state === "exited" && run.exitCode === 0)
      ? "ok"
      : "bad";
  });
</script>

<span
  class={["state", tone]}
  title={run.state === "lost"
    ? "It stopped without an exit code, e.g. because its sandbox stopped."
    : undefined}>{label}</span
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
