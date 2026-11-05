<script lang="ts">
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "$app/forms";
  import McpArguments from "#lib/components/mcp-arguments.svelte";
  import { formatTime } from "#lib/format.ts";
  import { argumentsSummary, formatHold, OUTCOME_LABELS } from "#lib/mcp.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let busy = $state<string | undefined>();
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
      </dl>

      <h4>Tools</h4>
      {#if server.tools.length === 0}
        <p class="hint">
          {server.check?.tools === 0
            ? "The server lists no tools."
            : "None known: a successful check lists them. Until a tool is allowed, every call to it asks."}
        </p>
      {:else}
        <ul class="tools">
          {#each server.tools as tool (tool.name)}
            <li>
              <div class="tool-name">
                <code>{tool.name}</code>
                {#if tool.readOnly}
                  <span
                    class="badge"
                    title="The server says this tool changes nothing. That's its claim, not a guarantee."
                    >read-only</span
                  >
                {/if}
                {#if !tool.listed}
                  <span class="hint">not listed by the server</span>
                {/if}
              </div>
              <div class="tool-allowed">
                {#if tool.allowed === "config"}
                  <span class="allowed">Allowed by the config</span>
                {:else if tool.allowed === "always"}
                  <form method="POST" action="?/disallow" use:enhance>
                    <input type="hidden" name="server" value={server.name} />
                    <input type="hidden" name="tool" value={tool.name} />
                    <span class="allowed">Allowed</span>
                    <button type="submit" title="Ask about every call again"
                      >Ask</button
                    >
                  </form>
                {:else}
                  <form method="POST" action="?/allow" use:enhance>
                    <input type="hidden" name="server" value={server.name} />
                    <input type="hidden" name="tool" value={tool.name} />
                    <span class="hint">Asks</span>
                    <button
                      type="submit"
                      title="Let every sandbox's calls to it through without asking"
                      >Allow</button
                    >
                  </form>
                {/if}
              </div>
              {#if tool.description !== undefined}
                <p class="hint description" title={tool.description}>
                  {tool.description}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
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

  .server {
    margin-bottom: 1rem;
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

  h4 {
    margin: 0.9rem 0 0.4rem;
    font-size: 0.9rem;
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
  .tool-allowed form {
    display: inline;
    margin-left: 0.4rem;
  }

  dd button,
  .tools button {
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

  .error p,
  .error pre {
    margin: 0;
  }

  .tools {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tools li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 1rem;
    border-top: 1px solid var(--border);
    padding: 0.35rem 0;
  }

  .tool-allowed {
    white-space: nowrap;
  }

  .tool-allowed form {
    margin-left: 0;
  }

  .allowed {
    color: var(--accent);
  }

  .badge {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 0.3rem;
    color: var(--muted);
    font-size: 0.75rem;
  }

  /* Some servers write a page per tool: two lines here, all of it on hover. */
  .description {
    display: -webkit-box;
    grid-column: 1 / -1;
    margin: 0.15rem 0 0;
    overflow: hidden;
    font-size: 0.85rem;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
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
