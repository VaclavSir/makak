import { describe, expect, it } from "vitest";

import { CommandError } from "./exec.ts";
import { parseMcpList, parseSandboxList } from "./sbx.ts";

// Real output of sbx, with paths shortened.
const SAMPLE = `[
  {
    "name": "claude-makak",
    "id": "49e4bb3f-5a83-4333-8e34-1c44531df82f",
    "agent": "claude",
    "status": "running",
    "last_used_at": "2026-10-18T15:25:19.330116Z",
    "ports": [
      {
        "host_ip": "127.0.0.1",
        "host_port": 7443,
        "sandbox_port": 7443,
        "protocol": "tcp4"
      }
    ],
    "workspaces": ["/Users/me/Projects/makak", "/Users/me/Projects/SBX"],
    "created_at": "2026-10-18T07:39:55Z"
  },
  {
    "name": "claude-Brump",
    "id": "68969ffc-6cb7-4f7a-a862-ace344293d96",
    "agent": "claude",
    "status": "stopped",
    "last_used_at": "2026-07-24T21:30:06Z",
    "workspaces": ["/Users/me/Projects/Brump"],
    "created_at": "2026-07-24T21:30:06Z"
  }
]`;

describe(parseSandboxList, () => {
  it("parses real sbx output", () => {
    expect(parseSandboxList(SAMPLE)).toStrictEqual([
      {
        agent: "claude",
        createdAt: "2026-10-18T07:39:55Z",
        id: "49e4bb3f-5a83-4333-8e34-1c44531df82f",
        lastUsedAt: "2026-10-18T15:25:19.330116Z",
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
        workspaces: ["/Users/me/Projects/makak", "/Users/me/Projects/SBX"],
      },
      {
        agent: "claude",
        createdAt: "2026-07-24T21:30:06Z",
        id: "68969ffc-6cb7-4f7a-a862-ace344293d96",
        lastUsedAt: "2026-07-24T21:30:06Z",
        name: "claude-Brump",
        ports: [],
        status: "stopped",
        workspaces: ["/Users/me/Projects/Brump"],
      },
    ]);
  });

  it("tolerates missing optional fields and unknown ones", () => {
    const [sandbox] = parseSandboxList(
      '[{"name": "a", "id": "1", "status": "creating", "new_field": true}]'
    );
    expect(sandbox).toStrictEqual({
      agent: undefined,
      createdAt: undefined,
      id: "1",
      lastUsedAt: undefined,
      name: "a",
      ports: [],
      status: "creating",
      workspaces: [],
    });
  });

  it.each([
    ["not JSON", "No sandboxes found", /valid JSON/u],
    ["no name", '[{"id": "1", "status": "running"}]', /Unexpected/u],
    ["not a list", '{"sandboxes": []}', /Unexpected/u],
  ])("rejects %s", (_, stdout, message) => {
    expect(() => parseSandboxList(stdout)).toThrow(CommandError);
    expect(() => parseSandboxList(stdout)).toThrow(message);
  });
});

// Real output of `sbx mcp ls --json`, one entry cut.
const MCP_SAMPLE = `[
  {
    "name": "gitlab",
    "transport": "remote http",
    "status": "ready",
    "type": "remote",
    "detail": "custom headers",
    "gateway": {
      "name": "LOCAL",
      "local": true,
      "operator": "managed by you",
      "decision": "local",
      "signed_in_as": "me"
    }
  },
  {
    "name": "probe",
    "transport": "remote http",
    "status": "needs-secret",
    "type": "remote",
    "detail": "1 header secret not set",
    "next_step": "sbx secret set mcp:probe:token",
    "gateway": {
      "name": "LOCAL",
      "local": true,
      "operator": "managed by you",
      "decision": "local",
      "signed_in_as": "me"
    }
  }
]`;

describe(parseMcpList, () => {
  it("parses real sbx output", () => {
    expect(parseMcpList(MCP_SAMPLE)).toStrictEqual([
      {
        detail: "custom headers",
        name: "gitlab",
        nextStep: undefined,
        status: "ready",
      },
      {
        detail: "1 header secret not set",
        name: "probe",
        nextStep: "sbx secret set mcp:probe:token",
        status: "needs-secret",
      },
    ]);
    expect(parseMcpList("[]")).toStrictEqual([]);
  });

  it("names the command when the output isn't what it should be", () => {
    expect(() => parseMcpList("nope")).toThrow(
      new CommandError("`sbx mcp ls --json` did not print valid JSON")
    );
    expect(() => parseMcpList('[{"name":"x"}]')).toThrow(
      /Unexpected `sbx mcp ls --json` output/u
    );
  });
});
