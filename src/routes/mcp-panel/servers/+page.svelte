<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";
  import McpTools from "#lib/components/mcp-tools.svelte";
  import { formatTime } from "#lib/format.ts";
  import { formatHold } from "#lib/mcp.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  /** Each server's tools dialog. */
  const toolDialogs: Record<string, McpTools> = $state({});
  /** `<action>:<server>` while sbx or the server is asked: it takes a while. */
  let changing = $state<string | undefined>();

  const REGISTRATION_LABELS = {
    missing: "Not registered",
    ready: "Registered",
    stale: "Not usable",
    unusable: "Not usable",
  } as const;

  const change =
    (action: string, server: string): SubmitFunction =>
    () => {
      changing = `${action}:${server}`;
      return async ({ update }) => {
        await update();
        changing = undefined;
      };
    };

  // Signing in leaves the Panel for the server's own page. Through fetch, like
  // every form here: a plain form post would carry no Origin, as the Panel
  // sends no Referer.
  const leave: SubmitFunction =
    () =>
    async ({ result, update }) => {
      if (result.type === "redirect") {
        window.location.assign(result.location);
        return;
      }
      await update();
    };
</script>

<svelte:head>
  <title>MCP servers · Makak Panel</title>
</svelte:head>

<h1>MCP servers</h1>

{#if data.error !== ""}
  <p class="error">{data.error}</p>
{/if}
{#if form?.message !== undefined}
  <p class="error" role="alert">{form.message}</p>
{/if}
{#if form?.left !== undefined && form.left.length > 0}
  <div class="error" role="alert">
    <p>
      {form.unregistered} is unregistered, but sbx refused to remove some of it. Run
      these on your machine:
    </p>
    <pre>{form.left.join("\n")}</pre>
  </div>
{/if}

{#if data.servers.length === 0}
  <p class="hint">
    No MCP servers are configured. Add them under <code>mcp.servers</code> in the
    config.
  </p>
{:else}
  {#each data.servers as server (server.name)}
    {@const needsSignIn =
      server.signIn !== undefined && !server.signIn.signedIn}
    <section class="server">
      <header>
        <h3>{server.name}</h3>
        {#if server.local === undefined}
          <code class="upstream">{server.url}</code>
        {:else}
          <code class="upstream" title="Run on this machine, by the Panel"
            >$ {server.local.command}</code
          >
        {/if}
      </header>
      <dl>
        <dt>Check</dt>
        <dd>
          {#if server.check === undefined}
            <span class="hint">Not checked yet.</span>
          {:else}
            {#if server.check.reason === undefined}
              <span
                >OK: it lists {server.check.tools}
                {server.check.tools === 1 ? "tool" : "tools"}.</span
              >
            {:else}
              <span class="bad">Failed. {server.check.reason}</span>
            {/if}
            <span class="hint">{formatTime(server.check.at)}</span>
          {/if}
          <form
            method="POST"
            action="?/check"
            use:enhance={change("check", server.name)}
          >
            <input type="hidden" name="server" value={server.name} />
            <button
              type="submit"
              disabled={changing !== undefined}
              title="Start a session with the server and list its tools, as the Panel"
              >{changing === `check:${server.name}`
                ? "Checking…"
                : "Check"}</button
            >
          </form>
        </dd>

        {#if server.lastError !== undefined}
          <dt>Last error</dt>
          <dd>
            <span class="bad">{server.lastError.message}</span>
            <span class="hint">{formatTime(server.lastError.at)}</span>
          </dd>
        {/if}

        <dt>Sign-in</dt>
        <dd>
          {#if server.signIn === undefined}
            <span class="hint">Not needed</span>
          {:else}
            {#if server.signIn.signedIn}
              <span>Signed in</span>
            {:else}
              <span class="bad">Not signed in</span>
            {/if}
            <form method="POST" action="?/signIn" use:enhance={leave}>
              <input type="hidden" name="server" value={server.name} />
              <button type="submit" class={{ primary: !server.signIn.signedIn }}
                >{server.signIn.signedIn ? "Sign in again" : "Sign in"}</button
              >
            </form>
            {#if server.signIn.signedIn}
              <form method="POST" action="?/signOut" use:enhance>
                <input type="hidden" name="server" value={server.name} />
                <button type="submit">Sign out</button>
              </form>
            {/if}
          {/if}
        </dd>

        <dt>In sbx</dt>
        <dd>
          {#if server.registration === undefined}
            <span class="hint">Unknown</span>
          {:else}
            {@const { detail, state } = server.registration}
            <span class={{ bad: state !== "ready" }}
              >{REGISTRATION_LABELS[state]}</span
            >
            {#if state !== "ready"}
              <form
                method="POST"
                action="?/register"
                use:enhance={change("register", server.name)}
              >
                <input type="hidden" name="server" value={server.name} />
                <button
                  type="submit"
                  class="primary"
                  disabled={changing !== undefined || needsSignIn}
                  title={needsSignIn
                    ? "Sign in first: sbx connects to the server when it registers it"
                    : `sbx mcp add ${server.name}, for every sandbox to load`}
                  >{changing === `register:${server.name}`
                    ? "Registering…"
                    : state === "missing"
                      ? "Register"
                      : "Register again"}</button
                >
              </form>
            {/if}
            {#if state !== "missing"}
              <form
                method="POST"
                action="?/unregister"
                use:enhance={change("unregister", server.name)}
              >
                <input type="hidden" name="server" value={server.name} />
                <button
                  type="submit"
                  disabled={changing !== undefined}
                  title="Sandboxes that loaded it lose its tools"
                  >{changing === `unregister:${server.name}`
                    ? "Unregistering…"
                    : "Unregister"}</button
                >
              </form>
            {/if}
            {#if detail !== undefined}
              <p class="hint detail">{detail}</p>
            {/if}
          {/if}
        </dd>

        {#if server.local !== undefined}
          <dt>Running</dt>
          <dd>
            {server.local.processes === 0
              ? "No process now: one starts for each sandbox that connects."
              : `${server.local.processes} ${server.local.processes === 1 ? "process" : "processes"}, one for each session.`}
            {#if server.local.stderr.length > 0}
              <details>
                <summary>Its output</summary>
                <pre class="output">{server.local.stderr.join("\n")}</pre>
              </details>
            {/if}
          </dd>
        {/if}

        <dt>Endpoint</dt>
        <dd><code>{data.origin}/mcp/{server.name}</code></dd>

        <dt>Hold</dt>
        <dd>{formatHold(server.holdSeconds)}</dd>

        <dt>Tools</dt>
        <dd>
          {#if server.tools.length === 0}
            <span class="hint">None known</span>
          {:else}
            {@const allowed = server.tools.filter(
              (tool) => tool.allowed !== undefined
            ).length}
            {server.tools.length}
            {server.tools.length === 1 ? "tool" : "tools"},
            {allowed === 0 ? "none" : allowed} allowed without asking
          {/if}
          <button type="button" onclick={() => toolDialogs[server.name]?.show()}
            >Show</button
          >
          <McpTools
            bind:this={toolDialogs[server.name]}
            listed={server.check?.tools}
            server={server.name}
            tools={server.tools}
          />
        </dd>

        <dt>Calls</dt>
        <dd>
          <a
            href={`${resolve("/mcp-panel/log")}?server=${encodeURIComponent(server.name)}`}
            >Recent calls</a
          >
        </dd>
      </dl>
    </section>
  {/each}
{/if}

<style>
  .hint {
    color: var(--muted);
  }

  .error {
    border-radius: 6px;
    background: var(--error-bg);
    padding: 0.5rem 0.75rem;
    color: var(--error-text);
  }

  .error p,
  .error pre {
    margin: 0;
  }

  .server {
    margin: 1rem 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.75rem 1rem;
  }

  .server header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.75rem;
  }

  h3 {
    margin: 0;
    font-size: 1.05rem;
  }

  /* The server the Panel passes calls on to, next to its name. */
  .upstream {
    color: var(--muted);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: 7rem 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0.6rem 0 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  dd form,
  dd > button {
    display: inline;
    margin-left: 0.4rem;
  }

  dd button {
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
  }

  .bad {
    color: var(--warning-text);
  }

  .output {
    max-height: 16rem;
    overflow: auto;
    font-size: 0.8rem;
    white-space: pre-wrap;
  }

  .detail {
    margin: 0.25rem 0 0;
    font-size: 0.85rem;
  }
</style>
