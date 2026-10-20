interface Named {
  id: string;
  name: string;
}

/**
 * The sandbox a page loaded, as it is now in the sidebar's polled list.
 * `replaced` when its name now belongs to another sandbox; `sandbox` is
 * undefined then, and when it no longer exists. Without a list, because sbx
 * can't be reached, it is the sandbox as loaded.
 */
export const liveSandbox = <T extends Named>(
  loaded: T,
  listed?: readonly T[]
): { replaced: boolean; sandbox: T | undefined } => {
  const current =
    listed === undefined
      ? loaded
      : listed.find(({ name }) => name === loaded.name);
  const replaced = current !== undefined && current.id !== loaded.id;
  return { replaced, sandbox: replaced ? undefined : current };
};
