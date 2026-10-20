<script lang="ts">
  import { enhance } from "$app/forms";

  let {
    action,
    busyLabel,
    fields,
    onapplied,
    oncancel,
    output,
    submitLabel,
    warnings,
  }: {
    action: string;
    busyLabel: string;
    /** Hidden fields the approval submits. */
    fields: Record<string, string>;
    /** Called once the change is applied, before the page updates. */
    onapplied?: () => void;
    oncancel: () => void;
    output: string;
    submitLabel: string;
    warnings: string[];
  } = $props();

  let busy = $state(false);
  let message = $state("");
</script>

<section class="plan">
  <h2>Plan</h2>
  <p class="hint">
    What <code>sbx env</code> will change outside the sandbox. Approving applies exactly
    these env files and args.
  </p>
  <pre>{output || "(sbx printed no plan)"}</pre>

  {#if warnings.length > 0}
    <h3>Workflow warnings</h3>
    <ul class="warnings">
      {#each warnings as warning (warning)}
        <li>{warning}</li>
      {/each}
    </ul>
  {/if}

  <form
    method="POST"
    {action}
    use:enhance={() => {
      busy = true;
      message = "";
      return async ({ result, update }) => {
        busy = false;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        onapplied?.();
        // Its action may belong to another page; stay on this one.
        await update({ navigate: false });
      };
    }}
  >
    {#each Object.entries(fields) as [name, value] (name)}
      <input type="hidden" {name} {value} />
    {/each}
    <div class="actions">
      <button type="submit" class="primary" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
      <button type="button" disabled={busy} onclick={oncancel}>Cancel</button>
    </div>
    {#if message !== ""}
      <p class="error">{message}</p>
    {/if}
  </form>
</section>

<style>
  .plan {
    margin-top: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 0 1rem 1rem;
  }

  h2 {
    margin-top: 1rem;
  }

  h3 {
    margin: 1rem 0 0.5rem;
    font-size: 0.95rem;
  }

  .hint {
    color: var(--muted);
  }

  pre {
    overflow-x: auto;
    border-radius: 6px;
    background: var(--bg);
    padding: 0.75rem;
    font-family: var(--mono);
    font-size: 0.85rem;
  }

  .warnings {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--warning-text);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .error {
    margin-top: 0.75rem;
  }
</style>
