<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Makak Panel</title>
</svelte:head>

<h1>Makak Panel</h1>

<p class="hint">Pick a sandbox on the left to see how to connect to it.</p>

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
