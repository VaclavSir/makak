# Setup

One-time setup on macOS. Commands assume the default Panel hostname, `makakctl.test`, and port, `7443`; adjust them if you change those in the [configuration](configuration.md).

## Requirements

- Node.js 22.18 or newer, with built-in TypeScript support (the official builds have it).
- pnpm, e.g. `corepack enable pnpm`.
- [mkcert](https://github.com/FiloSottile/mkcert), for a locally trusted certificate.
- `sbx`, for anything beyond an empty Panel. Without it, use `--fake`.

## 1. Resolve the Panel's hostname to loopback

The Panel is never served on `localhost` (see [architecture](architecture.md#why-not-localhost)), so it needs a hostname of its own:

```sh
echo "127.0.0.1 makakctl.test" | sudo tee -a /etc/hosts
```

If you already run dnsmasq for the sandbox suffixes, add `address=/makakctl.test/127.0.0.1` to its config instead.

## 2. Create a certificate

The session cookie is `Secure`, so the Panel is HTTPS-only:

```sh
mkcert -install
mkdir -p ~/makak/tls
mkcert -cert-file ~/makak/tls/panel.pem -key-file ~/makak/tls/panel-key.pem makakctl.test
```

## 3. Install and start

```sh
pnpm install
pnpm build
pnpm start
```

`pnpm start` runs `makak start`, which opens the browser with a one-time login link. That browser stays signed in until the Panel restarts.

To have `makak` on your PATH, run `pnpm link --global` in the checkout. Installing it as a package doesn't work: Node won't run TypeScript from `node_modules`.

For development, `pnpm dev` serves the app through Vite with hot reload, behind the same checks. Add `--fake` to use stand-ins for `sbx` and `git`: `pnpm dev --fake`.

## Reverse proxy

Optional: stable addresses like `https://feature-a.makak.test/` for the sandboxes' published ports. The commands assume the default suffix, `.makak.test`.

### 1. Resolve the suffix to loopback

`/etc/hosts` has no wildcards, so use dnsmasq, and point macOS's resolver for the suffix at it:

```sh
brew install dnsmasq
echo 'address=/makak.test/127.0.0.1' >> "$(brew --prefix)/etc/dnsmasq.conf"
sudo brew services start dnsmasq
sudo mkdir -p /etc/resolver
echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/makak.test
```

`address=/makak.test/` covers the name and everything under it. Check with `ping -c1 feature-a.makak.test`; `dig` and `nslookup` bypass `/etc/resolver`, so they don't show it.

For another suffix, add one more `address=` line and one more resolver file, named for the suffix without its leading dot. A suffix under a real domain, such as `.sbx.example.com`, works the same way, but override only a dedicated subdomain that doesn't exist in public DNS, never the company domain itself.

### 2. Create a certificate

One wildcard certificate covers every suffix. A wildcard matches one label, which is why sandbox addresses are exactly one label under the suffix:

```sh
mkcert -cert-file ~/makak/tls/sandboxes.pem -key-file ~/makak/tls/sandboxes-key.pem "*.makak.test"
```

List every suffix, as `"*.makak.test" "*.client.test"`, and create the certificate again whenever you add one.

### 3. Add listeners

The proxy is off until the [configuration](configuration.md) has listeners, for example:

```json
{
  "proxy": {
    "listeners": [
      { "port": 443, "upstream": [443, 8000] },
      { "port": 35729, "upstream": [35729], "websocket": true }
    ]
  }
}
```

Restart the Panel. Each sandbox's page lists its addresses, and says which ports to publish. A sandbox's server must listen on `0.0.0.0` inside the sandbox, or publishing its port reaches nothing.

The proxy passes HTTP and HTTPS through unchanged: an `https://` address needs a server that speaks HTTPS, and a plain HTTP server is reached as `http://feature-a.makak.test/`. Livereload follows the page: an HTTPS page needs `wss://`. To serve a plain HTTP server as `https://`, for a secure context, add an [elevate rule](configuration.md#elevation).

## Troubleshooting

- **"Not signed in"**: the session ended when the Panel restarted, or this is another browser. Restart `makak start` for a new login link.
- **"This login link is invalid or has expired"**: login links work once, within a minute. Restart `makak start`.
- **"Misdirected Request"**: the Panel was reached under a different hostname or port than configured, e.g. `localhost`. Use the URL `makak start` prints.
- **"Port not published"** on a sandbox address: run the command the page shows, on the host, then reload. The sandbox doesn't need to be recreated.
- **"Not an HTTPS server"**: the sandbox's server speaks plain HTTP. Use the `http://` address the page shows, or [elevate](configuration.md#elevation) the port.
- **A sandbox address won't resolve**: check that dnsmasq is running (`sudo brew services list`) and that `/etc/resolver/<suffix>` exists.
- **"Not secure" in the browser for a sandbox address** after adding a suffix: create the certificate again with every suffix, and restart the Panel.
- **A sandbox address keeps switching to `https://`**: the browser remembered HSTS from an earlier server. The proxy removes HSTS headers, but a policy already stored has to be deleted at `chrome://net-internals/#hsts`.
