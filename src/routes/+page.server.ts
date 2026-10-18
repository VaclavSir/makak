import { getPanelContext } from "#server/context.ts";

import type { PageServerLoad } from "./$types";

const describe = async (version: () => Promise<string>) => {
  try {
    return await version();
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
};

export const load: PageServerLoad = async () => {
  const { tools } = getPanelContext();
  const [git, sbx] = await Promise.all([
    describe(tools.git.version),
    describe(tools.sbx.version),
  ]);
  return { git, sbx };
};
