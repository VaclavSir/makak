import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.ts";
import { resolveServers } from "./servers.ts";

const { mcp } = parseConfig({
  mcp: {
    holdSeconds: 60,
    servers: [
      {
        allow: ["get_issue"],
        headers: { Authorization: { env: "GITLAB_TOKEN" }, "X-Team": "web" },
        name: "gitlab",
        url: "https://gitlab.test/mcp",
      },
      {
        headers: { Authorization: { env: "LINEAR_TOKEN" } },
        holdSeconds: 14_400,
        name: "linear",
        url: "https://linear.test/mcp",
      },
      {
        args: ["server.js"],
        command: "node",
        env: { DB: "notes", NOTES_TOKEN: { env: "NOTES_TOKEN" } },
        name: "notes",
      },
    ],
  },
});

describe(resolveServers, () => {
  it("reads headers from the environment, and the hold per server", () => {
    expect(
      resolveServers(mcp, {
        GITLAB_TOKEN: "Bearer g",
        LINEAR_TOKEN: "Bearer l",
        NOTES_TOKEN: "n",
      })
    ).toStrictEqual([
      {
        allow: ["get_issue"],
        headers: { Authorization: "Bearer g", "X-Team": "web" },
        holdMs: 60_000,
        local: undefined,
        name: "gitlab",
        oauth: undefined,
        url: "https://gitlab.test/mcp",
      },
      {
        allow: [],
        headers: { Authorization: "Bearer l" },
        holdMs: 14_400_000,
        local: undefined,
        name: "linear",
        oauth: undefined,
        url: "https://linear.test/mcp",
      },
      {
        allow: [],
        headers: {},
        holdMs: 60_000,
        local: {
          args: ["server.js"],
          command: "node",
          cwd: undefined,
          env: { DB: "notes", NOTES_TOKEN: "n" },
        },
        name: "notes",
        oauth: undefined,
        url: undefined,
      },
    ]);
  });

  it("names every variable that is missing", () => {
    expect(() => resolveServers(mcp, { GITLAB_TOKEN: "" })).toThrow(
      /GITLAB_TOKEN \(the Authorization header of gitlab\), LINEAR_TOKEN .*, NOTES_TOKEN \(the NOTES_TOKEN variable of notes\)/u
    );
  });
});
