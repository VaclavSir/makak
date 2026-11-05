<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import McpArguments from "#lib/components/mcp-arguments.svelte";
  import { formatTime } from "#lib/format.ts";
  import { argumentsSummary, formatHold, OUTCOME_LABELS } from "#lib/mcp.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let busy = $state<string | undefined>();
  /** The server being registered or unregistered: sbx takes a while. */
  let changing = $state<string | undefined>();

  const REGISTRATION_LABELS = {
    missing: "Not registered",
    ready: "Registered",
    stale: "Not usable",
    unusable: "Not usable",
  } as const;

  const change =
    (server: string): SubmitFunction =>
    () => {
      changing = server;
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
  <title>MCP approvals · Makak Panel</title>
</svelte:head>

<h1>MCP approvals</h1>

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

<h2>Waiting for you</h2>
{#if data.pending.length === 0}
  <p class="hint">No tool calls are waiting.</p>
{:else}
  <ul class="queue">
    {#each data.pending as request (request.id)}
      <li>
        <div class="summary">
          <code class="tool">{request.tool}</code>
          on <strong>{request.server}</strong>
          <span class="hint">
            · {formatTime(request.requestedAt)} · request {request.id}
          </span>
        </div>
        {#if !request.waiting}
          <p class="hint">
            The agent stopped waiting. Your decision applies to its next call
            with the same arguments.
          </p>
        {/if}
        <McpArguments args={request.arguments} />
        <form
          method="POST"
          action="?/decide"
          use:enhance={() => {
            busy = request.id;
            return async ({ update }) => {
              await update();
              busy = undefined;
            };
          }}
        >
          <input type="hidden" name="id" value={request.id} />
          <button
            type="submit"
            class="primary"
            name="decision"
            value="allow"
            disabled={busy !== undefined}>Allow once</button
          >
          <button
            type="submit"
            name="decision"
            value="always"
            disabled={busy !== undefined}
            title={`Allow ${request.tool} from every sandbox from now on`}
            >Always allow {request.tool}</button
          >
          <button
            type="submit"
            class="danger"
            name="decision"
            value="deny"
            disabled={busy !== undefined}>Deny</button
          >
        </form>
      </li>
    {/each}
  </ul>
{/if}

<h2>Servers</h2>
{#if data.servers.length === 0}
  <p class="hint">
    No MCP servers are configured. Add them under <code>mcp.servers</code> in the
    config.
  </p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Server</th>
        <th>Endpoint</th>
        <th>Hold</th>
        <th>Sign-in</th>
        <th>In sbx</th>
        <th>Allowed without asking</th>
      </tr>
    </thead>
    <tbody>
      {#each data.servers as server (server.name)}
        <tr>
          <td>
            <strong>{server.name}</strong>
            <code class="upstream">{server.url}</code>
          </td>
          <td><code>{data.origin}/mcp/{server.name}</code></td>
          <td>{formatHold(server.holdSeconds)}</td>
          <td class="sign-in">
            {#if server.signIn === undefined}
              <span class="hint">By config</span>
            {:else}
              {#if server.signIn.signedIn}
                <span>Signed in</span>
              {:else}
                <span class="signed-out">Not signed in</span>
              {/if}
              <form method="POST" action="?/signIn" use:enhance={leave}>
                <input type="hidden" name="server" value={server.name} />
                <button
                  type="submit"
                  class={{ primary: !server.signIn.signedIn }}
                  >{server.signIn.signedIn
                    ? "Sign in again"
                    : "Sign in"}</button
                >
              </form>
              {#if server.signIn.signedIn}
                <form method="POST" action="?/signOut" use:enhance>
                  <input type="hidden" name="server" value={server.name} />
                  <button type="submit">Sign out</button>
                </form>
              {/if}
            {/if}
          </td>
          <td class="registration">
            {#if server.registration === undefined}
              <span class="hint">Unknown</span>
            {:else}
              {@const { detail, state } = server.registration}
              {@const needsSignIn =
                server.signIn !== undefined && !server.signIn.signedIn}
              <span class={{ "signed-out": state !== "ready" }}
                >{REGISTRATION_LABELS[state]}</span
              >
              {#if state !== "ready"}
                <form
                  method="POST"
                  action="?/register"
                  use:enhance={change(server.name)}
                >
                  <input type="hidden" name="server" value={server.name} />
                  <button
                    type="submit"
                    class="primary"
                    disabled={changing !== undefined || needsSignIn}
                    title={needsSignIn
                      ? "Sign in first: sbx connects to the server when it registers it"
                      : `sbx mcp add ${server.name}, for every sandbox to load`}
                    >{changing === server.name
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
                  use:enhance={change(server.name)}
                >
                  <input type="hidden" name="server" value={server.name} />
                  <button
                    type="submit"
                    disabled={changing !== undefined}
                    title="Sandboxes that loaded it lose its tools"
                    >Unregister</button
                  >
                </form>
              {/if}
              {#if detail !== undefined}
                <p class="hint detail">{detail}</p>
              {/if}
            {/if}
          </td>
          <td>
            <ul class="tools">
              {#each server.allow as tool (tool)}
                <li title="From the config"><code>{tool}</code></li>
              {/each}
              {#each server.always.filter((tool) => !server.allow.includes(tool)) as tool (tool)}
                <li>
                  <form method="POST" action="?/disallow" use:enhance>
                    <input type="hidden" name="server" value={server.name} />
                    <input type="hidden" name="tool" value={tool} />
                    <code>{tool}</code>
                    <button
                      type="submit"
                      class="remove"
                      aria-label={`Stop allowing ${tool}`}
                      title="Stop allowing it without asking">×</button
                    >
                  </form>
                </li>
              {/each}
              {#if server.allow.length === 0 && server.always.length === 0}
                <li class="hint">Nothing: every call asks.</li>
              {/if}
            </ul>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>Recent calls</h2>
{#if data.audit.length === 0}
  <p class="hint">No tool calls yet.</p>
{:else}
  <table class="audit">
    <thead>
      <tr>
        <th>When</th>
        <th>Call</th>
        <th>Outcome</th>
      </tr>
    </thead>
    <tbody>
      {#each data.audit as entry, index (index)}
        <tr>
          <td class="hint when">{formatTime(entry.at)}</td>
          <td class="call">
            <details>
              <summary
                ><code>{entry.server} · {entry.tool}</code>
                <span class="hint">{argumentsSummary(entry.arguments)}</span
                ></summary
              >
              <McpArguments args={entry.arguments} />
            </details>
          </td>
          <td class={["outcome", entry.outcome]}>
            {OUTCOME_LABELS[entry.outcome]}{entry.earlier ? " earlier" : ""}
            {#if entry.request !== undefined}
              <span class="hint">· {entry.request}</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
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

  .queue {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .queue > li {
    display: grid;
    gap: 0.6rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.75rem 1rem;
  }

  .queue p {
    margin: 0;
  }

  .tool {
    font-weight: 600;
  }

  .queue form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.3rem 1rem 0.3rem 0;
    text-align: left;
    vertical-align: top;
  }

  th {
    color: var(--muted);
    font-weight: normal;
  }

  td code {
    overflow-wrap: anywhere;
  }

  /* The server the Panel passes calls on to, under its name. */
  .upstream {
    display: block;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .sign-in {
    white-space: nowrap;
  }

  .sign-in form,
  .registration form {
    display: inline;
    margin-left: 0.4rem;
  }

  .sign-in button,
  .registration button {
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
  }

  .signed-out {
    color: var(--warning-text);
  }

  .detail {
    margin: 0.25rem 0 0;
    max-width: 24rem;
    font-size: 0.85rem;
  }

  .error p,
  .error pre {
    margin: 0;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tools form {
    display: inline;
  }

  .remove {
    border: none;
    background: none;
    padding: 0 0.25rem;
    color: var(--muted);
    line-height: 1;
  }

  .remove:hover {
    color: var(--error-text);
  }

  .when {
    min-width: 7rem;
  }

  .call {
    width: 100%;
  }

  .audit summary {
    cursor: pointer;
  }

  .audit details[open] summary {
    margin-bottom: 0.4rem;
  }

  .audit .hint {
    overflow-wrap: anywhere;
  }

  .outcome {
    white-space: nowrap;
  }

  .outcome.denied {
    color: var(--error-text);
  }

  .outcome.held,
  .outcome.gone {
    color: var(--warning-text);
  }
</style>
