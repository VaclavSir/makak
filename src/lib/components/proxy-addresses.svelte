<script lang="ts">
  import { publishCommand } from "#lib/commands.ts";
  import { sandboxUrls } from "#lib/proxy-urls.ts";
  import type { PortMapping, ProxySettings } from "#lib/proxy-urls.ts";
  import CopyButton from "./copy-button.svelte";

  let {
    name,
    ports,
    running,
    settings,
  }: {
    name: string;
    ports: PortMapping[];
    running: boolean;
    settings: ProxySettings;
  } = $props();

  const urls = $derived(sandboxUrls(name, ports, settings));
  // Each port to publish once, however many addresses wait for it.
  const unpublished = $derived([
    ...new Set(
      (urls ?? []).flatMap(({ resolution }) =>
        resolution.ok ? [] : [resolution.publish]
      )
    ),
  ]);
</script>

{#if settings.listeners.length === 0}
  <p class="muted">
    The reverse proxy is off. Add listeners to <code>proxy.listeners</code> in the
    config to give sandboxes stable addresses.
  </p>
{:else if urls === undefined}
  <p class="muted">
    The name {name} can't be used in a hostname, so the reverse proxy can't serve
    this sandbox.
  </p>
{:else}
  {#if !running}
    <p class="muted">These addresses work once the sandbox is running.</p>
  {/if}
  <ul>
    {#each urls as { elevated, listener, resolution, url } (url)}
      <li>
        {#if listener.websocket}
          <code>{url}</code>
        {:else}
          <a href={url} target="_blank" rel="noreferrer"><code>{url}</code></a>
        {/if}
        {#if resolution.ok}
          <span
            class="muted"
            title={elevated
              ? "The proxy adds TLS; the server in the sandbox doesn't need it."
              : undefined}
          >
            → port {resolution.port.sandboxPort}{elevated ? " · elevated" : ""}
          </span>
        {:else}
          <span class="missing" title={publishCommand(name, resolution.publish)}
            >port {listener.upstream.join(" or ")} not published</span
          >
        {/if}
        <CopyButton label={url} value={url} />
      </li>
    {/each}
  </ul>
  {#each unpublished as port (port)}
    <p class="muted">
      To serve port {port}, run
      <code>{publishCommand(name, port)}</code>.
    </p>
  {/each}
{/if}

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0;
  }

  li > :first-child {
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--muted);
  }

  .missing {
    color: var(--error-text);
  }

  p.muted {
    margin: 0.5rem 0 0;
  }
</style>
