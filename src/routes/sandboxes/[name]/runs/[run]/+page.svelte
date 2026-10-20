<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";
  import RunState from "#lib/components/run-state.svelte";
  import TerminalView from "#lib/components/terminal-view.svelte";
  import { formatTime } from "#lib/format.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let busy = $state<"rerun" | "stop" | undefined>();
  let message = $state("");

  const sandboxPage = $derived(
    resolve("/sandboxes/[name]", { name: data.sandbox.name })
  );

  const submit =
    (what: NonNullable<typeof busy>): SubmitFunction =>
    () => {
      busy = what;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        await update();
      };
    };
</script>

<svelte:head>
  <title>{data.run?.command ?? "Run"} · {data.sandbox.name} · Makak Panel</title
  >
</svelte:head>

<p class="back"><a href={sandboxPage}>← {data.sandbox.name}</a></p>

{#if data.run === undefined}
  <p class="error">{data.problem}</p>
{:else}
  {@const run = data.run}
  <header>
    <h1><code>{run.command}</code></h1>
    <RunState {run} />
  </header>
  <p class="muted">
    Started {formatTime(run.startedAt)} in <code>{run.cwd}</code>
  </p>

  <div class="actions">
    {#if run.state === "running"}
      <form
        method="POST"
        action={`${sandboxPage}?/stopRun`}
        use:enhance={submit("stop")}
      >
        <input type="hidden" name="id" value={data.sandbox.id} />
        <input type="hidden" name="run" value={run.id} />
        <button type="submit" disabled={busy !== undefined}>
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      </form>
    {/if}
    <form
      method="POST"
      action={`${sandboxPage}?/rerun`}
      use:enhance={submit("rerun")}
    >
      <input type="hidden" name="id" value={data.sandbox.id} />
      <input type="hidden" name="run" value={run.id} />
      <button type="submit" disabled={busy !== undefined}>
        {busy === "rerun" ? "Starting…" : "Run again"}
      </button>
    </form>
  </div>
  {#if message !== ""}
    <p class="error">{message}</p>
  {/if}

  {#key run.id}
    <TerminalView
      columns={data.size.columns}
      logSize={run.logSize}
      name={data.sandbox.name}
      onended={() => invalidateAll()}
      rows={data.size.rows}
      run={run.id}
      running={run.state === "running"}
    />
  {/key}
{/if}

<style>
  .back {
    margin: 0 0 1rem;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--muted);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
</style>
