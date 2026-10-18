import { describe, expect, it } from "vitest";

import { renderPage } from "./pages.ts";

describe(renderPage, () => {
  it("escapes everything it shows", () => {
    const html = renderPage({
      command: "sbx run --name '<b>'",
      message: "<script>alert(1)</script>",
      panelUrl: 'https://makakctl.test:7443/"><x',
      status: 404,
      title: "<i>",
    });
    expect(html).not.toMatch(/<(?:script|b|i|x)>/u);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://makakctl.test:7443/&quot;&gt;&lt;x"');
  });
});
