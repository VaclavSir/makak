<script lang="ts">
  import { enhance } from "$app/forms";
  import PlanReview from "#lib/components/plan-review.svelte";
  import {
    argError,
    argSpecs,
    mergeEnv,
    nameError,
    SANDBOX_ARG,
  } from "#lib/env-files.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  // A draft: the form starts from what the page loaded with, and is the
  // user's from then on.
  // svelte-ignore state_referenced_locally
  let selected = $state<string[]>([...data.initial.files]);
  // svelte-ignore state_referenced_locally
  let name = $state(data.initial.name);
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>({ ...data.initial.args });
  let planning = $state(false);
  let showPlan = $state(true);

  const usable = $derived(
    data.files.filter(({ error }) => error === undefined)
  );
  // The args of the checked files, merged the way sbx merges them.
  const specs = $derived(
    argSpecs(
      mergeEnv(
        usable
          .filter((file) => selected.includes(file.name))
          .map(({ args }) => ({ args }))
      )
    )
  );
  const fields = $derived(
    Object.entries(specs).filter(([arg]) => arg !== SANDBOX_ARG)
  );
  const declaresSandbox = $derived(SANDBOX_ARG in specs);

  const valueOf = (arg: string) => values[arg] ?? specs[arg]?.default ?? "";

  // Shown as they are typed; a required field left empty only keeps the
  // button disabled.
  const problems = $derived(
    [
      ...(name === "" ? [] : [nameError(name)]),
      ...fields.map(([arg, spec]) =>
        valueOf(arg).trim() === ""
          ? undefined
          : argError(arg, spec, valueOf(arg).trim())
      ),
    ].filter((problem) => problem !== undefined)
  );
  const missing = $derived(
    name === "" ||
      fields.some(([arg, spec]) => spec.required && valueOf(arg).trim() === "")
  );

  const plan = $derived(
    showPlan && form !== null && "plan" in form ? form.plan : undefined
  );
</script>

<svelte:head>
  <title>New sandbox · Makak Panel</title>
</svelte:head>

<h1>New sandbox</h1>

{#if data.from !== undefined}
  <p class="hint">
    Starting from the env files and args of <strong>{data.from.name}</strong>.
  </p>
  {#if data.from.missing.length > 0}
    <p class="error">
      These files are no longer in the env directory, so they aren't checked: {data.from.missing.join(
        ", "
      )}
    </p>
  {/if}
{/if}

<form
  method="POST"
  action="?/plan"
  oninput={() => {
    showPlan = false;
  }}
  use:enhance={() => {
    planning = true;
    return async ({ update }) => {
      planning = false;
      showPlan = true;
      await update({ reset: false });
    };
  }}
>
  <h2>Env files</h2>
  {#if data.files.length === 0}
    <p class="hint">
      There are no <code>*.sbxenv.yaml</code> files in
      <code>{data.envDir}</code>. See <code>docs/env-files.md</code> for how to write
      them.
    </p>
  {:else}
    <p class="hint">
      From <code>{data.envDir}</code>, merged in this order.
    </p>
    <ul class="files">
      {#each data.files as file (file.name)}
        <li>
          <label>
            <input
              type="checkbox"
              name="file"
              value={file.name}
              disabled={file.error !== undefined}
              bind:group={selected}
            />
            <code>{file.name}</code>
          </label>
          {#if file.error !== undefined}
            <span class="file-error">{file.error}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <h2>Sandbox</h2>
  <label class="field">
    <span class="label">Name</span>
    <input
      name="name"
      required
      autocomplete="off"
      spellcheck="false"
      bind:value={name}
    />
    <span class="description">
      {declaresSandbox
        ? `Also passed as the ${SANDBOX_ARG} arg.`
        : "Passed to sbx as --name."}
    </span>
  </label>

  {#each fields as [arg, spec] (arg)}
    <label class="field">
      <span class="label"
        >{arg}{spec.required || spec.default !== undefined
          ? ""
          : " (optional)"}</span
      >
      {#if spec.enum === undefined}
        <input
          name={`arg:${arg}`}
          required={spec.required}
          autocomplete="off"
          spellcheck="false"
          value={valueOf(arg)}
          oninput={(event) => {
            values[arg] = event.currentTarget.value;
          }}
        />
      {:else}
        <select
          name={`arg:${arg}`}
          value={valueOf(arg)}
          onchange={(event) => {
            values[arg] = event.currentTarget.value;
          }}
        >
          {#if !spec.required && spec.default === undefined}
            <option value="">(unset)</option>
          {/if}
          {#each spec.enum as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      {/if}
      {#if spec.description !== undefined}
        <span class="description">{spec.description}</span>
      {/if}
    </label>
  {/each}

  {#if problems.length > 0}
    <ul class="problems">
      {#each problems as problem (problem)}
        <li>{problem}</li>
      {/each}
    </ul>
  {/if}

  <div class="actions">
    <button
      type="submit"
      class="primary"
      disabled={planning ||
        selected.length === 0 ||
        missing ||
        problems.length > 0}
    >
      {planning ? "Planning…" : "Show the plan"}
    </button>
  </div>
  {#if form !== null && "message" in form && showPlan}
    <p class="error">{form.message}</p>
  {/if}
</form>

{#if plan !== undefined}
  <PlanReview
    action="?/create"
    busyLabel="Creating… this can take a few minutes"
    fields={{
      hashes: JSON.stringify(plan.hashes),
      request: JSON.stringify(plan.request),
    }}
    oncancel={() => {
      showPlan = false;
    }}
    output={plan.output}
    submitLabel="Approve and create"
    warnings={plan.warnings}
  />
{/if}

<style>
  .hint,
  .description {
    color: var(--muted);
  }

  .files {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .files li {
    padding: 0.15rem 0;
  }

  .files label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .file-error {
    margin-left: 0.5rem;
    color: var(--error-text);
    font-size: 0.85rem;
  }

  .field {
    display: grid;
    gap: 0.2rem;
    max-width: 36rem;
    margin-bottom: 1rem;
  }

  .label {
    font-weight: 600;
  }

  .description {
    font-size: 0.85rem;
  }

  .problems {
    margin: 0 0 1rem;
    padding-left: 1.25rem;
    color: var(--error-text);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .error {
    margin-top: 0.75rem;
  }
</style>
