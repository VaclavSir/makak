<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";
  import RunState from "#lib/components/run-state.svelte";
  import { formatTime } from "#lib/format.ts";
  import type { Run } from "#server/tools/index.ts";

  // Every run in the sandbox, newest first. Opening one shows it in a tab;
  // running one again opens the new run in a tab of its own.

  let {
    id,
    list,
    name,
    onchanged,
  }: {
    id: string;
    list: Run[];
    name: string;
    /** Called after stopping a run, so the list is asked again. */
    onchanged: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let busy = $state<string | undefined>();
  let message = $state("");

  const base = $derived(resolve("/sandboxes/[name]", { name }));
  const runPage = (run: string) =>
    resolve("/sandboxes/[name]/runs/[run]", { name, run });

  export const show = () => {
    message = "";
    dialog.showModal();
  };

  const close = () => {
    dialog.close();
  };

  const submit =
    (run: Run): SubmitFunction =>
    () => {
      busy = run.id;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        if (result.type === "redirect") {
          close();
        }
        // Stay on the page this was opened on, unless it started a run.
        await update({ navigate: false, refreshAll: false });
        onchanged();
      };
    };
</script>

<dialog bind:this={dialog} aria-labelledby="history-title" closedby="any">
  <div class="top">
    <h2 id="history-title">Runs</h2>
    <button type="button" onclick={close}>Close</button>
  </div>
  {#if message !== ""}
    <p class="error">{message}</p>
  {/if}
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
      {#each list as run (run.id)}
        <tr>
          <td class="command">
            <a href={runPage(run.id)} onclick={close}
              ><code>{run.command}</code></a
            >
          </td>
          <td class="muted">{formatTime(run.startedAt)}</td>
          <td><RunState {run} /></td>
          <td>
            <form
              method="POST"
              action={`${base}?/${run.state === "running" ? "stopRun" : "rerun"}`}
              use:enhance={submit(run)}
            >
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="run" value={run.id} />
              <button type="submit" disabled={busy !== undefined}>
                {#if busy === run.id}
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
</dialog>

<style>
  dialog {
    width: min(56rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    padding: 0.75rem 1rem 1rem;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 40%);
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .top h2 {
    margin: 0;
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.25rem 1rem 0.25rem 0;
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--muted);
    font-weight: normal;
  }

  td:last-child {
    padding-right: 0;
    text-align: right;
  }

  td button {
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .command {
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--muted);
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
