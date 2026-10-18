<script lang="ts">
  import CopyButton from "./copy-button.svelte";

  let { label, value }: { label: string; value: string } = $props();
</script>

<div class="field">
  <span class="label">{label}</span>
  <code>{value}</code>
  <CopyButton {label} {value} />
</div>

<style>
  .field {
    display: grid;
    grid-template-columns: 10rem 1fr auto;
    align-items: center;
    gap: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0;
  }

  .label {
    color: var(--muted);
  }

  code {
    overflow-wrap: anywhere;
  }

  @media (max-width: 40rem) {
    .field {
      grid-template-columns: 1fr auto;
    }

    .label {
      grid-column: 1 / -1;
    }
  }
</style>
