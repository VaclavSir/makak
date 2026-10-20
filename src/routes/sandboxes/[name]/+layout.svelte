<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { page } from "$app/state";
  import RunTabs from "#lib/components/run-tabs.svelte";
  import SandboxActions from "#lib/components/sandbox-actions.svelte";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { SANDBOX_PAGE } from "#lib/dependencies.ts";
  import { liveSandbox } from "#lib/live-sandbox.ts";
  import type { LayoutProps } from "./$types";

  let { children, data }: LayoutProps = $props();

  // Live from the sidebar's polled list.
  const live = $derived(liveSandbox(data.sandbox, data.sandboxes));
  const sandbox = $derived(live.sandbox);
</script>

<header>
  <h1>{data.sandbox.name}</h1>
  {#if sandbox !== undefined}
    <span class="status"
      ><StatusDot status={sandbox.status} />{sandbox.status}</span
    >
  {/if}
  {#if data.env === undefined}
    <span
      class="badge"
      title="Not created by the Panel, so the Panel doesn't know how it was configured."
      >unmanaged</span
    >
  {:else}
    <span
      class="badge"
      title="Created by the Panel, which replays its env files and args."
      >managed</span
    >
  {/if}
</header>

{#if live.replaced}
  <div class="error">
    <p>
      This sandbox was removed, and a new one now has the same name. What is
      shown below belongs to the old one.
    </p>
    <button type="button" onclick={() => invalidate(SANDBOX_PAGE)}>
      Show the new sandbox
    </button>
  </div>
{:else if sandbox === undefined}
  <p class="error">This sandbox no longer exists.</p>
{:else}
  {#key data.sandbox.id}
    <SandboxActions
      envProblem={data.envProblem}
      id={data.sandbox.id}
      managed={data.env !== undefined}
      name={data.sandbox.name}
      removal={data.removal}
      status={sandbox.status}
    />
  {/key}

  {#if data.envProblem !== undefined}
    <p class="error">
      {data.envProblem}. Until they are back, the Panel starts it with
      <code>sbx run</code> and removes it with <code>sbx rm</code>.
    </p>
  {/if}
{/if}

{#key data.sandbox.id}
  <RunTabs
    current={page.params.run}
    id={data.sandbox.id}
    name={data.sandbox.name}
    running={sandbox?.status === "running"}
    runs={data.runs}
  >
    {@render children()}
  </RunTabs>
{/key}

<style>
  .error p {
    margin: 0 0 0.5rem;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted);
  }

  .badge {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.6rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
