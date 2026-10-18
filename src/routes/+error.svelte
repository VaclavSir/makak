<script lang="ts">
  import { page } from "$app/state";

  const TITLES: Record<number, string> = {
    404: "Not found",
    503: "Unavailable",
  };
</script>

<svelte:head>
  <title>{page.status} · Makak Panel</title>
</svelte:head>

<h1>{TITLES[page.status] ?? "Something went wrong"}</h1>
<p>{page.error?.message}</p>
