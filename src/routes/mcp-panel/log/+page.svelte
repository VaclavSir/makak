<script lang="ts">
  import { resolve } from "$app/paths";
  import McpArguments from "#lib/components/mcp-arguments.svelte";
  import { formatTime } from "#lib/format.ts";
  import { argumentsSummary, OUTCOME_LABELS } from "#lib/mcp.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const base = resolve("/mcp-panel/log");
  const filters = $derived([
    { href: base, label: "All servers", server: undefined },
    ...data.servers.map((server) => ({
      href: `${base}?server=${encodeURIComponent(server)}`,
      label: server,
      server,
    })),
  ]);
</script>

<svelte:head>
  <title>MCP log · Makak Panel</title>
</svelte:head>

<h1>MCP log</h1>

{#if data.error !== ""}
  <p class="error">{data.error}</p>
{/if}

{#if data.servers.length > 1}
  <nav class="filters" aria-label="Server">
    {#each filters as filter (filter.href)}
      <a
        href={filter.href}
        aria-current={filter.server === data.server ? "page" : undefined}
        >{filter.label}</a
      >
    {/each}
  </nav>
{/if}

{#if data.entries.length === 0}
  <p class="hint">
    No tool calls{data.server === undefined ? "" : ` to ${data.server}`} yet.
  </p>
{:else}
  <table>
    <thead>
      <tr>
        <th>When</th>
        <th>Call</th>
        <th>Outcome</th>
      </tr>
    </thead>
    <tbody>
      {#each data.entries as entry, index (index)}
        <tr>
          <td class="hint when">{formatTime(entry.at)}</td>
          <td class="call">
            <details>
              <summary
                ><code>{entry.server} · {entry.tool}</code>
                <span class="hint">{argumentsSummary(entry.arguments)}</span
                ></summary
              >
              <McpArguments args={entry.arguments} />
            </details>
          </td>
          <td class={["outcome", entry.outcome]}>
            {OUTCOME_LABELS[entry.outcome]}{entry.earlier ? " earlier" : ""}
            {#if entry.request !== undefined}
              <span class="hint">· {entry.request}</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.entries.length === data.limit}
    <p class="hint">
      The latest {data.limit} calls. The rest are in
      <code>mcp-audit.jsonl</code> in the Panel's state directory.
    </p>
  {/if}
{/if}

<style>
  .hint {
    color: var(--muted);
  }

  .error {
    border-radius: 6px;
    background: var(--error-bg);
    padding: 0.5rem 0.75rem;
    color: var(--error-text);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 1rem 0;
  }

  .filters a {
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    color: var(--text);
    text-decoration: none;
  }

  .filters a:hover,
  .filters a[aria-current="page"] {
    background: var(--selected);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1rem;
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

  td code {
    overflow-wrap: anywhere;
  }

  .when {
    min-width: 7rem;
  }

  .call {
    width: 100%;
  }

  summary {
    cursor: pointer;
  }

  details[open] summary {
    margin-bottom: 0.4rem;
  }

  .call .hint {
    overflow-wrap: anywhere;
  }

  .outcome {
    white-space: nowrap;
  }

  .outcome.denied {
    color: var(--error-text);
  }

  .outcome.held,
  .outcome.gone {
    color: var(--warning-text);
  }
</style>
