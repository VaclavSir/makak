<script lang="ts">
  import "../app.css";

  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import favicon from "#lib/assets/favicon.svg";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { SANDBOXES } from "#lib/dependencies.ts";
  import type { LayoutProps } from "./$types";

  const REFRESH_MS = 5000;

  let { children, data }: LayoutProps = $props();

  const refresh = () => {
    if (document.visibilityState === "visible") {
      invalidate(SANDBOXES);
    }
  };

  // Polls while the tab is visible, and catches up as soon as it is shown.
  $effect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<div class="shell">
  <nav>
    <a class="home" href={resolve("/")}>Makak Panel</a>
    <h2>Sandboxes</h2>
    <a
      class="new"
      href={resolve("/new")}
      aria-current={page.route.id === "/new" ? "page" : undefined}
      >+ New sandbox</a
    >
    {#if data.sandboxes === undefined}
      <p class="error">{data.sbxError}</p>
    {:else if data.sandboxes.length === 0}
      <p class="empty">No sandboxes yet.</p>
    {:else}
      <ul>
        {#each data.sandboxes as sandbox (sandbox.id)}
          <li>
            <a
              href={resolve("/sandboxes/[name]", { name: sandbox.name })}
              aria-current={page.params.name === sandbox.name
                ? "page"
                : undefined}
            >
              <StatusDot status={sandbox.status} />
              <span class="name">{sandbox.name}</span>
              <span class="status">{sandbox.status}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </nav>

  <main>
    {@render children()}
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 16rem 1fr;
    min-height: 100vh;
  }

  nav {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--sidebar);
    padding: 1rem 0.75rem;
  }

  .home {
    display: block;
    padding: 0 0.5rem;
    color: var(--text);
    font-weight: 600;
    text-decoration: none;
  }

  nav h2 {
    margin: 1.5rem 0.5rem 0.5rem;
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .new {
    display: block;
    margin-bottom: 0.5rem;
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    color: var(--accent);
    text-decoration: none;
  }

  .new:hover,
  .new[aria-current="page"] {
    background: var(--selected);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    color: var(--text);
    text-decoration: none;
  }

  li a:hover {
    background: var(--selected);
  }

  li a[aria-current="page"] {
    background: var(--selected);
    font-weight: 600;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: normal;
  }

  .empty {
    padding: 0 0.5rem;
    color: var(--muted);
  }

  nav .error {
    margin: 0 0.25rem;
    font-size: 0.85rem;
  }

  main {
    min-width: 0;
    padding: 2rem 2.5rem;
  }

  @media (max-width: 40rem) {
    .shell {
      grid-template-columns: 1fr;
    }

    nav {
      position: static;
      height: auto;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }

    main {
      padding: 1.5rem 1rem;
    }
  }
</style>
