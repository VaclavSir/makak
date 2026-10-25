import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import * as z from "zod";

// Every tool call through the MCP proxy and what was decided about it, one
// JSON object per line, in `<stateDir>/mcp-audit.jsonl`. Appended only.

const entrySchema = z.object({
  arguments: z.unknown(),
  at: z.string(),
  /** Decided before this call came, on a call that had stopped waiting. */
  earlier: z.boolean().default(false),
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
  sandbox: z.object({ id: z.string(), name: z.string() }),
  server: z.string(),
  tool: z.string(),
});

export type AuditEntry = z.input<typeof entrySchema>;
export type AuditRecord = z.output<typeof entrySchema>;

export interface Audit {
  record: (entry: AuditEntry) => Promise<void>;
  /** The last `limit` entries, newest first. */
  recent: (limit: number) => Promise<AuditRecord[]>;
}

export const createAudit = (stateDir: string): Audit => {
  const file = path.join(stateDir, "mcp-audit.jsonl");

  return {
    recent: async (limit) => {
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
      // A line cut short, or edited by hand, is skipped rather than fatal.
      for (const line of text.split("\n").toReversed()) {
        if (records.length >= limit) {
          break;
        }
        try {
          records.push(entrySchema.parse(JSON.parse(line)));
        } catch {
          // Skipped.
        }
      }
      return records;
    },
    record: async (entry) => {
      await mkdir(stateDir, { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    },
  };
};
