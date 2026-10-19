#!/usr/bin/env node
import { parseArgs } from "node:util";

import { start } from "./start.ts";

const USAGE = `Usage: makak start [options]

Starts the Makak Panel and opens it in the browser.

Options:
  --config <path>  Config file (default: ~/makak/config.json)
  --dev            Serve the app through Vite, with hot reload
  --fake           Use fake sbx and git, for development without them
  --no-open        Print the login link instead of opening the browser
  -h, --help       Show this help
`;

const main = async () => {
  const { positionals, values } = parseArgs({
    allowNegative: true,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      dev: { default: false, type: "boolean" },
      fake: { default: false, type: "boolean" },
      help: { default: false, short: "h", type: "boolean" },
      open: { default: true, type: "boolean" },
    },
  });

  const [command] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "start" || positionals.length > 1) {
    throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
  }

  await start({
    configPath: values.config,
    dev: values.dev,
    fake: values.fake,
    open: values.open,
  });
};

try {
  await main();
} catch (error) {
  console.error(`makak: ${(error as Error).message}`);
  process.exit(1);
}
