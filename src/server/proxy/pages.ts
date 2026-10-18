// The proxy's own pages: errors, and the bare suffix. Plain HTML with inline
// styles; they are served on sandbox hostnames, so they load nothing.

export interface Page {
  /** A command that fixes the problem. */
  command?: string;
  /** A hint below the command. */
  hint?: string;
  message: string;
  /** The Panel URL to link to. */
  panelUrl: string;
  status: number;
  title: string;
}

export const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const ENTITIES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

export const escapeHtml = (text: string): string =>
  text.replaceAll(/["&'<>]/gu, (char) => ENTITIES[char] ?? char);

const STYLE = `
  :root { color-scheme: light dark; --muted: #666; --surface: #f3f3f3; }
  @media (prefers-color-scheme: dark) {
    :root { --muted: #9a9a9a; --surface: #262626; }
  }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1rem;
    font: 16px/1.5 system-ui, sans-serif; }
  h1 { font-size: 1.4rem; }
  pre { background: var(--surface); padding: 0.75rem 1rem; border-radius: 6px;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
`;

export const renderPage = ({
  command,
  hint,
  message,
  panelUrl,
  status,
  title,
}: Page): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Makak</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${command === undefined ? "" : `<pre>${escapeHtml(command)}</pre>`}
${hint === undefined ? "" : `<p class="muted">${escapeHtml(hint)}</p>`}
<p><a href="${escapeHtml(panelUrl)}">Open the Makak Panel</a></p>
<p class="muted">${status} · Makak reverse proxy</p>
</body>
</html>
`;
