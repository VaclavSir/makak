<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import type { ToolRow } from "#lib/mcp.ts";

  // A server's tools, with whether each runs without asking, and Allow or
  // Ask to change that. Posts to the servers page, which it is opened on.

  let {
    listed,
    server,
    tools,
  }: {
    /** How many tools the last check listed, if it succeeded. */
    listed: number | undefined;
    server: string;
    tools: ToolRow[];
  } = $props();

  let dialog: HTMLDialogElement;
  let message = $state("");

  export const show = () => {
    message = "";
    dialog.showModal();
  };

  // Failures show here: the page's own message is behind the dialog.
  const submit: SubmitFunction =
    () =>
    async ({ result, update }) => {
      if (result.type === "failure") {
        message = String(result.data?.message ?? "It didn't work.");
        return;
      }
      message = "";
      await update();
    };
</script>

<dialog bind:this={dialog} aria-labelledby={`tools-${server}`} closedby="any">
  <div class="top">
    <h2 id={`tools-${server}`}>{server} tools</h2>
    <button
      type="button"
      onclick={() => {
        dialog.close();
      }}>Close</button
    >
  </div>
  {#if message !== ""}
    <p class="error" role="alert">{message}</p>
  {/if}
  {#if tools.length === 0}
    <p class="hint">
      {listed === 0
        ? "The server lists no tools."
        : "None known: a successful check lists them. Until a tool is allowed, every call to it asks."}
    </p>
  {:else}
    <ul>
      {#each tools as tool (tool.name)}
        <li>
          <div class="name">
            <code>{tool.name}</code>
            {#if tool.readOnly}
              <span
                class="badge"
                title="The server says this tool changes nothing. That's its claim, not a guarantee."
                >read-only</span
              >
            {/if}
            {#if !tool.listed}
              <span class="hint">not listed by the server</span>
            {/if}
          </div>
          <div class="allowed">
            {#if tool.allowed === "config"}
              <span class="yes">Allowed by the config</span>
            {:else if tool.allowed === "always"}
              <form method="POST" action="?/disallow" use:enhance={submit}>
                <input type="hidden" name="server" value={server} />
                <input type="hidden" name="tool" value={tool.name} />
                <span class="yes">Allowed</span>
                <button type="submit" title="Ask about every call again"
                  >Ask</button
                >
              </form>
            {:else}
              <form method="POST" action="?/allow" use:enhance={submit}>
                <input type="hidden" name="server" value={server} />
                <input type="hidden" name="tool" value={tool.name} />
                <span class="hint">Asks</span>
                <button
                  type="submit"
                  title="Let every sandbox's calls to it through without asking"
                  >Allow</button
                >
              </form>
            {/if}
          </div>
          {#if tool.description !== undefined}
            <p class="hint description" title={tool.description}>
              {tool.description}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
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

  .hint {
    color: var(--muted);
  }

  .error {
    border-radius: 6px;
    background: var(--error-bg);
    padding: 0.5rem 0.75rem;
    color: var(--error-text);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 1rem;
    border-top: 1px solid var(--border);
    padding: 0.35rem 0;
  }

  .allowed {
    white-space: nowrap;
  }

  form {
    display: inline;
  }

  form button {
    margin-left: 0.4rem;
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
  }

  .yes {
    color: var(--accent);
  }

  .badge {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 0.3rem;
    color: var(--muted);
    font-size: 0.75rem;
  }

  /* Some servers write a page per tool: two lines here, all of it on hover. */
  .description {
    display: -webkit-box;
    grid-column: 1 / -1;
    margin: 0.15rem 0 0;
    overflow: hidden;
    font-size: 0.85rem;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>
