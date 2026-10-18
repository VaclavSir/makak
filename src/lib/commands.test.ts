import { describe, expect, it } from "vitest";

import { publishCommand, sandboxCommands, shellQuote } from "./commands.ts";

describe(shellQuote, () => {
  it.each([
    ["claude-makak", "claude-makak"],
    ["feature_a.2", "feature_a.2"],
    ["a b", "'a b'"],
    ["$(touch x)", "'$(touch x)'"],
    ["it's", `'it'\\''s'`],
    ["=ls", "'=ls'"],
    ["a=b", "a=b"],
    ["", "''"],
  ])("quotes %j as %s", (word, quoted) => {
    expect(shellQuote(word)).toBe(quoted);
  });
});

describe(sandboxCommands, () => {
  it("builds the terminal commands and the SSH host", () => {
    expect(sandboxCommands("claude-makak", ".sbx")).toStrictEqual([
      { label: "Attach the agent", value: "sbx run --name claude-makak" },
      { label: "Open a shell", value: "sbx exec -it claude-makak bash" },
      { label: "SSH host", value: "claude-makak.sbx" },
    ]);
  });

  it("quotes a name the shell would interpret", () => {
    const [attach] = sandboxCommands("a;b", ".sbx");
    expect(attach?.value).toBe("sbx run --name 'a;b'");
  });

  it("uses the configured SSH suffix", () => {
    expect(sandboxCommands("a", ".box").at(-1)?.value).toBe("a.box");
  });
});

describe(publishCommand, () => {
  it("quotes the name", () => {
    expect(publishCommand("a b")).toBe("sbx ports 'a b' --publish <port>");
  });

  it("fills in the port when given", () => {
    expect(publishCommand("a", 8000)).toBe("sbx ports a --publish 8000");
  });
});
