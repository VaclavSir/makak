<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { publishCommand, sandboxCommands } from "#lib/commands.ts";
  import CopyField from "#lib/components/copy-field.svelte";
  import NotesForm from "#lib/components/notes-form.svelte";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { SANDBOX_PAGE } from "#lib/dependencies.ts";
  import { formatTime } from "#lib/format.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // Live from the sidebar's polled list. When sbx can't be reached, fall back
  // to what the page loaded with.
  const current = $derived(
    data.sandboxes === undefined
      ? data.sandbox
      : data.sandboxes.find(({ name }) => name === data.sandbox.name)
  );
  // The name now belongs to a different sandbox than the page loaded.
  const replaced = $derived(
    current !== undefined && current.id !== data.sandbox.id
  );
  const sandbox = $derived(replaced ? undefined : current);
  const commands = $derived(sandboxCommands(data.sandbox.name, data.sshSuffix));
</script>

<svelte:head>
  <title>{data.sandbox.name} · Makak Panel</title>
</svelte:head>

<header>
  <h1>{data.sandbox.name}</h1>
  {#if sandbox !== undefined}
    <span class="status"
      ><StatusDot status={sandbox.status} />{sandbox.status}</span
    >
  {/if}
  <span
    class="badge"
    title="Not created by the Panel, so the Panel doesn't know how it was configured."
    >unmanaged</span
  >
</header>

{#if replaced}
  <div class="error">
    <p>
      This sandbox was removed, and a new one now has the same name. The notes
      below belong to the old one.
    </p>
    <button type="button" onclick={() => invalidate(SANDBOX_PAGE)}>
      Show the new sandbox
    </button>
  </div>
{:else if sandbox === undefined}
  <p class="error">This sandbox no longer exists.</p>
{:else}
  <dl>
    <dt>Agent</dt>
    <dd>{sandbox.agent ?? "unknown"}</dd>
    <dt>Created</dt>
    <dd>{formatTime(sandbox.createdAt) ?? "unknown"}</dd>
    <dt>Last used</dt>
    <dd>{formatTime(sandbox.lastUsedAt) ?? "unknown"}</dd>
    <dt>Id</dt>
    <dd><code>{sandbox.id}</code></dd>
  </dl>

  <h2>Workspaces</h2>
  {#if sandbox.workspaces.length === 0}
    <p class="muted">None.</p>
  {:else}
    <ul class="plain">
      {#each sandbox.workspaces as workspace (workspace)}
        <li><code>{workspace}</code></li>
      {/each}
    </ul>
  {/if}

  <h2>Published ports</h2>
  {#if sandbox.ports.length === 0}
    <p class="muted">
      None. Publish one with
      <code>{publishCommand(data.sandbox.name)}</code>.
    </p>
  {:else}
    <table>
      <thead>
        <tr><th>Sandbox</th><th>Host</th><th>Protocol</th></tr>
      </thead>
      <tbody>
        {#each sandbox.ports as port (`${port.hostIp}:${port.hostPort}/${port.protocol}`)}
          <tr>
            <td>{port.sandboxPort}</td>
            <td><code>{port.hostIp}:{port.hostPort}</code></td>
            <td>{port.protocol}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<h2>Connect</h2>
{#each commands as { label, value } (label)}
  <CopyField {label} {value} />
{/each}

<h2>Notes</h2>
{#key data.sandbox.id}
  <NotesForm
    initial={data.notes}
    maxLength={data.maxNotesLength}
    sandboxId={data.sandbox.id}
  />
{/key}

<style>
  .error p {
    margin: 0 0 0.5rem;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted);
  }

  .badge {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.6rem;
    color: var(--muted);
    font-size: 0.8rem;
  }

  dl {
    display: grid;
    grid-template-columns: 10rem 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }

  dt,
  .muted {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.3rem 1.5rem 0.3rem 0;
    text-align: left;
  }

  th {
    color: var(--muted);
    font-weight: normal;
  }
</style>
