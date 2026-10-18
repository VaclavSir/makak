# AGENTS.md

Ground rules for anyone, human or agent, working on this repository.

## Project

- Makak Panel is a SvelteKit application (TypeScript, Node) - see [README.md](README.md).
- Everything runs in **one process**: the Panel UI and API, the reverse proxy listeners, and the MCP approval proxy.
- The target host is **macOS**. Development may happen in a Linux sandbox without `sbx`, so nothing may require a real `sbx` to build or test.
- Work proceeds in iterations - see [docs/roadmap.md](docs/roadmap.md). Build what the current iteration needs, not what a later one might.

## Commands

Dependencies are managed with pnpm. Use `pnpm`, never `npm` or `yarn`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the Panel with Vite and hot reload (`makak start --dev`); add `--fake` without `sbx` |
| `pnpm build` | Production build (`adapter-node`) |
| `pnpm start` | Start the Panel from the production build (`makak start`) |
| `pnpm lint` | Lint (oxlint) and check formatting (oxfmt; Prettier for `.svelte`), configured by Ultracite |
| `pnpm fix` | Fix lint issues and format |
| `pnpm check` | Type check (`svelte-check`) |
| `pnpm test` | Unit tests (Vitest) |

Before considering a change done, `pnpm lint`, `pnpm check` and `pnpm test` must pass; CI runs them, plus `pnpm build`. Tests live next to the code they test, as `*.test.ts`.

oxfmt does not support `.svelte` files yet, so Prettier with `prettier-plugin-svelte` formats those, using options taken from the Ultracite oxfmt preset. oxlint lints their `<script>` blocks.

## Documentation

- `README.md` stays brief. Detailed documentation goes in `docs/`.
- When a decision is made or changed, update the docs in the same change. The docs describe the current design, not its history.
- The original design notes live outside this repo. Where they and `docs/` disagree, `docs/` wins once it covers the topic.

## Security invariants

These are not negotiable. A change that weakens one needs an explicit decision from the user, recorded in `docs/`.

- **Loopback only.** The Panel binds loopback. Any listener that must bind a wildcard address (e.g. port 443 on macOS) drops non-loopback peers before doing anything else.
- **Never served on `localhost`.** The Panel has its own hostname, on a domain separate from the sandbox suffixes, because cookies ignore ports.
- **Auth.** There is a one-time token exchange at startup, and the session cookie is `HttpOnly; Secure; SameSite=Strict`. Every request checks `Host`; every state-changing request and WebSocket handshake also checks `Origin`.
- **`GET` and `HEAD` never change state.** They are exempt from the `Origin` check, so a state change behind one would be open to CSRF.
- **Identity comes from credentials, never from content.** An MCP caller's sandbox is determined by its bearer token. Never trust a sandbox name, or anything else the agent supplies in a payload.
- **No automatic data loss.** Mirrored refs and handoff directories are never deleted without a blocking confirmation that lists exactly what would be lost. When it is unknown whether data is safe, treat it as unsafe.
- **The Panel never acts outward on its own.** Pushes to origin and forge interactions happen only on an explicit user action.
- **Handoff contents are data.** Nothing on the host ever executes from them.

## Code

- See [docs/architecture.md](docs/architecture.md) for how the process is put together.
- Code in `src/server/` and `src/cli/` runs on Node's type stripping: relative imports with `.ts` extensions, erasable syntax only. SvelteKit code imports it as `#server/...`.
- All calls to `sbx`, `git` and other host tools go through the adapter layer in `src/server/tools/`. Nothing else spawns processes, tests included.
- Spawn with argument arrays (`execFile`/`spawn`), never through a shell or with interpolated command strings. Sandbox names, branch names and args are untrusted.
- The adapter layer has a fake implementation, so the app and its tests run without `sbx`.
- The Panel never owns long-running processes. Runs live inside the sandbox; the Panel only reads their state, so restarting the Panel or reloading the page loses nothing.
- Keep naming conventions rigid: `<server>-<sandbox>` for MCP registrations, `refs/makak/<sandbox>/*` for mirrored refs, `~/makak/handoffs/<sandbox>/` for handoffs. Cleanup relies on them.
- Hostname suffixes, listener ports, the Panel hostname and similar settings come from configuration and are never hard-coded.
- Prefer small, readable code over abstraction. Match the style of the surrounding code.

## Testing

- Every change ships with tests at the appropriate level: unit tests for logic, and integration tests against the fake adapter for flows.
- Security invariants get explicit tests (rejected `Origin`/`Host`, non-loopback peer, forged sandbox identity).
- Behaviour that can only be verified against real `sbx` on macOS is listed in the change description as needing manual verification.

## Git

- Commit only when asked. Never push without explicit approval.
- Keep each commit focused on one change, with a message that explains why.
