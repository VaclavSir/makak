<script lang="ts">
  import { page } from "$app/state";
  import McpQueue from "#lib/components/mcp-queue.svelte";
  import type { Approval } from "#server/mcp/approvals.ts";

  // The approval queue over whatever page is open, so deciding a call never
  // leaves it. Opened through shallow routing, in the history: Back, Esc or
  // Close shut it, and the page underneath stays as it was.

  let { pending }: { pending: Approval[] } = $props();

  let dialog: HTMLDialogElement;

  const open = $derived(page.state.approvals === true);

  $effect(() => {
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  /** Closed by Esc, a click outside or Close: the history entry goes too. */
  const closed = () => {
    if (page.state.approvals === true) {
      history.back();
    }
  };
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="approvals-title"
  closedby="any"
  onclose={closed}
>
  <div class="top">
    <h2 id="approvals-title">Waiting for you</h2>
    <button
      type="button"
      onclick={() => {
        dialog.close();
      }}>Close</button
    >
  </div>
  <McpQueue {pending} />
</dialog>

<style>
  /* Near the top, so it doesn't move as calls come and go. */
  dialog {
    width: min(56rem, calc(100vw - 2rem));
    max-height: calc(100vh - 6rem);
    margin: 4rem auto auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    padding: 0.75rem 1rem 1rem;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 40%);
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .top h2 {
    margin: 0;
  }
</style>
