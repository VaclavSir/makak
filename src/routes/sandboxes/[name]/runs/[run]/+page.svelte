<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import RunState from "#lib/components/run-state.svelte";
  import TerminalView from "#lib/components/terminal-view.svelte";
  import { RUN_PAGE } from "#lib/dependencies.ts";
  import { formatTime } from "#lib/format.ts";
  import { runIdOf } from "#lib/run-tabs.ts";
  import { getRunsContext } from "#lib/runs-context.ts";
  import type { PageProps } from "./$types";
  import { idle, submitting } from "#lib/submit.ts";

  let { data }: PageProps = $props();

  const runs = getRunsContext();

  const form = $state(idle<"rerun" | "stop">());

  const sandboxPage = $derived(
    resolve("/sandboxes/[name]", { name: data.sandbox.name })
  );

  const submit = (what: "rerun" | "stop") =>
    submitting(form, what, async ({ result, update }) => {
      // The rerun takes this tab over.
      const rerun =
        result.type === "redirect" ? runIdOf(result.location) : undefined;
      if (data.run !== undefined && rerun !== undefined) {
        runs.rerun(data.run.id, rerun);
      }
      // Stay here: the actions belong to the overview.
      await update({ navigate: false, refreshAll: false });
      if (rerun === undefined) {
        await invalidate(RUN_PAGE, true);
      }
      await runs.refresh();
    });
</script>

<svelte:head>
  <title>{data.run?.command ?? "Run"} · {data.sandbox.name} · Makak Panel</title
  >
</svelte:head>

{#if data.run === undefined}
  <p class="error">{data.problem}</p>
{:else}
  {@const run = data.run}
  <div class="top">
    <div class="about">
      <div class="title">
        <code class="command">{run.command}</code>
        <RunState {run} />
      </div>
      <p class="muted">
        Started {formatTime(run.startedAt)} in <code>{run.cwd}</code>
      </p>
    </div>
    {#if run.state === "running"}
      <form
        method="POST"
        action={`${sandboxPage}?/stopRun`}
        use:enhance={submit("stop")}
      >
        <input type="hidden" name="id" value={data.sandbox.id} />
        <input type="hidden" name="run" value={run.id} />
        <button type="submit" disabled={form.busy !== undefined}>
          {form.busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      </form>
    {:else}
      <form
        method="POST"
        action={`${sandboxPage}?/rerun`}
        use:enhance={submit("rerun")}
      >
        <input type="hidden" name="id" value={data.sandbox.id} />
        <input type="hidden" name="run" value={run.id} />
        <button type="submit" disabled={form.busy !== undefined}>
          {form.busy === "rerun" ? "Starting…" : "Run again"}
        </button>
      </form>
    {/if}
  </div>
  {#if form.message !== ""}
    <p class="error">{form.message}</p>
  {/if}

  {#key run.id}
    <TerminalView
      columns={data.size.columns}
      logSize={run.logSize}
      name={data.sandbox.name}
      onended={() => {
        void invalidate(RUN_PAGE, true);
        void runs.refresh();
      }}
      rows={data.size.rows}
      run={run.id}
      running={run.state === "running"}
    />
  {/key}
{/if}

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin: 0.75rem 0;
  }

  .about {
    min-width: 0;
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
  }

  .command {
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .muted {
    margin: 0.2rem 0 0;
    color: var(--muted);
  }
</style>
