<script lang="ts">
  import { argumentFields } from "#lib/mcp.ts";

  // A tool call's arguments, each on its own, with text as written.

  let { args }: { args: unknown } = $props();

  const fields = $derived(argumentFields(args));
</script>

{#if fields.length === 0}
  <p class="none">No arguments.</p>
{:else}
  <dl>
    {#each fields as field, index (index)}
      {#if field.name !== ""}
        <dt>{field.name}</dt>
      {/if}
      <dd><pre class={{ json: field.json }}>{field.text}</pre></dd>
    {/each}
  </dl>
{/if}

<style>
  dl {
    display: grid;
    grid-template-columns: minmax(6rem, max-content) 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.85rem;
  }

  dd {
    grid-column: 2;
    margin: 0;
    min-width: 0;
  }

  /* Text is shown as the agent wrote it, line breaks and all. */
  pre {
    margin: 0;
    max-height: 24rem;
    overflow: auto;
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  pre.json {
    font-family: var(--mono);
    font-size: 0.85rem;
  }

  .none {
    margin: 0;
    color: var(--muted);
  }
</style>
