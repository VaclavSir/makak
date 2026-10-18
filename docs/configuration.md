# Configuration

The Panel reads `~/.makak/config.json`, or the file given with `makak start --config <path>`. The file is optional; every setting has a default. Paths may start with `~/`, and must otherwise be absolute.

A full example, with the defaults where there are any:

```json
{
  "panel": {
    "hostname": "makakctl.test",
    "port": 7443,
    "tls": {
      "cert": "~/.makak/tls/panel.pem",
      "key": "~/.makak/tls/panel-key.pem"
    }
  },
  "proxy": {
    "suffixes": [".makak.test"],
    "listeners": [
      { "port": 443, "upstream": [443, 8000] },
      { "port": 35729, "upstream": [35729], "websocket": true }
    ],
    "tls": {
      "cert": "~/.makak/tls/sandboxes.pem",
      "key": "~/.makak/tls/sandboxes-key.pem"
    }
  },
  "envDir": "~/makak/envs",
  "handoffsDir": "~/makak/handoffs",
  "ssh": { "hostSuffix": ".sbx" },
  "stateDir": "~/.makak/state"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `panel.hostname` | `makakctl.test` | The Panel's own hostname. |
| `panel.port` | `7443` | The Panel's port, bound on `127.0.0.1` only. |
| `panel.tls.cert`, `panel.tls.key` | `~/.makak/tls/panel.pem`, `~/.makak/tls/panel-key.pem` | Certificate for `panel.hostname`; see [setup](setup.md). |
| `proxy.suffixes` | `[".makak.test"]` | Hostname suffixes for sandbox addresses: `feature-a.makak.test`. Each sandbox gets an address under every suffix. |
| `proxy.listeners` | `[]` | Ports the reverse proxy listens on. None means the proxy is off. |
| `proxy.listeners[].port` |  | The port in the address, e.g. `443` for `https://feature-a.makak.test/`. |
| `proxy.listeners[].upstream` |  | Sandbox ports to serve, in order of preference: the first one the sandbox publishes is used. When none is, the error page asks to publish the last. |
| `proxy.listeners[].websocket` | `false` | For WebSockets, such as livereload: the Panel shows its address as a `wss://` value to copy, not a link. The proxy serves it like any other listener, so a livereload server's script still loads over HTTP(S). |
| `proxy.tls.cert`, `proxy.tls.key` | `~/.makak/tls/sandboxes.pem`, `~/.makak/tls/sandboxes-key.pem` | Wildcard certificate for every suffix; see [setup](setup.md#reverse-proxy). Read only when there are listeners. |
| `envDir` | `~/makak/envs` | The env directory: the sandbox env files to choose from. |
| `handoffsDir` | `~/makak/handoffs` | Where each sandbox's handoff directory lives. |
| `ssh.hostSuffix` | `.sbx` | The suffix of the SSH host pattern `sbx setup ssh` wrote (`*.sbx` unless you passed `--alias`). The Panel shows `<sandbox>.sbx` as the SSH host. |
| `stateDir` | `~/.makak/state` | Where the Panel keeps its own data, such as sandbox notes. |

The env directory and handoffs are not implemented yet; their settings are validated now so the file format is stable.

### Listener ports

A listener on a port below 1024, such as 443, binds the wildcard address: macOS lets a normal user bind those ports there, and nowhere else. It still serves loopback peers only, dropping any other connection; expect the macOS firewall to ask about incoming connections on the first start, and deny them. Other listeners bind `127.0.0.1`.

`upstream` exists because the port in the address and the port in the sandbox needn't match. `{ "port": 443, "upstream": [443, 8000] }` serves the sandbox's own 443 if it publishes one, and its 8000 otherwise, so a dev server on 8000 is reachable on the standard HTTPS port. The proxy only sees published ports, not what listens in the sandbox: a sandbox that serves 443 must publish it, or the address quietly goes to its 8000.

## Validation

`makak start` refuses to start on an invalid file, and lists every problem. Beyond types and ranges, it checks that:

- **The Panel is on its own domain.** `panel.hostname` must not be under any sandbox suffix, nor share its last two labels with one. A sandbox must never be able to share a site with the Panel. The two-label rule is a simple stand-in for the public suffix list, enough for `.test` and ordinary company domains.
- **The Panel hostname is a real name.** At least two labels, lower case, and not an IP address or `localhost`.
- **No suffix is listed twice.**
- **Ports don't collide.** No two listeners, and no listener and the Panel, share a port.
- **There are no unknown keys**, so a typo fails instead of being ignored.
