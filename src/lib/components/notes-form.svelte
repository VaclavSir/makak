<script lang="ts">
  import { deserialize } from "$app/forms";
  import { beforeNavigate } from "$app/navigation";
  import { onDestroy, onMount } from "svelte";
  import { createAutosave } from "#lib/autosave.ts";
  import type { AutosaveStatus } from "#lib/autosave.ts";

  let {
    initial,
    maxLength,
    sandboxId,
  }: { initial: string; maxLength: number; sandboxId: string } = $props();

  const SAVE_DELAY = 1000;
  const SAVE_FAILED = "Could not save the notes.";

  // Fixed at mount: a save still running after a navigation must reach the
  // sandbox the notes were typed for. The page remounts this form when it
  // switches sandboxes.
  let form: HTMLFormElement;
  let action = "";
  // svelte-ignore state_referenced_locally
  const id = sandboxId;
  onMount(() => {
    // The resolved URL of the form's own action.
    ({ action } = form);
  });

  // A draft, deliberately not synced with `initial` after the first render.
  // svelte-ignore state_referenced_locally
  let notes = $state(initial);
  let status = $state<AutosaveStatus>("idle");
  let message = $state("");

  const save = async (value: string) => {
    const body = new FormData();
    body.set("id", id);
    body.set("notes", value);
    // keepalive lets a save started as the page closes finish.
    const response = await fetch(action, {
      body,
      headers: { "x-sveltekit-action": "true" },
      keepalive: true,
      method: "POST",
    });
    let result: ReturnType<typeof deserialize>;
    try {
      result = deserialize(await response.text());
    } catch {
      // Not an action result, such as a proxy's error page.
      throw new Error(SAVE_FAILED);
    }
    if (result.type === "failure") {
      throw new Error(String(result.data?.message ?? SAVE_FAILED));
    }
    if (result.type !== "success") {
      throw new Error(SAVE_FAILED);
    }
  };

  // svelte-ignore state_referenced_locally
  const autosave = createAutosave({
    delay: SAVE_DELAY,
    initial,
    onstatus: (next, text) => {
      status = next;
      message = text ?? "";
    },
    save,
  });

  beforeNavigate(({ cancel, type }) => {
    const failed = status === "error";
    void autosave.flush();
    if (type === "leave") {
      // Closing the page: a save still running can't send a newer value after
      // it, and a failure would go unseen. The browser asks.
      if (failed || autosave.unsent()) {
        cancel();
      }
      return;
    }
    // Within the Panel the save goes on, but its failure would go unseen.
    // oxlint-disable-next-line no-alert -- a blocking choice, before leaving
    if (failed && !confirm("Your notes weren't saved. Leave anyway?")) {
      cancel();
    }
  });

  onDestroy(() => {
    void autosave.flush();
  });
</script>

<svelte:window onpagehide={() => autosave.flush()} />

<form method="POST" action="?/notes" bind:this={form}>
  <!-- The status sits by the heading, so it never moves what is below. -->
  <div class="heading">
    <h2>Notes</h2>
    <span class="status" aria-live="polite">
      {#if status === "saving"}
        Saving…
      {:else if status === "pending"}
        Unsaved changes
      {:else if status === "saved"}
        Saved
      {/if}
    </span>
  </div>
  <input type="hidden" name="id" value={sandboxId} />
  <textarea
    name="notes"
    aria-label="Notes"
    rows="3"
    maxlength={maxLength}
    placeholder="What is this sandbox for?"
    bind:value={notes}
    oninput={() => {
      autosave.change(notes);
    }}
    onblur={() => autosave.flush()}></textarea>
  {#if status === "error"}
    <p class="error" role="alert">{message}</p>
  {/if}
  <noscript><button type="submit">Save notes</button></noscript>
</form>

<style>
  textarea {
    display: block;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.4rem 0.6rem;
    resize: vertical;
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .status {
    color: var(--muted);
    font-size: 0.8rem;
  }

  .error {
    margin: 0.4rem 0 0;
  }
</style>
