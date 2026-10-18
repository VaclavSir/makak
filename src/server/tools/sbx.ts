import * as z from "zod";

import { CommandError } from "./exec.ts";

/** A sandbox port published on the host. */
export interface PublishedPort {
  hostIp: string;
  hostPort: number;
  /** As reported, e.g. `tcp4`. */
  protocol: string;
  sandboxPort: number;
}

/** A sandbox as `sbx ls --json` reports it. */
export interface Sandbox {
  agent: string | undefined;
  createdAt: string | undefined;
  id: string;
  lastUsedAt: string | undefined;
  name: string;
  ports: PublishedPort[];
  /** As reported, e.g. `running` or `stopped`. Not an enum: sbx may add more. */
  status: string;
  workspaces: string[];
}

// The format is undocumented. Only what the Panel can't do without is
// required, and unknown fields are dropped, so additions don't break us.
const portSchema = z
  .object({
    host_ip: z.string(),
    host_port: z.number().int(),
    protocol: z.string(),
    sandbox_port: z.number().int(),
  })
  .transform((port): PublishedPort => ({
    hostIp: port.host_ip,
    hostPort: port.host_port,
    protocol: port.protocol,
    sandboxPort: port.sandbox_port,
  }));

const listSchema = z.array(
  z
    .object({
      agent: z.string().optional(),
      created_at: z.string().optional(),
      id: z.string().min(1),
      last_used_at: z.string().optional(),
      name: z.string().min(1),
      // Absent when nothing is published.
      ports: z.array(portSchema).default([]),
      status: z.string().min(1),
      workspaces: z.array(z.string()).default([]),
    })
    .transform((entry): Sandbox => ({
      agent: entry.agent,
      createdAt: entry.created_at,
      id: entry.id,
      lastUsedAt: entry.last_used_at,
      name: entry.name,
      ports: entry.ports,
      status: entry.status,
      workspaces: entry.workspaces,
    }))
);

export const parseSandboxList = (stdout: string): Sandbox[] => {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new CommandError("`sbx ls --json` did not print valid JSON", {
      cause: error,
    });
  }
  const result = listSchema.safeParse(json);
  if (!result.success) {
    throw new CommandError(
      `Unexpected \`sbx ls --json\` output:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

export const FAKE_SANDBOXES: readonly Sandbox[] = [
  {
    agent: "claude",
    createdAt: "2026-10-18T07:39:55Z",
    id: "00000000-0000-4000-8000-000000000001",
    lastUsedAt: "2026-10-18T15:21:55Z",
    name: "claude-makak",
    ports: [
      {
        hostIp: "127.0.0.1",
        hostPort: 7443,
        protocol: "tcp4",
        sandboxPort: 7443,
      },
    ],
    status: "running",
    workspaces: ["/Users/me/Projects/makak", "/Users/me/Projects/notes"],
  },
  {
    agent: "codex",
    createdAt: "2026-10-01T09:12:00Z",
    id: "00000000-0000-4000-8000-000000000002",
    lastUsedAt: "2026-10-17T18:03:41Z",
    name: "feature-a",
    ports: [
      {
        hostIp: "127.0.0.1",
        hostPort: 51_234,
        protocol: "tcp4",
        sandboxPort: 8000,
      },
      {
        hostIp: "127.0.0.1",
        hostPort: 51_235,
        protocol: "tcp4",
        sandboxPort: 35_729,
      },
    ],
    status: "running",
    workspaces: ["/Users/me/Projects/shop"],
  },
  {
    agent: "claude",
    createdAt: "2026-07-24T21:30:06Z",
    id: "00000000-0000-4000-8000-000000000003",
    lastUsedAt: "2026-07-24T21:30:06Z",
    name: "old-experiment",
    ports: [],
    status: "stopped",
    workspaces: ["/Users/me/Projects/experiment"],
  },
];
