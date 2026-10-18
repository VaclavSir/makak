<script lang="ts">
  import { enhance } from "$app/forms";

  let {
    initial,
    maxLength,
    sandboxId,
  }: { initial: string; maxLength: number; sandboxId: string } = $props();

  // A draft, deliberately not synced with `initial` after the first render:
  // the page remounts this form when it switches sandboxes.
  // svelte-ignore state_referenced_locally
  let notes = $state(initial);
  // svelte-ignore state_referenced_locally
  let saved = $state(initial);
  let status = $state<"idle" | "saving" | "error">("idle");
  let message = $state("");

  const dirty = $derived(notes !== saved);
</script>

<form
  method="POST"
  action="?/notes"
  use:enhance={() => {
    status = "saving";
    const submitted = notes;
    return async ({ result, update }) => {
      if (result.type === "success") {
        saved = submitted;
        status = "idle";
        // Keep the draft; don't reset the form or rerun the page's load.
        await update({ refreshAll: false, reset: false });
        return;
      }
      status = "error";
      message =
        result.type === "failure"
          ? String(result.data?.message ?? "Could not save the notes.")
          : "Could not save the notes.";
    };
  }}
>
  <input type="hidden" name="id" value={sandboxId} />
  <textarea
    name="notes"
    rows="6"
    maxlength={maxLength}
    placeholder="What is this sandbox for?"
    bind:value={notes}></textarea>
  <div class="actions">
    <button type="submit" disabled={!dirty || status === "saving"}>
      {status === "saving" ? "Saving…" : "Save notes"}
    </button>
    {#if status === "error"}
      <span class="error">{message}</span>
    {:else if dirty}
      <span class="hint">Unsaved changes</span>
    {/if}
  </div>
</form>

<style>
  textarea {
    display: block;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.6rem 0.75rem;
    resize: vertical;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .hint {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .error {
    padding: 0.2rem 0.5rem;
    font-size: 0.85rem;
  }
</style>
