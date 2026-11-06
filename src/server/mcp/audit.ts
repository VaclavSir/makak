import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import * as z from "zod";

// Every tool call through the MCP proxy and what was decided about it, one
// JSON object per line, in `<stateDir>/mcp-audit.jsonl`. Appended only. A
// call is written before the server sees it, so its answer, the start of
// it, is a line of its own, written once the answer is complete.

const entrySchema = z.object({
  arguments: z.unknown(),
  at: z.string(),
  /** Decided before this call came, on a call that had stopped waiting. */
  earlier: z.boolean().default(false),
  /** Names the call for its response. Older entries have none. */
  id: z.string().optional(),
  /** How long the call waited to be let through or answered. */
  ms: z.number(),
  /**
   * - `allowed`: on the allowlist.
   * - `approved`, `denied`: by the user.
   * - `held`: nobody decided in time; the agent was told to ask again.
   * - `gone`: the caller hung up while it was held.
   */
  outcome: z.enum(["allowed", "approved", "denied", "gone", "held"]),
  /** The approval request, for calls that needed one. */
  request: z.string().optional(),
  server: z.string(),
  tool: z.string(),
});

const responseSchema = z.object({
  at: z.string(),
  /** Who answered: the server, or the Panel, for a call it didn't make. */
  by: z.enum(["panel", "server"]),
  /** The `id` of the call. */
  call: z.string(),
  error: z.boolean(),
  text: z.string(),
  truncated: z.boolean(),
  type: z.literal("response"),
});

export type AuditEntry = z.input<typeof entrySchema>;
export type AuditResponse = Omit<z.input<typeof responseSchema>, "type">;
export type AuditRecord = z.output<typeof entrySchema> & {
  response?: Omit<AuditResponse, "call">;
};

export interface Audit {
  record: (entry: AuditEntry) => Promise<void>;
  /** Records the answer to a call recorded before. */
  respond: (response: AuditResponse) => Promise<void>;
  /** The last `limit` entries, newest first; only the server's, if given. */
  recent: (limit: number, server?: string) => Promise<AuditRecord[]>;
}

export const createAudit = (stateDir: string): Audit => {
  const file = path.join(stateDir, "mcp-audit.jsonl");

  const append = async (line: unknown) => {
    await mkdir(stateDir, { recursive: true });
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };

  return {
    recent: async (limit, server) => {
      let text: string;
      try {
        text = await readFile(file, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      const records: AuditRecord[] = [];
      // Newest first, so a call's response comes before the call.
      const responses = new Map<string, AuditRecord["response"]>();
      // A line cut short, or edited by hand, is skipped rather than fatal.
      for (const line of text.split("\n").toReversed()) {
        if (records.length >= limit) {
          break;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          const answer = responseSchema.safeParse(parsed);
          if (answer.success) {
            const { call, type: _, ...response } = answer.data;
            responses.set(call, response);
            continue;
          }
          const record: AuditRecord = entrySchema.parse(parsed);
          const response =
            record.id === undefined ? undefined : responses.get(record.id);
          if (response !== undefined) {
            record.response = response;
          }
          if (server === undefined || record.server === server) {
            records.push(record);
          }
        } catch {
          // Skipped.
        }
      }
      return records;
    },
    record: async (entry) => {
      await append(entry);
    },
    respond: async (response) => {
      await append({ type: "response", ...response });
    },
  };
};
