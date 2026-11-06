<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { SANDBOX_PAGE } from "#lib/dependencies.ts";
  import { idle, submitting } from "#lib/submit.ts";
  import type { Work } from "#server/sandbox-git.ts";

  import PlanReview from "./plan-review.svelte";

  interface Removal {
    hashes: string[];
    hasNotes: boolean;
    hostCommands: string[];
    method: "env" | "rm";
    /** Undefined when it isn't in clone mode. */
    work: Work | undefined;
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

  const form = $state(idle<"planning" | "starting" | "stopping">());
  let plan = $state<Plan | undefined>();
  let removing = $state(false);
  const removeForm = $state(idle());

  const running = $derived(status === "running");
  // The overview's actions, also from a run's tab.
  const base = $derived(resolve("/sandboxes/[name]", { name }));

  /** Submits a form, keeping its outcome here rather than in the page. */
  const submit = (what: "planning" | "starting" | "stopping") =>
    submitting(form, what, async ({ result, update }) => {
      if (result.type === "success" && result.data?.plan !== undefined) {
        plan = result.data.plan as Plan;
        return;
      }
      // The actions belong to the overview; stay on the page they came from.
      await update({ navigate: false });
    });

  const remove = submitting(removeForm, true, async ({ update }) => {
    await update();
  });
</script>

<div class="actions">
  {#if running}
    <form
      method="POST"
      action={`${base}?/stop`}
      use:enhance={submit("stopping")}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={form.busy !== undefined}>
        {form.busy === "stopping" ? "Stopping…" : "Stop"}
      </button>
    </form>
  {:else if managed && envProblem === undefined}
    <form
      method="POST"
      action={`${base}?/planStart`}
      use:enhance={submit("planning")}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={form.busy !== undefined || plan !== undefined}
      >
        {form.busy === "planning" ? "Planning…" : "Start…"}
      </button>
    </form>
  {:else}
    <form
      method="POST"
      action={`${base}?/start`}
      use:enhance={submit("starting")}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={form.busy !== undefined}>
        {form.busy === "starting" ? "Starting…" : "Start"}
      </button>
    </form>
  {/if}
  {#if managed}
    <a class="button" href={`${resolve("/new")}?from=${encodeURIComponent(id)}`}
      >New from this…</a
    >
  {/if}
  <!-- Plain, away from the rest: the confirmation it opens is the warning. -->
  <button
    type="button"
    class="remove-button"
    disabled={removing}
    onclick={() => {
      removing = true;
      // What it would lose, as it is now, not as the page loaded.
      void invalidate(SANDBOX_PAGE, true);
    }}>Remove…</button
  >
</div>
{#if form.message !== ""}
  <p class="error">{form.message}</p>
{/if}

{#if plan !== undefined}
  <PlanReview
    action={`${base}?/start`}
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
    <p>Removing a sandbox can't be undone.</p>
    {#if removal.work !== undefined}
      {@const work = removal.work}
      {#if work.count > 0}
        <p class="warning">
          <strong
            >{work.count}
            {work.count === 1 ? "commit is" : "commits are"} on no host branch, tag
            or other remote.</strong
          >
          sbx keeps its copy of the sandbox's branches, in
          <code>refs/sandboxes/{name}/</code>, after removal, but nothing else
          has {work.count === 1 ? "it" : "them"}:
        </p>
        <ul class="commits">
          {#each work.commits as commit (commit.sha)}
            <li><code>{commit.sha.slice(0, 7)}</code> {commit.subject}</li>
          {/each}
          {#if work.count > work.commits.length}
            <li>and {work.count - work.commits.length} more</li>
          {/if}
        </ul>
      {:else if work.unknown === undefined}
        <p>Every commit it has is on a host branch, a tag or another remote.</p>
      {/if}
      {#if work.unknown !== undefined}
        <p class="warning">{work.unknown}</p>
      {/if}
      {#if status === "running"}
        <p>Its latest commits are copied to the host first.</p>
      {/if}
    {/if}
    <p>This is lost with it:</p>
    <ul>
      {#if removal.work === undefined}
        <li>
          <strong>Commits that exist only in the sandbox</strong>, if it has its
          own clone: the Panel found no repository with its branches.
        </li>
      {/if}
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
    <form method="POST" action={`${base}?/remove`} use:enhance={remove}>
      <input type="hidden" name="id" value={id} />
      <input
        type="hidden"
        name="hashes"
        value={JSON.stringify(removal.hashes)}
      />
      <div class="buttons">
        <button
          type="submit"
          class="danger"
          disabled={removeForm.busy !== undefined}
        >
          {removeForm.busy === undefined ? "Remove for good" : "Removing…"}
        </button>
        <button
          type="button"
          disabled={removeForm.busy !== undefined}
          onclick={() => {
            removing = false;
          }}>Cancel</button
        >
      </div>
      {#if removeForm.message !== ""}
        <p class="error">{removeForm.message}</p>
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

  .remove-button {
    margin-left: auto;
  }

  .remove-button:hover:enabled {
    border-color: var(--error-text);
    color: var(--error-text);
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

  .commits {
    list-style: none;
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
