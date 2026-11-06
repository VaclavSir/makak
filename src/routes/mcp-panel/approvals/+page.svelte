<script lang="ts">
  import McpQueue from "#lib/components/mcp-queue.svelte";
  import type { PageProps } from "./$types";

  // The queue as a page, for a new tab; the sidebar opens it over the page
  // that's open instead.

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>MCP approvals · Makak Panel</title>
</svelte:head>

<h1>MCP approvals</h1>

<McpQueue pending={data.pending} />
