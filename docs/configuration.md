# Configuration

The Panel reads `~/makak/config.json`, or the file given with `makak start --config <path>`. The file is optional; every setting has a default. Paths may start with `~/`, and must otherwise be absolute.

By default everything the Panel reads and writes lives in one visible directory:

```text
~/makak/
├── config.json   this file
├── envs/         env files to create sandboxes from; see env files
├── handoffs/     one directory per sandbox
├── state/        the Panel's own data: notes, how each sandbox was created
└── tls/          certificates for the Panel and the reverse proxy
```

A full example, with the defaults where there are any:

```json
{
  "panel": {
    "hostname": "makakctl.test",
    "port": 7443,
    "tls": {
      "cert": "~/makak/tls/panel.pem",
      "key": "~/makak/tls/panel-key.pem"
    }
  },
  "proxy": {
    "suffixes": [".makak.test"],
    "listeners": [
      { "port": 443, "upstream": [443, 8000] },
      { "port": 35729, "upstream": [35729], "websocket": true }
    ],
    "elevate": [
      { "sandbox": "^client-", "port": 8000 },
      { "sandbox": "^client-", "port": 35729 }
    ],
    "tls": {
      "cert": "~/makak/tls/sandboxes.pem",
      "key": "~/makak/tls/sandboxes-key.pem"
    }
  },
  "mcp": {
    "holdSeconds": 240,
    "servers": [
      {
        "name": "gitlab",
        "url": "https://gitlab.example.com/api/v4/mcp",
        "headers": { "Authorization": { "env": "GITLAB_MCP_AUTHORIZATION" } },
        "allow": ["get_issue", "get_merge_request", "list_merge_requests"]
      }
    ]
  },
  "envDir": "~/makak/envs",
  "handoffsDir": "~/makak/handoffs",
  "runs": {
    "projects": [
      {
        "path": "~/Projects/shop",
        "commands": [
          { "label": "Start", "command": "npm start" },
          { "label": "Test", "command": "npm test" }
        ]
      }
    ]
  },
  "ssh": { "hostSuffix": ".sbx" },
  "stateDir": "~/makak/state"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `panel.hostname` | `makakctl.test` | The Panel's own hostname. |
| `panel.port` | `7443` | The Panel's port, bound on `127.0.0.1` only. |
| `panel.tls.cert`, `panel.tls.key` | `~/makak/tls/panel.pem`, `~/makak/tls/panel-key.pem` | Certificate for `panel.hostname`; see [setup](setup.md). |
| `proxy.suffixes` | `[".makak.test"]` | Hostname suffixes for sandbox addresses: `feature-a.makak.test`. Each sandbox gets an address under every suffix. |
| `proxy.listeners` | `[]` | Ports the reverse proxy listens on. None means the proxy is off. |
| `proxy.listeners[].port` |  | The port in the address, e.g. `443` for `https://feature-a.makak.test/`. |
| `proxy.listeners[].upstream` |  | Sandbox ports to serve, in order of preference: the first one the sandbox publishes is used. When none is, the error page asks to publish the last. |
| `proxy.listeners[].websocket` | `false` | For WebSockets, such as livereload: the Panel shows its address as a `wss://` value to copy, not a link. The proxy serves it like any other listener, so a livereload server's script still loads over HTTP(S). |
| `proxy.elevate` | `[]` | Sandbox ports served over TLS although the server inside speaks plain HTTP; see [elevation](#elevation). |
| `proxy.elevate[].sandbox` |  | A regular expression for the sandbox names the rule applies to, e.g. `^client-`. Unanchored, like any regular expression: `client` matches `my-client-2`. |
| `proxy.elevate[].port` | every port | The sandbox port, after the listener's `upstream` list is resolved: `8000`, not the `443` in the address. Must be in some listener's `upstream` list. Leave it out only for sandboxes with no HTTPS servers of their own. |
| `proxy.tls.cert`, `proxy.tls.key` | `~/makak/tls/sandboxes.pem`, `~/makak/tls/sandboxes-key.pem` | Wildcard certificate for every suffix; see [setup](setup.md#reverse-proxy). Read only when there are listeners. |
| `mcp.holdSeconds` | `240` | How long a tool call off the allowlist waits for your decision before the agent is told to call again; see [holds](#holds). |
| `mcp.servers` | `[]` | MCP servers sandboxes reach through the Panel's [approval proxy](architecture.md#mcp-proxy). |
| `mcp.servers[].name` |  | Lower-case letters, digits and underscores. Each sandbox's endpoint is `/mcp/<name>/<sandbox>`. |
| `mcp.servers[].url` |  | The server's Streamable HTTP endpoint. |
| `mcp.servers[].headers` | `{}` | Headers the Panel sends to the server, such as its credentials. A value is either the text itself or `{ "env": "NAME" }`, read from the Panel's environment at start, which keeps the secret out of this file. Give it a read-only token where the server allows it. |
| `mcp.servers[].allow` | `[]` | Tools that run without asking. _Always allow_ in the Panel adds to this list without editing the file. |
| `mcp.servers[].holdSeconds` | `mcp.holdSeconds` | The hold for this server. |
| `envDir` | `~/makak/envs` | The env directory: the `*.sbxenv.yaml` files to create sandboxes from; see [env files](env-files.md). |
| `handoffsDir` | `~/makak/handoffs` | Where each sandbox's handoff directory lives. |
| `runs.projects` | `[]` | Commands offered as buttons on the page of every sandbox with that project as a workspace; see [runs](architecture.md#runs). |
| `runs.projects[].path` |  | The project, as the sandbox's workspace path on the host. |
| `runs.projects[].commands` |  | `label` is the button's text; `command` is run with bash in the project's directory. |
| `ssh.hostSuffix` | `.sbx` | The suffix of the SSH host pattern `sbx setup ssh` wrote (`*.sbx` unless you passed `--alias`). The Panel shows `<sandbox>.sbx` as the SSH host. |
| `stateDir` | `~/makak/state` | Where the Panel keeps its own data: sandbox notes, and the env files and args each sandbox was created with. |

Handoffs are not implemented yet; the setting is validated now so the file format is stable.

### Holds

Claude Code gives up on a tool call that sends nothing for five minutes, and the sbx MCP gateway gives the Panel no way to send anything while it holds a call. So the default hold, four minutes, ends before that: the agent is told the call is waiting for approval, and to make it again. Making it again waits again, and once you approve it, the next identical call goes through.

A sandbox with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in its environment, as the [example base env file](../examples/envs/00-base.sbxenv.yaml) sets it, waits as long as the call is held. Raise `holdSeconds` for servers only such sandboxes use, e.g. to `14400` for four hours; Claude Code moves a call that takes over two minutes to the background, so the agent keeps working meanwhile.

### Listener ports

A listener on a port below 1024, such as 443, binds the wildcard address: macOS lets a normal user bind those ports there, and nowhere else. It still serves loopback peers only, dropping any other connection; expect the macOS firewall to ask about incoming connections on the first start, and deny them. Other listeners bind `127.0.0.1`.

`upstream` exists because the port in the address and the port in the sandbox needn't match. `{ "port": 443, "upstream": [443, 8000] }` serves the sandbox's own 443 if it publishes one, and its 8000 otherwise, so a dev server on 8000 is reachable on the standard HTTPS port. The proxy only sees published ports, not what listens in the sandbox: a sandbox that serves 443 must publish it, or the address quietly goes to its 8000.

### Elevation

The proxy normally passes the scheme through: an HTTP server is reached as `http://`, an HTTPS server as `https://`. But a plain HTTP page on a sandbox hostname is not a secure context, so service workers, `crypto.subtle` and `Secure` cookies stop working for it; on `http://localhost` they worked.

An elevate rule fixes that for the sandbox ports it names: the browser gets `https://`, the server inside keeps speaking plain HTTP, and `X-Forwarded-Proto: https` tells it which scheme to put in the URLs it generates. `http://` requests to the port are redirected to `https://`.

Elevate the livereload port too. An `https://` page can't open a `ws://` connection, so livereload needs `wss://`, which an elevated port provides. A server that speaks HTTPS itself must not be elevated; its error page says so.

## Validation

`makak start` refuses to start on an invalid file, and lists every problem. Beyond types and ranges, it checks that:

- **The Panel is on its own domain.** `panel.hostname` must not be under any sandbox suffix, nor share its last two labels with one. A sandbox must never be able to share a site with the Panel. The two-label rule is a simple stand-in for the public suffix list, enough for `.test` and ordinary company domains.
- **The Panel hostname is a real name.** At least two labels, lower case, and not an IP address or `localhost`.
- **No suffix is listed twice**, and no MCP server name.
- **Elevate rules are valid regular expressions**, and their ports are in some listener's `upstream` list.
- **Ports don't collide.** No two listeners, and no listener and the Panel, share a port.
- **There are no unknown keys**, so a typo fails instead of being ignored.
