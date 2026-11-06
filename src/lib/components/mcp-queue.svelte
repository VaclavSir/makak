<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import type { SubmitFunction } from "$app/forms";
  import McpArguments from "#lib/components/mcp-arguments.svelte";
  import { MCP } from "#lib/dependencies.ts";
  import { formatTime } from "#lib/format.ts";
  import { failureMessage } from "#lib/submit.ts";
  import type { Approval } from "#server/mcp/approvals.ts";

  // The tool calls waiting for the user, oldest first. Shown in the dialog
  // over any page, and on the approvals page, so it posts to that page's
  // action and shows its own failures, whichever page it is on.

  let {
    ondecided,
    pending,
  }: {
    /**
     * Called once a decision or dismissal went through and the queue was
     * reloaded.
     */
    ondecided?: () => void;
    pending: Approval[];
  } = $props();

  let busy = $state<string | undefined>();
  let message = $state("");

  const action = `${resolve("/mcp-panel/approvals")}?/decide`;
  const dismissAction = `${resolve("/mcp-panel/approvals")}?/dismiss`;

  /** Why no call waits for a request: a few words, and the whole story. */
  const stoppedNote = (stopped: Approval["stopped"]) => {
    if (stopped === "held") {
      return {
        long: "The hold ended, and the agent was told to make the same call again. Your decision applies to that call.",
        short: "Hold ended; the agent will ask again",
      };
    }
    if (stopped === "gone") {
      return {
        long: "The call was dropped before the hold ended: the agent gave up, and may never call again, e.g. a one-shot prompt that has ended. Your decision applies to its next call with the same arguments, if one comes; dismiss it if none will.",
        short: "The agent gave up waiting",
      };
    }
    return {
      long: "Your decision applies to its next call with the same arguments.",
      short: "The agent stopped waiting",
    };
  };

  const decide =
    (id: string): SubmitFunction =>
    () => {
      busy = id;
      message = "";
      return async ({ result }) => {
        busy = undefined;
        if (result.type === "failure") {
          message = failureMessage(result);
        } else if (result.type === "error") {
          message = String(result.error);
        }
        await invalidate(MCP, true);
        if (result.type === "success") {
          ondecided?.();
        }
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
          {@const note = stoppedNote(request.stopped)}
          <details class="hint stopped">
            <summary>{note.short}</summary>
            {note.long}
          </details>
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
          {#if !request.waiting}
            <button
              type="submit"
              formaction={dismissAction}
              disabled={busy !== undefined}
              title="Take it off the queue without allowing or denying it"
              >Dismiss</button
            >
          {/if}
        </form>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .hint {
    color: var(--muted);
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

  .tool {
    font-weight: 600;
  }

  .stopped summary {
    width: fit-content;
    cursor: pointer;
  }

  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
