<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { onDestroy, onMount } from "svelte";

  // A run's log in a read-only terminal, so progress bars that redraw a line
  // and colours show as they would in a terminal. The log is the command's
  // output, which the sandbox controls: nothing in it is ever run as HTML,
  // and what the terminal would answer back is never sent anywhere.

  let {
    columns,
    logSize,
    name,
    onended,
    rows,
    run,
    running,
  }: {
    columns: number;
    /** The log's size when the page loaded, to skip all but its end. */
    logSize: number;
    name: string;
    /** Called once the run has ended and the whole log is shown. */
    onended?: () => void;
    rows: number;
    run: string;
    /** Whether it ran when the page loaded; a finished log is read once. */
    running: boolean;
  } = $props();

  /** Replaying more than this would only slow the page down. */
  const REPLAY_LIMIT = 2 * 1024 * 1024;

  let element: HTMLDivElement;
  let failure = $state("");
  // svelte-ignore state_referenced_locally
  const skipped = Math.max(0, logSize - REPLAY_LIMIT);
  const controller = new AbortController();

  // svelte-ignore state_referenced_locally
  const base = `/sandboxes/${encodeURIComponent(name)}`;

  const pause = (ms: number) =>
    // oxlint-disable-next-line promise/avoid-new -- a timer
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Whether the run still runs, by the list, which knows. */
  const stillRunning = async () => {
    const response = await fetch(`${base}/runs`, { signal: controller.signal });
    const { runs } = (await response.json()) as {
      runs?: { id: string; state: string }[];
    };
    return runs?.find(({ id }) => id === run)?.state === "running";
  };

  /**
   * Reads the log from `offset`, writing it as it comes. Returns the offset
   * reached, or undefined after showing why it couldn't.
   */
  const read = async (
    offset: number,
    follow: boolean,
    write: (bytes: Uint8Array) => void
  ) => {
    const response = await fetch(
      `${base}/runs/${encodeURIComponent(run)}/log?from=${offset}&follow=${follow ? 1 : 0}`,
      { signal: controller.signal }
    );
    if (!response.ok || response.body === null) {
      failure = `Can't read the log: ${await response.text()}`;
      return;
    }
    let reached = offset;
    const reader = response.body.getReader();
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        write(value);
        reached += value.length;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      // The connection broke; the caller carries on from here.
    }
    return reached;
  };

  /**
   * Writes the log as it comes, resuming where it left off when the
   * connection ends while the run still runs.
   */
  const follow = async (write: (bytes: Uint8Array) => void) => {
    // svelte-ignore state_referenced_locally
    if (!running) {
      await read(skipped, false, write);
      return;
    }
    let offset: number | undefined = skipped;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one stream at a time
      offset = await read(offset, true, write);
      if (offset === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- decides the next step
      if (!(await stillRunning())) {
        // Whatever it printed after the connection ended.
        // oxlint-disable-next-line no-await-in-loop -- the last read
        await read(offset, false, write);
        onended?.();
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- before reconnecting
      await pause(1000);
    }
  };

  onMount(() => {
    let disposed = false;
    let dispose = () => {
      disposed = true;
    };
    const start = async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (disposed) {
        return;
      }
      const terminal = new Terminal({
        cols: columns,
        convertEol: true,
        cursorInactiveStyle: "none",
        disableStdin: true,
        fontFamily:
          'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        // Links the output declares (OSC 8) open only on a click, after a
        // confirmation, and only for the web.
        linkHandler: {
          activate: (_, uri) => {
            if (
              /^https?:\/\//u.test(uri) &&
              // oxlint-disable-next-line no-alert -- a choice before leaving
              confirm(`Open ${uri}?`)
            ) {
              window.open(uri, "_blank", "noopener,noreferrer");
            }
          },
        },
        rows,
        scrollback: 50_000,
        theme: { background: "#171615", foreground: "#ebe9e6" },
      });
      terminal.open(element);
      dispose = () => {
        terminal.dispose();
      };
      try {
        await follow((bytes) => {
          terminal.write(bytes);
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          failure = `Can't read the log: ${(error as Error).message}`;
        }
      }
    };
    void start();
    return () => {
      dispose();
    };
  });

  onDestroy(() => {
    controller.abort();
  });
</script>

{#if skipped > 0}
  <p class="muted">
    The log is long; showing its last {Math.round(REPLAY_LIMIT / 1024 / 1024)} MB.
  </p>
{/if}
<div class="terminal" bind:this={element}></div>
{#if failure !== ""}
  <p class="error">{failure}</p>
{/if}

<style>
  .terminal {
    overflow-x: auto;
    border-radius: 6px;
    background: #171615;
    padding: 0.5rem;
  }

  .muted {
    color: var(--muted);
  }
</style>
