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

<button type="button" onclick={copy} aria-label="Copy {label}">
  {feedback ?? "Copy"}
</button>

<style>
  button {
    min-width: 5rem;
    font-size: 0.85rem;
  }
</style>
