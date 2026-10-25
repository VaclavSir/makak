<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let finish = $state<HTMLFormElement>();

  // Ends the sign-in at once; the button is there if scripts don't run.
  onMount(() => {
    if (form === null || form === undefined) {
      finish?.requestSubmit();
    }
  });
</script>

<svelte:head>
  <title>Signing in · Makak Panel</title>
</svelte:head>

<h1>Signing in</h1>

{#if data.error !== undefined}
  <p class="error">The server refused the sign-in: {data.error}</p>
{:else if form?.message !== undefined}
  <p class="error" role="alert">{form.message}</p>
{:else if data.server === undefined || data.code === undefined}
  <p class="error">
    This sign-in has expired or was already used. Start it again from the MCP
    approvals page.
  </p>
{:else}
  <form method="POST" action="?/finish" bind:this={finish} use:enhance>
    <input type="hidden" name="code" value={data.code} />
    <input type="hidden" name="state" value={data.state} />
    <p>Finishing the sign-in to <strong>{data.server}</strong>…</p>
    <button type="submit" class="primary">Finish signing in</button>
  </form>
{/if}

<p><a href={resolve("/approvals")}>Back to MCP approvals</a></p>

<style>
  .error {
    border-radius: 6px;
    background: var(--error-bg);
    padding: 0.5rem 0.75rem;
    color: var(--error-text);
  }
</style>
