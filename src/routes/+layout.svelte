<script lang="ts">
  import "../app.css";

  import { afterNavigate, goto, invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import favicon from "#lib/assets/favicon.svg";
  import ApprovalBell from "#lib/components/approval-bell.svelte";
  import ApprovalsDialog from "#lib/components/approvals-dialog.svelte";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { MCP, SANDBOXES } from "#lib/dependencies.ts";
  import {
    DEFAULT_ORDER,
    parseOrder,
    SANDBOX_ORDERS,
    sortSandboxes,
  } from "#lib/sandbox-order.ts";
  import type { SandboxOrder } from "#lib/sandbox-order.ts";
  import type { ActiveRun } from "#server/sandbox-runs.ts";
  import type { LayoutProps } from "./$types";

  const REFRESH_MS = 5000;
  const ORDER_KEY = "makak:sandbox-order";

  let { children, data }: LayoutProps = $props();

  let order = $state<SandboxOrder>(DEFAULT_ORDER);
  const sorted = $derived(
    data.sandboxes === undefined
      ? undefined
      : sortSandboxes(data.sandboxes, order)
  );

  // Remembered in this browser only; without storage, it is the default.
  onMount(() => {
    try {
      order = parseOrder(localStorage.getItem(ORDER_KEY));
    } catch {
      // No storage.
    }
  });

  const choose = (value: SandboxOrder) => {
    order = value;
    try {
      localStorage.setItem(ORDER_KEY, value);
    } catch {
      // As above.
    }
  };

  // Each sandbox's running commands and prompts, by sandbox id. They come
  // after the page; the last answer stays shown while a newer one comes,
  // so the markers don't blink at every poll.
  let active = $state<Record<string, ActiveRun[]>>({});
  let latest: Promise<Record<string, ActiveRun[]>> | undefined;
  $effect(() => {
    const pending = data.active;
    latest = pending;
    const settle = async () => {
      const value = await pending;
      if (latest === pending) {
        active = value;
      }
    };
    void settle();
  });

  const activeLabel = (runs: ActiveRun[]) =>
    `${runs.length} running: ${runs.map(({ command }) => command).join(", ")}`;

  const refresh = () => {
    if (document.visibilityState === "visible") {
      invalidate(SANDBOXES, true);
      invalidate(MCP, true);
    }
  };

  // The tab's title counts the calls waiting for approval, so it shows
  // among the browser's tabs, whichever page is open.
  const PENDING_PREFIX = /^\(\d+\) /u;
  const showPending = () => {
    const title = document.title.replace(PENDING_PREFIX, "");
    const count = data.pending.length;
    document.title = count > 0 ? `(${count}) ${title}` : title;
  };
  $effect(showPending);
  afterNavigate(showPending);

  const MCP_PAGES = [
    { href: resolve("/mcp-panel/servers"), label: "Servers" },
    { href: resolve("/mcp-panel/log"), label: "Log" },
  ] as const;

  // The queue opens over the page, which stays as it was. Opened in a new
  // tab, or without JavaScript, it is a page of its own.
  const showApprovals = () => {
    if (
      page.route.id !== "/mcp-panel/approvals" &&
      page.state.approvals !== true
    ) {
      void goto(page.url.href, { shallow: true, state: { approvals: true } });
    }
  };

  const openApprovals = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    showApprovals();
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
    <div class="heading">
      <h2>MCP</h2>
      <ApprovalBell onopen={showApprovals} />
    </div>
    <ul class="links">
      {#each MCP_PAGES as { href, label } (href)}
        <li>
          <a
            {href}
            aria-current={page.url.pathname === href ? "page" : undefined}
            >{label}</a
          >
        </li>
      {/each}
      <li>
        <a
          href={resolve("/mcp-panel/approvals")}
          aria-current={page.route.id === "/mcp-panel/approvals" ||
          page.state.approvals === true
            ? "page"
            : undefined}
          onclick={page.route.id === "/mcp-panel/approvals"
            ? undefined
            : openApprovals}
        >
          Approvals
          {#if data.pending.length > 0}
            <span class="badge" aria-label={`${data.pending.length} waiting`}
              >{data.pending.length}</span
            >
          {/if}
        </a>
      </li>
    </ul>
    <div class="heading">
      <h2>Sandboxes</h2>
      <select
        aria-label="Order sandboxes by"
        value={order}
        onchange={(event) => {
          choose(parseOrder(event.currentTarget.value));
        }}
      >
        {#each SANDBOX_ORDERS as { label, value } (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
    </div>
    <a
      class="new"
      href={resolve("/new")}
      aria-current={page.route.id === "/new" ? "page" : undefined}
      >+ New sandbox</a
    >
    {#if sorted === undefined}
      <p class="error">{data.sbxError}</p>
    {:else if sorted.length === 0}
      <p class="empty">No sandboxes yet.</p>
    {:else}
      <ul>
        {#each sorted as sandbox (sandbox.id)}
          <li>
            <a
              href={resolve("/sandboxes/[name]", { name: sandbox.name })}
              aria-current={page.params.name === sandbox.name
                ? "page"
                : undefined}
            >
              <StatusDot status={sandbox.status} />
              <span class="name">{sandbox.name}</span>
              <span class="visually-hidden">({sandbox.status})</span>
              {#if sandbox.status === "running" && (active[sandbox.id]?.length ?? 0) > 0}
                {@const runs = active[sandbox.id] ?? []}
                <span
                  class="runs"
                  title={activeLabel(runs)}
                  aria-label={activeLabel(runs)}>▶ {runs.length}</span
                >
              {/if}
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

<ApprovalsDialog pending={data.pending} />

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

  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 1.25rem 0.5rem 0.5rem;
  }

  nav h2 {
    margin: 0;
  }

  .links li a {
    display: block;
  }

  .heading select {
    min-width: 0;
    border-color: transparent;
    background: transparent;
    padding: 0.1rem 0.25rem;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .heading select:hover,
  .heading select:focus-visible {
    border-color: var(--border);
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

  .badge {
    margin-left: 0.25rem;
    border-radius: 999px;
    background: var(--accent);
    padding: 0 0.45rem;
    color: var(--surface);
    font-size: 0.8rem;
    font-weight: 600;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li a {
    display: flex;
    align-items: flex-start;
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

  /* Centred on the name's first line. */
  li a :global(.dot) {
    margin-top: calc((1lh - 0.55rem) / 2);
  }

  /* Long names wrap: names often share a prefix, so the ending matters. */
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* Commands and prompts running in the sandbox. */
  .runs {
    flex: none;
    border-radius: 999px;
    background: var(--selected);
    padding: 0 0.4rem;
    color: var(--running);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.5;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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
    padding: 1.25rem 2rem;
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
