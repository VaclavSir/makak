<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { formatTime } from "#lib/format.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>Makak Panel</title>
</svelte:head>

<h1>Makak Panel</h1>

<p class="hint">
  Pick a sandbox on the left to see how to connect to it, or
  <a href={resolve("/new")}>create a new one</a>.
</p>

{#if data.stateError !== undefined}
  <p class="error">{data.stateError}</p>
{:else if data.removed !== undefined && data.removed.length > 0}
  <h2>Removed sandboxes</h2>
  <p class="hint">
    Created by the Panel and since removed. Their env files and args are kept,
    so they can be created again.
  </p>
  <ul class="removed">
    {#each data.removed as sandbox (sandbox.id)}
      <li>
        <div>
          <strong>{sandbox.name}</strong>
          <span class="hint">created {formatTime(sandbox.createdAt)}</span>
          {#if sandbox.notes !== ""}
            <p class="notes">{sandbox.notes}</p>
          {/if}
        </div>
        <div class="buttons">
          <a
            class="button"
            href={`${resolve("/new")}?from=${encodeURIComponent(sandbox.id)}`}
            >Create again…</a
          >
          <form method="POST" action="?/forget" use:enhance>
            <input type="hidden" name="id" value={sandbox.id} />
            <button type="submit" title="Delete its env record and notes"
              >Forget</button
            >
          </form>
        </div>
      </li>
    {/each}
  </ul>
  {#if form?.message !== undefined}
    <p class="error">{form.message}</p>
  {/if}
{/if}

<h2>Host tools</h2>
<dl>
  <dt>sbx</dt>
  <dd>{data.sbx}</dd>
  <dt>git</dt>
  <dd>{data.git}</dd>
</dl>

<style>
  .hint {
    color: var(--muted);
  }

  .removed {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .removed li {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding: 0.6rem 0;
  }

  .notes {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
  }

  .buttons {
    display: flex;
    gap: 0.5rem;
  }

  .button {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.3rem 0.8rem;
    color: inherit;
    text-decoration: none;
  }

  .button:hover {
    border-color: var(--muted);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }
</style>
