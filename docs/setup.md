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
mkdir -p ~/.makak/tls
mkcert -cert-file ~/.makak/tls/panel.pem -key-file ~/.makak/tls/panel-key.pem makakctl.test
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

## Troubleshooting

- **"Not signed in"**: the session ended when the Panel restarted, or this is another browser. Restart `makak start` for a new login link.
- **"This login link is invalid or has expired"**: login links work once, within a minute. Restart `makak start`.
- **"Misdirected Request"**: the Panel was reached under a different hostname or port than configured, e.g. `localhost`. Use the URL `makak start` prints.
