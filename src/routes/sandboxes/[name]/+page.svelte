<script lang="ts">
  import { sandboxCommands, publishCommand } from "#lib/commands.ts";
  import CopyField from "#lib/components/copy-field.svelte";
  import GitStatus from "#lib/components/git-status.svelte";
  import McpServers from "#lib/components/mcp-servers.svelte";
  import NotesForm from "#lib/components/notes-form.svelte";
  import ProxyAddresses from "#lib/components/proxy-addresses.svelte";
  import RunsPanel from "#lib/components/runs-panel.svelte";
  import { formatTime } from "#lib/format.ts";
  import { liveSandbox } from "#lib/live-sandbox.ts";
  import { getRunsContext } from "#lib/runs-context.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const runs = getRunsContext();
  const sandbox = $derived(liveSandbox(data.sandbox, data.sandboxes).sandbox);
  const commands = $derived(
    sandboxCommands(data.sandbox.name, data.sshSuffix, data.sandbox.workspaces)
  );
</script>

<svelte:head>
  <title>{data.sandbox.name} · Makak Panel</title>
</svelte:head>

<div class="columns">
  <div class="column">
    {#key data.sandbox.id}
      <NotesForm
        initial={data.notes}
        maxLength={data.maxNotesLength}
        sandboxId={data.sandbox.id}
      />
    {/key}

    {#if sandbox !== undefined}
      <h2>Runs</h2>
      {#if runs.failed}
        <p class="error">Can't list the runs. Reload the page to try again.</p>
      {:else if runs.view === undefined}
        <p class="muted">Asking the sandbox…</p>
      {:else}
        {#key data.sandbox.id}
          <RunsPanel
            agent={sandbox.agent}
            id={data.sandbox.id}
            runs={runs.view}
            running={sandbox.status === "running"}
            workspaces={sandbox.workspaces}
          />
        {/key}
      {/if}

      {#if data.git !== undefined}
        <h2>Git</h2>
        {#key data.sandbox.id}
          <GitStatus git={data.git} id={data.sandbox.id} />
        {/key}
      {/if}
    {/if}
  </div>

  <div class="column">
    {#if sandbox !== undefined}
      <h2>Addresses</h2>
      <ProxyAddresses
        name={sandbox.name}
        ports={sandbox.ports}
        running={sandbox.status === "running"}
        settings={data.proxy}
      />
    {/if}

    <h2>Connect</h2>
    {#each commands as { label, value } (label)}
      <CopyField {label} {value} />
    {/each}

    {#if sandbox !== undefined && (data.mcpChoices.choices.length > 0 || data.mcp.length > 0)}
      <h2>MCP servers</h2>
      {#key data.sandbox.id}
        <McpServers
          choices={data.mcpChoices.choices}
          error={data.mcpChoices.error}
          id={data.sandbox.id}
          loaded={data.mcp}
          running={sandbox.status === "running"}
        />
      {/key}
    {/if}

    {#if sandbox !== undefined}
      {#if data.warnings.length > 0}
        <h2>Workflow warnings</h2>
        <ul class="warnings">
          {#each data.warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      {/if}

      <details>
        <summary>Details, env and ports</summary>
        <dl>
          <dt>Agent</dt>
          <dd>{sandbox.agent ?? "unknown"}</dd>
          <dt>Created</dt>
          <dd>{formatTime(sandbox.createdAt) ?? "unknown"}</dd>
          <dt>Last used</dt>
          <dd>{formatTime(sandbox.lastUsedAt) ?? "unknown"}</dd>
          <dt>Id</dt>
          <dd><code>{sandbox.id}</code></dd>
          <dt>Workspaces</dt>
          <dd>
            {#if sandbox.workspaces.length === 0}
              <span class="muted">None.</span>
            {:else}
              <ul class="plain">
                {#each sandbox.workspaces as workspace (workspace)}
                  <li><code>{workspace}</code></li>
                {/each}
              </ul>
            {/if}
          </dd>
        </dl>

        {#if data.env !== undefined}
          <h3>Env</h3>
          <p class="muted">
            Replayed for every <code>sbx env</code> command, in this order.
          </p>
          <ul class="plain">
            {#each data.env.files as file (file)}
              <li><code>{file}</code></li>
            {/each}
          </ul>
          {#if Object.keys(data.env.args).length > 0}
            <table>
              <thead><tr><th>Arg</th><th>Value</th></tr></thead>
              <tbody>
                {#each Object.entries(data.env.args) as [arg, value] (arg)}
                  <tr><td>{arg}</td><td><code>{value}</code></td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {/if}

        <h3>Published ports</h3>
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
      </details>
    {/if}
  </div>
</div>

<style>
  /* What you act on, then what you look up: side by side when there is room. */
  @media (min-width: 72rem) {
    .columns {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      align-items: start;
      gap: 0 2.5rem;
    }
  }

  details {
    margin-top: 1.25rem;
  }

  summary {
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
  }

  details > dl {
    margin-top: 0.5rem;
  }

  h3 {
    margin: 1rem 0 0.4rem;
    font-size: 0.9rem;
  }

  dl {
    display: grid;
    grid-template-columns: 7rem 1fr;
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

  .warnings {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--warning-text);
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
