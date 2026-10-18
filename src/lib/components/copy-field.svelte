<script lang="ts">
  let { label, value }: { label: string; value: string } = $props();

  const FEEDBACK_MS = 1500;

  let feedback = $state<"Copied" | "Copy failed" | undefined>();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      feedback = "Copied";
    } catch {
      // Denied clipboard access. The value is still there to select by hand.
      feedback = "Copy failed";
    }
    setTimeout(() => {
      feedback = undefined;
    }, FEEDBACK_MS);
  };
</script>

<div class="field">
  <span class="label">{label}</span>
  <code>{value}</code>
  <button type="button" onclick={copy} aria-label="Copy {label}">
    {feedback ?? "Copy"}
  </button>
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

  button {
    min-width: 5rem;
    font-size: 0.85rem;
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
