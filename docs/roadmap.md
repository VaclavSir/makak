# Roadmap

A high-level plan, split into iterations that each leave the Panel usable. Scope and order will change as we learn. Implementation details belong in the docs for each feature, written when the feature is built.

## 0. Foundations

**Status: done.** See [architecture](architecture.md) and [setup](setup.md).

A running, secured, empty Panel.

- SvelteKit app with a custom Node server, so the proxy listeners can share the process later.
- `makak start`: load the config, start the server, open the browser with a one-time token.
- Auth: token exchange, session cookie, `Origin`/`Host` checks, loopback-only binding, a Panel hostname separate from the sandbox suffixes.
- Config file covering the Panel hostname, sandbox suffixes, listener ports, and the env and handoff directories.
- Adapter layer for `sbx`/`git`, with a fake implementation for development and tests.
- Test setup and CI-runnable checks.

**Done when:** `makak start` opens an authenticated, empty Panel, and requests from a wrong origin, a wrong host or another machine are rejected.

## 1. Sandbox overview (read-only)

Replaces `sbx ls` and a notepad.

**Status: done.** Checked against a real `sbx` on 2026-10-18.

- Sidebar of all sandboxes, with status, auto-refreshed, ordered by creation, last use or name, as chosen in the browser.
- Overview: published ports, workspace, copyable terminal commands (`sbx run`, `sbx exec`), SSH host.
- Notes per sandbox, the first Panel-side metadata, stored on the host.
- Panel-created sandboxes marked as managed; all others shown as unmanaged.

**Done when:** every sandbox on the host is visible, with everything needed to connect to it.

## 2. Reverse proxy

Stable URLs instead of ephemeral host ports.

**Status: done.** Checked against a real `sbx` on 2026-10-18.

- Configurable listeners, each mapping to an ordered list of candidate container ports.
- Hostname routing by configurable suffixes (longest match wins), HTTP/HTTPS sniffing, WebSocket pass-through, HSTS stripping.
- Opt-in elevation: TLS in front of named HTTP ports, for a secure context.
- Each sandbox has several URLs: one per suffix × listener port, each `https` or `wss` (e.g. livereload).
- Error pages that name the problem and show the command that fixes it.
- All of a sandbox's URLs listed in its overview: `https` ones as links, `wss` ones as copyable values. The Panel takes the place of the separate index page.
- Setup guide for dnsmasq, resolver files and mkcert.

**Done when:** two sandboxes serving the same port are reachable side by side under their own hostnames, including livereload.

## 3. Sandbox lifecycle

Create sandboxes from the Panel, reproducibly.

**Status: done.** Checked against a real `sbx` on 2026-10-20. See [env files](env-files.md).

- Env directory discovery, with the create form generated from the env files' `args:` declarations.
- `sbx env plan` shown before applying.
- The exact file set and args recorded and replayed for start, stop and remove.
- Creating a sandbox from an existing sandbox's config.
- Passive warnings for workflow deviations: writable extra mounts, a workspace that isn't a clone.

**Done when:** a sandbox can be created, stopped, started and removed entirely from the Panel, and recreated identically later.

## 4. Git

No work is lost without warning.

**Status: done.** Checked against a real `sbx` on 2026-10-20. See [Git](architecture.md#git).

- Branches read from sbx's own copy, `refs/sandboxes/<sandbox>/*`, which it keeps while the sandbox is stopped and after it is removed; the Panel copies the latest commits itself before stop and remove.
- Status: current branch, and how it compares to the host and origin.
- Actions: copy the sandbox's latest commits and fetch origin, bring a branch to the host, push to origin (optionally `--force-with-lease`).
- The remove confirmation lists the commits on no host branch, tag or other remote.

**Done when:** removing a sandbox can never silently lose a commit.

## 5. Runs

Non-interactive commands and prompts without a terminal.

**Status: done.** Checked against a real `sbx` on 2026-10-20. See [runs](architecture.md#runs).

- In-sandbox run helper, passed by the Panel with every `sbx exec`, that runs commands detached and records the command, PID, log and exit code.
- Commands configured per project, `package.json` scripts, arbitrary commands, and one-shot agent prompts.
- Output streamed to the browser, with status, stop and rerun. Survives Panel restarts.
- Runs open in tabs on the sandbox page, and a rerun reuses its tab; every run is listed under History.

**Done when:** `npm start` can be launched, watched, stopped and rerun from the Panel, and is still visible after the Panel restarts.

## 6. MCP approval proxy

The only gate on the MCP channel.

- One endpoint per server, on the Panel's domain, shared by every sandbox, with a token per server. Calls aren't attributed to sandboxes: the gateway can't say which one calls.
- Allowlisted tools pass through; others are held until approved or denied, and the agent is told to call again when nobody decided in time.
- Global approval queue: readable payloads, **allow once** / **always allow**, and a notification while anything is pending.
- Audit log of all calls.
- Registering each server with sbx once, from the MCP page, with its token in an sbx secret, and its registration's state from `sbx mcp ls`.
- Checking each server from the Panel, its last error, and its tools listed with allow toggles.
- Loading and unloading servers from the sandbox page and the create form, with `sbx mcp load`.
- Local servers: the Panel runs a `command` itself, one process per gateway session, and serves it like a remote one.

**Done when:** a mutating GitLab tool call from a sandbox waits for approval in the Panel, and read-only calls go straight through.

## 7. Cleanup and hardening

- Warning for sandboxes that can reach the forge, read from `sbx policy ls`.
- Complete teardown: env, per-sandbox MCP registrations and their secrets.
- Orphan sweep on start and on demand, reporting config residue and unremoved work separately.
- Warning when a new sandbox reuses a removed one's name while `refs/sandboxes/<name>/` holds commits no branch has: sbx may overwrite that copy.
- Handoff directories: per-sandbox creation, preview, and copying between sandboxes.

## Later

Candidates, not commitments:

- sbx network-approval queue alongside the MCP queue.
- Editing a running sandbox's network policy.
- OS notifications or a badge for pending approvals.
- Merge request review flow.
- Signing a browser in again without restarting the Panel, e.g. `makak open` talking to the running instance.
