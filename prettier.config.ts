// Prettier formats only .svelte files, which oxfmt does not support yet.
// Its options are taken from Ultracite's oxfmt preset, so both produce the same style.
import type { Config } from "prettier";
import ultracite from "ultracite/oxfmt";

const {
  arrowParens,
  bracketSameLine,
  bracketSpacing,
  endOfLine,
  printWidth,
  quoteProps,
  semi,
  singleQuote,
  tabWidth,
  trailingComma,
  useTabs,
} = ultracite;

const config: Config = {
  arrowParens,
  bracketSameLine,
  bracketSpacing,
  endOfLine,
  plugins: ["prettier-plugin-svelte"],
  printWidth,
  quoteProps,
  semi,
  singleQuote,
  tabWidth,
  trailingComma,
  useTabs,
};

export default config;
