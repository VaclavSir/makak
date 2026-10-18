<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Makak Panel</title>
</svelte:head>

<h1>Makak Panel</h1>

<dl>
  <dt>sbx</dt>
  <dd>{data.sbx}</dd>
  <dt>git</dt>
  <dd>{data.git}</dd>
</dl>
