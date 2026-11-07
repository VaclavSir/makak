<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { onMount } from "svelte";
  import {
    BELLS,
    bellOf,
    createNewNotices,
    EVENTS_PATH,
    FOCUS_CHANNEL,
    FOCUS_REPLY_MS,
    noticeText,
    NOTIFIER_LOCK,
    NOTIFY_KEY,
    parseNotices,
  } from "#lib/approval-notices.ts";
  import favicon from "#lib/assets/favicon.svg";
  import { MCP } from "#lib/dependencies.ts";
  import type { Notice } from "#server/mcp/approval-events.ts";

  // Notifies about tool calls waiting for the user while no tab of the
  // Panel has focus, and is the bell that turns that on and off. Every tab
  // follows the queue's stream; one of them, holding a lock, notifies.

  let {
    onopen,
  }: {
    /** Shows the queue, after a notification was clicked. */
    onopen: () => void;
  } = $props();

  let supported = $state(false);
  let permission = $state<NotificationPermission>("default");
  let enabled = $state(false);
  let stopped = $state(false);
  const bell = $derived(bellOf({ enabled, permission, stopped }));

  const readEnabled = () => {
    try {
      return localStorage.getItem(NOTIFY_KEY) === "on";
    } catch {
      return false;
    }
  };

  const setEnabled = (value: boolean) => {
    enabled = value;
    try {
      localStorage.setItem(NOTIFY_KEY, value ? "on" : "off");
    } catch {
      // Chosen for this page only.
    }
  };

  const toggle = async () => {
    if (bell === "blocked") {
      return;
    }
    if (bell === "on" || bell === "stopped") {
      setEnabled(false);
      return;
    }
    if (Notification.permission !== "granted") {
      permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return;
      }
    }
    setEnabled(true);
  };

  /** Whether this tab, or another, has focus; then nobody notifies. */
  const anyTabFocused = async (channel: BroadcastChannel | undefined) => {
    if (document.hasFocus()) {
      return true;
    }
    if (channel === undefined) {
      return false;
    }
    const nonce = crypto.randomUUID();
    const answered = Promise.withResolvers<boolean>();
    const listen = (event: MessageEvent) => {
      if (event.data?.type === "focused" && event.data.nonce === nonce) {
        answered.resolve(true);
      }
    };
    channel.addEventListener("message", listen);
    const timer = setTimeout(() => {
      answered.resolve(false);
    }, FOCUS_REPLY_MS);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no origin to name
    channel.postMessage({ nonce, type: "ask" });
    try {
      return await answered.promise;
    } finally {
      clearTimeout(timer);
      channel.removeEventListener("message", listen);
    }
  };

  onMount(() => {
    supported = "Notification" in window;
    if (!supported) {
      return;
    }
    ({ permission } = Notification);
    enabled = readEnabled();

    // Notifications shown by this tab, by request id, to close once the
    // request is decided anywhere.
    const shown = new Map<string, Notification>();
    const newNotices = createNewNotices();

    const channel =
      "BroadcastChannel" in window
        ? new BroadcastChannel(FOCUS_CHANNEL)
        : undefined;
    channel?.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.type === "ask" && document.hasFocus()) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- as above
        channel.postMessage({ nonce: event.data.nonce, type: "focused" });
      }
    });

    // One tab notifies, so a click always finds it: the one holding the
    // lock. It lets go when it closes, or when its stream stops for good.
    let notifier = !("locks" in navigator);
    // oxlint-disable-next-line typescript/no-invalid-void-type -- it settles with nothing
    const release = Promise.withResolvers<void>();
    if (!notifier) {
      void navigator.locks.request(NOTIFIER_LOCK, async () => {
        notifier = true;
        await release.promise;
        notifier = false;
      });
    }

    const show = (notice: Notice) => {
      const { body, title } = noticeText(notice);
      try {
        const notification = new Notification(title, {
          body,
          icon: favicon,
          // A waiting call holds an agent up; it is closed once decided.
          requireInteraction: true,
          tag: notice.id,
        });
        notification.addEventListener("click", () => {
          window.focus();
          onopen();
          notification.close();
        });
        shown.set(notice.id, notification);
      } catch {
        // Such as a browser that only notifies from a service worker.
      }
    };

    const received = async (list: Notice[]) => {
      if (document.visibilityState === "visible") {
        void invalidate(MCP, true);
      }
      const waiting = new Set(list.map(({ id }) => id));
      for (const [id, notification] of shown) {
        if (!waiting.has(id)) {
          notification.close();
          shown.delete(id);
        }
      }
      const added = newNotices(list);
      if (
        added.length === 0 ||
        !notifier ||
        !enabled ||
        Notification.permission !== "granted" ||
        (await anyTabFocused(channel))
      ) {
        return;
      }
      for (const notice of added) {
        show(notice);
      }
    };

    const events = new EventSource(EVENTS_PATH);
    events.addEventListener("message", (event: MessageEvent<string>) => {
      const list = parseNotices(event.data);
      if (list !== undefined) {
        void received(list);
      }
    });
    // A connection lost for a while is retried by the browser; one refused,
    // such as once the Panel restarted, is closed for good.
    events.addEventListener("error", () => {
      if (events.readyState === EventSource.CLOSED) {
        stopped = true;
        release.resolve();
      }
    });

    const syncEnabled = (event: StorageEvent) => {
      if (event.key === NOTIFY_KEY) {
        enabled = readEnabled();
      }
    };
    // The browser's settings may have changed meanwhile.
    const syncPermission = () => {
      ({ permission } = Notification);
    };
    window.addEventListener("storage", syncEnabled);
    window.addEventListener("focus", syncPermission);

    return () => {
      events.close();
      channel?.close();
      release.resolve();
      window.removeEventListener("storage", syncEnabled);
      window.removeEventListener("focus", syncPermission);
      for (const notification of shown.values()) {
        notification.close();
      }
    };
  });
</script>

{#if supported}
  <button
    type="button"
    class="bell"
    class:quiet={bell !== "on"}
    title={BELLS[bell].title}
    aria-label={BELLS[bell].title}
    aria-pressed={bell === "on" || bell === "stopped"}
    onclick={toggle}>{BELLS[bell].icon}</button
  >
{/if}

<style>
  .bell {
    border-color: transparent;
    background: transparent;
    padding: 0.1rem 0.3rem;
    font-size: 0.85rem;
    line-height: 1;
  }

  .bell:hover,
  .bell:focus-visible {
    border-color: var(--border);
  }

  .quiet {
    opacity: 0.55;
  }
</style>
