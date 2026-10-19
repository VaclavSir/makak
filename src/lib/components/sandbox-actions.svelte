<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";

  import PlanReview from "./plan-review.svelte";

  interface Removal {
    hashes: string[];
    hasNotes: boolean;
    hostCommands: string[];
    method: "env" | "rm";
  }

  interface Plan {
    hashes: string[];
    output: string;
    warnings: string[];
  }

  let {
    envProblem,
    id,
    managed,
    name,
    removal,
    status,
  }: {
    /** Why the recorded env files can't be used, if they can't. */
    envProblem: string | undefined;
    id: string;
    managed: boolean;
    name: string;
    removal: Removal;
    status: string;
  } = $props();

  let busy = $state<"planning" | "starting" | "stopping" | undefined>();
  let message = $state("");
  let plan = $state<Plan | undefined>();
  let removing = $state(false);
  let confirmation = $state("");
  let removeBusy = $state(false);
  let removeMessage = $state("");

  const running = $derived(status === "running");

  /** Submits a form, keeping its outcome here rather than in the page. */
  const submit =
    (what: NonNullable<typeof busy>): SubmitFunction =>
    () => {
      busy = what;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        if (result.type === "success" && result.data?.plan !== undefined) {
          plan = result.data.plan as Plan;
          return;
        }
        await update();
      };
    };
</script>

<div class="actions">
  {#if running}
    <form method="POST" action="?/stop" use:enhance={submit("stopping")}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={busy !== undefined}>
        {busy === "stopping" ? "Stopping…" : "Stop"}
      </button>
    </form>
  {:else if managed && envProblem === undefined}
    <form method="POST" action="?/planStart" use:enhance={submit("planning")}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={busy !== undefined || plan !== undefined}>
        {busy === "planning" ? "Planning…" : "Start…"}
      </button>
    </form>
  {:else}
    <form method="POST" action="?/start" use:enhance={submit("starting")}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={busy !== undefined}>
        {busy === "starting" ? "Starting…" : "Start"}
      </button>
    </form>
  {/if}
  {#if managed}
    <a class="button" href={`${resolve("/new")}?from=${encodeURIComponent(id)}`}
      >New from this…</a
    >
  {/if}
  <button
    type="button"
    class="danger"
    disabled={removing}
    onclick={() => {
      removing = true;
    }}>Remove…</button
  >
</div>
{#if message !== ""}
  <p class="error">{message}</p>
{/if}

{#if plan !== undefined}
  <PlanReview
    action="?/start"
    busyLabel="Starting…"
    fields={{ hashes: JSON.stringify(plan.hashes), id }}
    onapplied={() => {
      plan = undefined;
    }}
    oncancel={() => {
      plan = undefined;
    }}
    output={plan.output}
    submitLabel="Approve and start"
    warnings={plan.warnings}
  />
{/if}

{#if removing}
  <section class="remove">
    <h2>Remove {name}</h2>
    <p>Removing a sandbox can't be undone. This is lost with it:</p>
    <ul>
      <li>
        <strong>Commits that exist only in the sandbox.</strong> The Panel can't
        check for them yet, so assume there are some. To keep them, fetch them
        into your repository on the host first:
        <code>git fetch sandbox-{name}</code>.
      </li>
      <li>Uncommitted changes, and anything else inside the sandbox.</li>
      {#if !managed && removal.hasNotes}
        <li>Your notes on this sandbox.</li>
      {/if}
    </ul>
    {#if managed && removal.method === "env"}
      <p>
        It is removed with <code>sbx env rm</code> and the env files it was created
        from. The Panel keeps its env files, args and notes, so you can create it
        again from the home page.
      </p>
      {#if removal.hostCommands.length > 0}
        <p>These host commands run first, on your machine:</p>
        <pre>{removal.hostCommands.join("\n")}</pre>
      {/if}
    {:else if managed}
      <p class="warning">
        {envProblem}. So it is removed with <code>sbx rm</code>, and no
        <code>preRemove</code> commands run.
      </p>
    {/if}
    <form
      method="POST"
      action="?/remove"
      use:enhance={() => {
        removeBusy = true;
        removeMessage = "";
        return async ({ result, update }) => {
          removeBusy = false;
          if (result.type === "failure") {
            removeMessage = String(result.data?.message ?? "It didn't work.");
            return;
          }
          await update();
        };
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input
        type="hidden"
        name="hashes"
        value={JSON.stringify(removal.hashes)}
      />
      <label>
        <span>Type <strong>{name}</strong> to confirm</span>
        <input
          name="confirmation"
          autocomplete="off"
          spellcheck="false"
          bind:value={confirmation}
        />
      </label>
      <div class="buttons">
        <button
          type="submit"
          class="danger"
          disabled={removeBusy || confirmation.trim() !== name}
        >
          {removeBusy ? "Removing…" : "Remove for good"}
        </button>
        <button
          type="button"
          disabled={removeBusy}
          onclick={() => {
            removing = false;
            confirmation = "";
          }}>Cancel</button
        >
      </div>
      {#if removeMessage !== ""}
        <p class="error">{removeMessage}</p>
      {/if}
    </form>
  </section>
{/if}

<style>
  .actions,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .button {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.3rem 0.8rem;
    color: inherit;
    text-decoration: none;
  }

  .button:hover {
    border-color: var(--muted);
  }

  .error {
    margin-top: 0.75rem;
  }

  .remove {
    margin-top: 1.5rem;
    border: 1px solid var(--error-text);
    border-radius: 8px;
    background: var(--surface);
    padding: 0 1rem 1rem;
  }

  .remove h2 {
    margin-top: 1rem;
  }

  .remove ul {
    padding-left: 1.25rem;
  }

  .remove label {
    display: grid;
    gap: 0.3rem;
    max-width: 24rem;
  }

  .buttons {
    margin-top: 0.75rem;
  }

  .warning {
    color: var(--warning-text);
  }

  pre {
    overflow-x: auto;
    border-radius: 6px;
    background: var(--bg);
    padding: 0.75rem;
    font-family: var(--mono);
    font-size: 0.85rem;
  }
</style>
