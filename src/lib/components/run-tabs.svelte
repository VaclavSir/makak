<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import RunHistory from "#lib/components/run-history.svelte";
  import {
    moveTab,
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
  // followed, in the order they're dragged to. Which tabs are open, and
  // their order, is remembered in this browser only.

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

  // Tabs shrink as more open, down to a width where they scroll instead;
  // the current one is scrolled into view.
  let strip = $state<HTMLDivElement>();
  $effect(() => {
    // Rerun when the tab changes, or tabs come and go.
    void current;
    void shown.length;
    const tab = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (strip === undefined || tab === null || tab === undefined) {
      return;
    }
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < strip.scrollLeft) {
      strip.scrollLeft = start;
    } else if (end > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = end - strip.clientWidth;
    }
  });

  // Dragging a run's tab onto another moves it before or after that one,
  // by which half it is dropped on. The overview stays first.
  let dragged = $state<string | undefined>();
  let drop = $state<{ target: string; after: boolean } | undefined>();

  const dragStart = (tab: string) => (event: DragEvent) => {
    dragged = tab;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
    }
  };

  const dragOver = (tab: string) => (event: DragEvent) => {
    if (dragged === undefined) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "move";
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    drop = tab === dragged ? undefined : { after, target: tab };
  };

  const dragEnd = () => {
    dragged = undefined;
    drop = undefined;
  };

  const dropped = (event: DragEvent) => {
    event.preventDefault();
    if (dragged !== undefined && drop !== undefined) {
      open = moveTab(open, dragged, drop.target, drop.after);
    }
    dragEnd();
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
  <div class="strip" role="list" bind:this={strip}>
    <div
      class="tab"
      role="listitem"
      aria-current={current === undefined ? "page" : undefined}
    >
      <a href={base}>Overview</a>
    </div>
    {#each shown as tab (tab)}
      {@const run = runOf(tab)}
      <div
        class={[
          "tab",
          "run",
          {
            "drop-after": drop?.target === tab && drop.after,
            "drop-before": drop?.target === tab && !drop.after,
            dragged: dragged === tab,
          },
        ]}
        aria-current={tab === current ? "page" : undefined}
        draggable="true"
        role="listitem"
        ondragstart={dragStart(tab)}
        ondragover={dragOver(tab)}
        ondragleave={() => {
          if (drop?.target === tab) {
            drop = undefined;
          }
        }}
        ondrop={dropped}
        ondragend={dragEnd}
      >
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

  /* Run tabs shrink as more open, like a browser's, then scroll sideways;
     History stays in view. Positioned, for the current tab's offsetLeft. */
  .strip {
    position: relative;
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
    min-width: 0;
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

  .tab.run {
    position: relative;
    flex: 0 1 auto;
    min-width: 7rem;
  }

  .tab.run a {
    flex: 1;
    min-width: 0;
  }

  .tab.dragged {
    opacity: 0.5;
  }

  /* Where a dragged tab would land: a bar on that side. */
  .tab.drop-before::before,
  .tab.drop-after::after {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--accent);
    content: "";
  }

  .tab.drop-before::before {
    left: -3px;
  }

  .tab.drop-after::after {
    right: -3px;
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
    min-width: 0;
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
