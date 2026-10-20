<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import { explain, summarize } from "#lib/git-compare.ts";
  import type { Comparison, GitStatus } from "#server/sandbox-git.ts";

  let { git, id }: { git: GitStatus; id: string } = $props();

  // What is running: the action and its branch, e.g. "push:main".
  let busy = $state<string | undefined>();
  let message = $state("");
  let failed = $state(false);
  // The branch whose force push is waiting for confirmation.
  let forcing = $state<string | undefined>();

  const short = (sha: string) => sha.slice(0, 7);

  /** Whether moving the other branch to the sandbox's is a fast-forward. */
  const canAdvance = (comparison: Comparison | undefined) =>
    comparison === undefined ||
    (comparison.ahead > 0 && comparison.behind === 0);

  const submit =
    (what: string): SubmitFunction =>
    () => {
      busy = what;
      message = "";
      return async ({ result, update }) => {
        busy = undefined;
        if (result.type === "failure") {
          failed = true;
          message = String(result.data?.message ?? "It didn't work.");
          return;
        }
        failed = false;
        forcing = undefined;
        if (result.type === "success") {
          message = String(result.data?.git ?? "");
        }
        await update({ reset: false });
      };
    };
</script>

<div class="summary">
  <span class="muted">Synced every minute while it runs.</span>
  <form method="POST" action="?/refresh" use:enhance={submit("refresh")}>
    <input type="hidden" name="id" value={id} />
    <button type="submit" disabled={busy !== undefined}>
      {busy === "refresh" ? "Refreshing…" : "Refresh"}
    </button>
  </form>
</div>

{#if git.error !== undefined}
  <p class="error">Can't read the repository: {git.error}</p>
{/if}

{#if git.branches.length === 0}
  <p class="muted">sbx hasn't copied any of its branches yet.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Branch</th>
        <th>Sandbox</th>
        <th>Host</th>
        <th>Origin</th>
        <th><span class="visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each git.branches as branch (branch.name)}
        <tr>
          <td>
            <code>{branch.name}</code>
            {#if branch.current}<span class="muted">(checked out)</span>{/if}
          </td>
          <td><code>{short(branch.sha)}</code></td>
          <td>
            <span
              class="explained"
              title={explain(branch.name, "the host", branch.host)}
              >{summarize(branch.host)}</span
            >
          </td>
          <td>
            {#if git.hasOrigin}
              <span
                class="explained"
                title={explain(branch.name, "origin", branch.origin)}
                >{summarize(branch.origin)}</span
              >
            {:else}
              no origin
            {/if}
          </td>
          <td class="row-actions">
            <div>
              {#if canAdvance(branch.host)}
                <form
                  method="POST"
                  action="?/bringToHost"
                  use:enhance={submit(`host:${branch.name}`)}
                >
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="branch" value={branch.name} />
                  <input type="hidden" name="sha" value={branch.sha} />
                  <button type="submit" disabled={busy !== undefined}>
                    {busy === `host:${branch.name}` ? "Bringing…" : "To host"}
                  </button>
                </form>
              {/if}
              {#if git.hasOrigin && canAdvance(branch.origin)}
                <form
                  method="POST"
                  action="?/push"
                  use:enhance={submit(`push:${branch.name}`)}
                >
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="branch" value={branch.name} />
                  <input type="hidden" name="sha" value={branch.sha} />
                  <button type="submit" disabled={busy !== undefined}>
                    {busy === `push:${branch.name}` ? "Pushing…" : "Push"}
                  </button>
                </form>
              {:else if branch.origin !== undefined && branch.origin.behind > 0}
                <button
                  type="button"
                  disabled={busy !== undefined || forcing !== undefined}
                  onclick={() => {
                    forcing = branch.name;
                  }}>Force push…</button
                >
              {/if}
            </div>
          </td>
        </tr>
        {#if forcing === branch.name && branch.origin !== undefined}
          <tr>
            <td colspan="5" class="confirm">
              <p>
                Replace origin's <code>{branch.name}</code> at
                <code>{short(branch.origin.sha)}</code> with the sandbox's
                <code>{short(branch.sha)}</code>? Origin's
                {branch.origin.behind}
                {branch.origin.behind === 1 ? "commit" : "commits"} the sandbox doesn't
                have will no longer be on that branch. The push fails if origin's
                branch moved since it was last fetched.
              </p>
              <form
                method="POST"
                action="?/push"
                use:enhance={submit(`force:${branch.name}`)}
              >
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="branch" value={branch.name} />
                <input type="hidden" name="sha" value={branch.sha} />
                <input type="hidden" name="lease" value={branch.origin.sha} />
                <button
                  type="submit"
                  class="danger"
                  disabled={busy !== undefined}
                >
                  {busy === `force:${branch.name}`
                    ? "Pushing…"
                    : "Force push with lease"}
                </button>
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onclick={() => {
                    forcing = undefined;
                  }}>Cancel</button
                >
              </form>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
{/if}

{#if message !== ""}
  <p class={failed ? "error" : "muted"} aria-live="polite">{message}</p>
{/if}

<style>
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
  }

  .explained {
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
    cursor: help;
  }

  .muted {
    color: var(--muted);
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.3rem 1.5rem 0.3rem 0;
    text-align: left;
    vertical-align: top;
  }

  th {
    color: var(--muted);
    font-weight: normal;
  }

  .row-actions {
    padding-right: 0;
  }

  .row-actions div,
  .confirm form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .confirm p {
    margin: 0.25rem 0 0.5rem;
    max-width: 40rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
