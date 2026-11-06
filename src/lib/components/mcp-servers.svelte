<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import type { McpChoice } from "#lib/mcp.ts";

  let {
    choices,
    error,
    id,
    loaded,
    running,
  }: {
    choices: McpChoice[];
    /** Why sbx couldn't say which servers can be loaded. */
    error: string | undefined;
    id: string;
    /** The servers the Panel loaded into the sandbox. */
    loaded: string[];
    running: boolean;
  } = $props();

  // What is running: the action and its server, e.g. "load:gitlab".
  let busy = $state<string | undefined>();
  let message = $state("");
  let failed = $state(false);

  // Loaded servers come first; one no longer configured is listed too.
  const rows = $derived([
    ...choices.map((choice) => ({
      ...choice,
      loaded: loaded.includes(choice.name),
    })),
    ...loaded
      .filter((name) => !choices.some((choice) => choice.name === name))
      .map((name) => ({
        loaded: true,
        name,
        problem: "No longer in the config." as string | undefined,
      })),
  ]);

  const submit =
    (what: string): SubmitFunction =>
    () => {
      busy = what;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          failed = true;
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        failed = false;
        if (result.type === "success") {
          message = String(result.data?.mcp ?? "");
        }
        await update({ reset: false });
      };
    };
</script>

<p class="muted">
  Through the Panel's <a href="/mcp-panel/servers">MCP servers</a>.
  {running
    ? "A server loaded stays loaded when the sandbox restarts."
    : "Start the sandbox to load or unload servers."}
</p>
{#if error !== undefined}
  <p class="error">{error}</p>
{/if}
<ul class="plain">
  {#each rows as row (row.name)}
    <li>
      <code>{row.name}</code>
      {#if row.loaded}
        <span>loaded</span>
        <form
          method="POST"
          action="?/unloadMcp"
          use:enhance={submit(`unload:${row.name}`)}
        >
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="server" value={row.name} />
          <button
            type="submit"
            disabled={!running || busy !== undefined}
            title="The agent loses its tools"
            >{busy === `unload:${row.name}` ? "Unloading…" : "Unload"}</button
          >
        </form>
      {:else}
        <span class="muted">not loaded</span>
        <form
          method="POST"
          action="?/loadMcp"
          use:enhance={submit(`load:${row.name}`)}
        >
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="server" value={row.name} />
          <button
            type="submit"
            disabled={!running ||
              busy !== undefined ||
              row.problem !== undefined}
            >{busy === `load:${row.name}` ? "Loading…" : "Load"}</button
          >
        </form>
      {/if}
      {#if row.problem !== undefined}
        <span class="warning">{row.problem}</span>
      {/if}
    </li>
  {/each}
</ul>

{#if message !== ""}
  <p class={failed ? "error" : "muted"} aria-live="polite">{message}</p>
{/if}

<style>
  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--error-text);
  }

  .warning {
    color: var(--warning-text);
    font-size: 0.85rem;
  }

  .plain {
    display: grid;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
  }

  form {
    display: inline;
  }

  button {
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
  }
</style>
