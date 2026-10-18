# Makak Panel

A local web panel for running AI coding agents in [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) safely and conveniently.

One command, `makak start`, brings up a single process that provides:

- **Sandbox management** - list, create, start, stop and remove sandboxes; notes, copyable terminal and SSH commands, links to the sandbox's apps.
- **Runs** - non-interactive commands (`npm start`, `npm test`, …) and one-shot agent prompts, with streamed output, status and stop/rerun.
- **Git mirroring** - sandbox branches continuously mirrored to the host, so no work ever exists only inside a sandbox.
- **Reverse proxy** - stable URLs for each sandbox, whatever host port `sbx` happened to publish. A sandbox can have several, one per configured suffix and listener port, served as `https` or `wss` (e.g. `https://feature-a.makak.test:8000`, `wss://feature-a.makak.test:35729`).
- **MCP approval proxy** - wraps upstream MCP servers; allowlisted tools pass through, everything else waits for the user's approval in the Panel.

It is built around the [Makak Workflow](docs/workflow.md): sandboxes in clone mode, and every outward mutation (pushes, forge comments, chat posts) approved by a human. The workflow's guarantees come from `sbx` configuration, not from the Panel, so they hold even when working straight from a terminal.

The Panel is reachable only from the machine it runs on.

## Development

Requires Node.js 22.18 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

See [AGENTS.md](AGENTS.md) for the other commands and the ground rules.

## Status

Early development. See [docs/roadmap.md](docs/roadmap.md).
