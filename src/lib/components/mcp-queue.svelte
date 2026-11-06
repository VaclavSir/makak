<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";
  import McpArguments from "#lib/components/mcp-arguments.svelte";
  import { MCP } from "#lib/dependencies.ts";
  import { formatTime } from "#lib/format.ts";
  import type { Approval } from "#server/mcp/approvals.ts";

  // The tool calls waiting for the user, oldest first. Shown in the dialog
  // over any page, and on the approvals page, so it posts to that page's
  // action and shows its own failures, whichever page it is on.

  let { pending }: { pending: Approval[] } = $props();

  let busy = $state<string | undefined>();
  let message = $state("");

  const action = `${resolve("/mcp-panel/approvals")}?/decide`;

  const decide =
    (id: string): SubmitFunction =>
    () => {
      busy = id;
      message = "";
      return async ({ result }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = String(result.data?.message ?? "It didn't work.");
        } else if (result.type === "error") {
          message = String(result.error);
        }
        await invalidate(MCP, true);
      };
    };
</script>

{#if message !== ""}
  <p class="error" role="alert">{message}</p>
{/if}
{#if pending.length === 0}
  <p class="hint">No tool calls are waiting.</p>
{:else}
  <ul class="queue">
    {#each pending as request (request.id)}
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
        <form method="POST" {action} use:enhance={decide(request.id)}>
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

  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
