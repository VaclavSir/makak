<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";
  import RunState from "#lib/components/run-state.svelte";
  import { formatTime } from "#lib/format.ts";
  import type { PackageScripts, RunCommand } from "#server/sandbox-runs.ts";
  import type { Run } from "#server/tools/index.ts";

  interface RunsView {
    commands: RunCommand[];
    error: string | undefined;
    list: Run[] | undefined;
    prompt: boolean;
    scripts: PackageScripts | undefined;
  }

  let {
    agent,
    id,
    name,
    runs,
    running,
    workspaces,
  }: {
    agent: string | undefined;
    id: string;
    name: string;
    runs: RunsView;
    running: boolean;
    workspaces: string[];
  } = $props();

  /** How many runs are listed; older ones are kept in the sandbox. */
  const LISTED = 15;
  const POLL_MS = 3000;

  // The list as polled, starting from what the page loaded.
  // svelte-ignore state_referenced_locally
  let list = $state(runs.list);
  let busy = $state<string | undefined>();
  let message = $state("");
  let command = $state("");
  // svelte-ignore state_referenced_locally
  let cwd = $state(workspaces[0] ?? "");
  let prompt = $state("");

  $effect(() => {
    ({ list } = runs);
  });

  const anyRunning = $derived(list?.some(({ state }) => state === "running"));

  // Polled while something runs, so states and exit codes appear.
  $effect(() => {
    if (!running || anyRunning !== true) {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          `/sandboxes/${encodeURIComponent(name)}/runs`
        );
        const body = (await response.json()) as { runs?: Run[] };
        if (body.runs !== undefined) {
          list = body.runs;
        }
      } catch {
        // The next poll tries again.
      }
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  });

  const runPage = (run: string) =>
    resolve("/sandboxes/[name]/runs/[run]", { name, run });

  const submit =
    (what: string): SubmitFunction =>
    () => {
      busy = what;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        await update({ reset: false });
      };
    };
</script>

{#if !running}
  <p class="muted">
    Start the sandbox to run commands in it. Its runs are kept in it.
  </p>
{:else}
  {#if runs.error !== undefined}
    <p class="error">{runs.error}</p>
  {/if}

  {#if runs.commands.length > 0}
    <div class="row">
      {#each runs.commands as configured (`${configured.cwd}:${configured.label}`)}
        <form
          method="POST"
          action="?/run"
          use:enhance={submit(configured.label)}
        >
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="kind" value="command" />
          <input type="hidden" name="command" value={configured.command} />
          <input type="hidden" name="cwd" value={configured.cwd} />
          <button
            type="submit"
            title={configured.command}
            disabled={busy !== undefined}
            >{busy === configured.label
              ? "Starting…"
              : configured.label}</button
          >
        </form>
      {/each}
    </div>
  {/if}

  {#if runs.scripts !== undefined && runs.scripts.names.length > 0}
    <form
      class="row"
      method="POST"
      action="?/run"
      use:enhance={submit("script")}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="kind" value="script" />
      <label>
        <span class="muted">{runs.scripts.manager} run</span>
        <select name="script" aria-label="package.json script">
          {#each runs.scripts.names as script (script)}
            <option value={script}>{script}</option>
          {/each}
        </select>
      </label>
      <button type="submit" disabled={busy !== undefined}>
        {busy === "script" ? "Starting…" : "Run"}
      </button>
    </form>
  {/if}

  <form
    class="row"
    method="POST"
    action="?/run"
    use:enhance={submit("command")}
  >
    <input type="hidden" name="id" value={id} />
    <input type="hidden" name="kind" value="command" />
    <input
      class="grow mono"
      name="command"
      aria-label="Command"
      placeholder="A command, run with bash"
      autocomplete="off"
      spellcheck="false"
      bind:value={command}
    />
    {#if workspaces.length > 1}
      <select name="cwd" aria-label="Directory" bind:value={cwd}>
        {#each workspaces as workspace (workspace)}
          <option value={workspace}>{workspace}</option>
        {/each}
      </select>
    {:else}
      <input type="hidden" name="cwd" value={cwd} />
    {/if}
    <button
      type="submit"
      disabled={busy !== undefined || command.trim() === ""}
    >
      {busy === "command" ? "Starting…" : "Run"}
    </button>
  </form>

  {#if runs.prompt}
    <form
      class="row"
      method="POST"
      action="?/run"
      use:enhance={submit("prompt")}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="kind" value="prompt" />
      <textarea
        class="grow"
        name="prompt"
        rows="2"
        aria-label="Prompt"
        placeholder={`A one-shot prompt for ${agent}`}
        bind:value={prompt}></textarea>
      <button
        type="submit"
        disabled={busy !== undefined || prompt.trim() === ""}
      >
        {busy === "prompt" ? "Starting…" : `Ask ${agent}`}
      </button>
    </form>
  {/if}

  {#if message !== ""}
    <p class="error">{message}</p>
  {/if}

  {#if list !== undefined && list.length > 0}
    <table>
      <thead>
        <tr>
          <th>Command</th>
          <th>Started</th>
          <th>State</th>
          <th><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each list.slice(0, LISTED) as run (run.id)}
          <tr>
            <td class="command">
              <a href={runPage(run.id)}><code>{run.command}</code></a>
            </td>
            <td class="muted">{formatTime(run.startedAt)}</td>
            <td><RunState {run} /></td>
            <td>
              <form
                method="POST"
                action={run.state === "running" ? "?/stopRun" : "?/rerun"}
                use:enhance={submit(`row:${run.id}`)}
              >
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="run" value={run.id} />
                <button type="submit" disabled={busy !== undefined}>
                  {#if busy === `row:${run.id}`}
                    {run.state === "running" ? "Stopping…" : "Starting…"}
                  {:else}
                    {run.state === "running" ? "Stop" : "Run again"}
                  {/if}
                </button>
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if list !== undefined}
    <p class="muted">No runs yet.</p>
  {/if}
{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .row label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .grow {
    flex: 1;
    min-width: 12rem;
  }

  /* Workspace paths are long; the start shows which one. */
  select {
    max-width: 14rem;
  }

  .mono,
  textarea {
    font-family: var(--mono);
  }

  .muted {
    color: var(--muted);
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.3rem 1rem 0.3rem 0;
    text-align: left;
    vertical-align: top;
  }

  th {
    color: var(--muted);
    font-weight: normal;
  }

  .command {
    overflow-wrap: anywhere;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
