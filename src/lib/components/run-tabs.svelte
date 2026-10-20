<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import RunHistory from "#lib/components/run-history.svelte";
  import {
    parseStoredTabs,
    neighbourTab,
    replaceTab,
    syncTabs,
  } from "#lib/run-tabs.ts";
  import { runLabel, runTone } from "#lib/runs.ts";
  import { setRunsContext } from "#lib/runs-context.ts";
  import type { RunsView } from "#lib/runs-context.ts";
  import type { Run } from "#server/tools/index.ts";

  // A sandbox's pages as tabs: its overview, then a tab per run being
  // followed. Which tabs are open is remembered in this browser only.

  let {
    children,
    current,
    id,
    name,
    running,
    runs,
  }: {
    children: Snippet;
    /** The run being viewed; undefined on the overview. */
    current: string | undefined;
    id: string;
    name: string;
    running: boolean;
    runs: Promise<RunsView>;
  } = $props();

  /** Polled this often while a run runs, to show when it ends. */
  const POLL_MS = 3000;
  /** And this often otherwise, to show runs started elsewhere. */
  const IDLE_POLL_MS = 15_000;

  // svelte-ignore state_referenced_locally
  const storageKey = `makak:run-tabs:${id}`;

  let view = $state<RunsView | undefined>();
  let failed = $state(false);
  let list = $state<Run[] | undefined>();
  let open = $state<string[]>([]);
  let restored = $state(false);
  // A run being run again: its tab goes to the new run once that is shown.
  let rerun = $state<{ from: string; to: string } | undefined>();
  let history = $state<RunHistory>();

  const base = $derived(resolve("/sandboxes/[name]", { name }));
  const runPage = (run: string) =>
    resolve("/sandboxes/[name]/runs/[run]", { name, run });

  // Runs arrive after the page, since the sandbox is asked for them. The
  // last answer stays shown while a newer one comes, so nothing blinks.
  // The same answer comes again whenever the sidebar refreshes, and must not
  // replace the list as polled since.
  let handled: Promise<RunsView> | undefined;
  $effect(() => {
    const pending = runs;
    if (pending === handled) {
      return;
    }
    handled = pending;
    const settle = async () => {
      try {
        const value = await pending;
        if (handled === pending) {
          view = value;
          ({ list } = value);
          failed = false;
        }
      } catch {
        if (handled === pending) {
          failed = true;
        }
      }
    };
    void settle();
  });

  // Only the newest answer counts: an older one may arrive after it.
  let asked = 0;
  const refresh = async () => {
    asked += 1;
    const ask = asked;
    try {
      const response = await fetch(
        `/sandboxes/${encodeURIComponent(name)}/runs`
      );
      const body = (await response.json()) as { runs?: Run[] };
      if (ask === asked && body.runs !== undefined) {
        list = body.runs;
      }
    } catch {
      // The next poll tries again.
    }
  };

  const anyRunning = $derived(
    list?.some(({ state }) => state === "running") ?? false
  );

  $effect(() => {
    if (!running || list === undefined) {
      return;
    }
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") {
          void refresh();
        }
      },
      anyRunning ? POLL_MS : IDLE_POLL_MS
    );
    return () => {
      clearInterval(timer);
    };
  });

  // A run that has just started isn't listed yet; ask once for it.
  let askedFor: string | undefined;
  $effect(() => {
    if (
      running &&
      current !== undefined &&
      current !== askedFor &&
      list !== undefined &&
      !list.some((run) => run.id === current)
    ) {
      askedFor = current;
      void refresh();
    }
  });

  onMount(() => {
    try {
      open = parseStoredTabs(localStorage.getItem(storageKey));
    } catch {
      // No storage: tabs are forgotten on reload.
    }
    restored = true;
  });

  const tabs = $derived(
    syncTabs(
      rerun !== undefined && current === rerun.to
        ? replaceTab(open, rerun.from, rerun.to)
        : open,
      list,
      current
    )
  );

  // Keeps what was added, such as a run that ended, open until closed.
  $effect(() => {
    if (restored && tabs.join(",") !== open.join(",")) {
      open = tabs;
    }
  });

  $effect(() => {
    if (!restored) {
      return;
    }
    const value = JSON.stringify(open);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // As above.
    }
  });

  $effect(() => {
    if (
      rerun !== undefined &&
      open.includes(rerun.to) &&
      !open.includes(rerun.from)
    ) {
      rerun = undefined;
    }
  });

  // Runs can only be read while the sandbox runs; their tabs come back
  // when it starts.
  const shown = $derived(running ? tabs : []);

  const runOf = (tab: string) => list?.find((run) => run.id === tab);

  const close = async (tab: string) => {
    if (tab === current) {
      const next = neighbourTab(shown, tab);
      await goto(next === undefined ? base : runPage(next));
    }
    open = open.filter((each) => each !== tab);
  };

  setRunsContext({
    get failed() {
      return failed;
    },
    get list() {
      return list;
    },
    refresh,
    rerun: (from, to) => {
      rerun = { from, to };
    },
    get view() {
      return view;
    },
  });
</script>

<nav class="tabs" aria-label="Runs">
  <div class="strip">
    <div class="tab" aria-current={current === undefined ? "page" : undefined}>
      <a href={base}>Overview</a>
    </div>
    {#each shown as tab (tab)}
      {@const run = runOf(tab)}
      <div class="tab" aria-current={tab === current ? "page" : undefined}>
        <a href={runPage(tab)} title={run?.command}>
          {#if run !== undefined}
            <span
              class={["dot", runTone(run)]}
              title={runLabel(run)}
              aria-label={runLabel(run)}
              role="img"
            ></span>
          {/if}
          <code>{run?.command ?? "…"}</code>
        </a>
        {#if run !== undefined && run.state !== "running"}
          <button
            type="button"
            class="close"
            aria-label={`Close ${run.command}`}
            title="Close"
            onclick={() => close(tab)}>×</button
          >
        {/if}
      </div>
    {/each}
  </div>
  {#if running && list !== undefined && list.length > 0}
    <button type="button" class="history" onclick={() => history?.show()}
      >History ({list.length})</button
    >
  {/if}
</nav>

{#if list !== undefined}
  <RunHistory
    bind:this={history}
    {id}
    {list}
    {name}
    onchanged={() => {
      void refresh();
    }}
  />
{/if}

{@render children()}

<style>
  /* Folder tabs: the current one opens into the page below the line. */
  .tabs {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
    box-shadow: inset 0 -1px 0 var(--border);
  }

  /* Scrolls sideways when there are many; History stays in view. */
  .strip {
    display: flex;
    flex: 1;
    align-items: flex-end;
    gap: 0.25rem;
    min-width: 0;
    overflow-x: auto;
  }

  .tab {
    display: flex;
    flex: none;
    align-items: center;
    margin-bottom: 1px;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: var(--sidebar);
    color: var(--muted);
    text-decoration: none;
  }

  /* One line height for the sans and the monospace labels alike, so every
     tab is as tall. */
  .tab a {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    line-height: 1.5rem;
    color: inherit;
    text-decoration: none;
  }

  .tab:hover {
    color: var(--text);
  }

  .tab[aria-current="page"] {
    margin-bottom: 0;
    padding-bottom: 1px;
    background: var(--bg);
    box-shadow: inset 0 2px 0 var(--accent);
    color: var(--text);
  }

  .tab code {
    display: block;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    margin-right: 0.25rem;
    border: none;
    background: none;
    padding: 0 0.3rem;
    color: var(--muted);
    line-height: 1;
  }

  .close:hover {
    color: var(--text);
  }

  .history {
    flex: none;
    align-self: center;
    border: none;
    background: none;
    color: var(--accent);
  }

  .dot {
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }

  .running {
    background: var(--running);
  }

  .ok {
    background: var(--stopped);
  }

  .bad {
    background: var(--error-text);
  }
</style>
