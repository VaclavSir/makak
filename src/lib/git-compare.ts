// How a sandbox's branch compares with the host's or origin's branch of the
// same name: briefly for the table, and in full for its tooltip.

interface Comparison {
  /** Commits the sandbox has that the other branch hasn't. */
  ahead: number;
  /** Commits the other branch has that the sandbox hasn't. */
  behind: number;
  sha: string;
}

const commits = (count: number) =>
  `${count} ${count === 1 ? "commit" : "commits"}`;

const capitalized = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Briefly: "same", "2 ahead, 1 behind", or "none" without a branch. */
export const summarize = (comparison?: Comparison): string => {
  if (comparison === undefined) {
    return "none";
  }
  const { ahead, behind } = comparison;
  if (ahead === 0 && behind === 0) {
    return "same";
  }
  return [
    ahead > 0 ? `${ahead} ahead` : undefined,
    behind > 0 ? `${behind} behind` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};

/** In full, saying which side has the commits. */
export const explain = (
  branch: string,
  where: "the host" | "origin",
  comparison?: Comparison
): string => {
  if (comparison === undefined) {
    return `${capitalized(where)} has no ${branch} branch.`;
  }
  const { ahead, behind, sha } = comparison;
  const theirs = `${where}'s ${branch} (${sha.slice(0, 7)})`;
  if (ahead === 0 && behind === 0) {
    return `The sandbox's ${branch} is the same as ${theirs}.`;
  }
  return [
    ahead > 0
      ? `The sandbox has ${commits(ahead)} that ${theirs} doesn't.`
      : undefined,
    behind > 0
      ? `${capitalized(theirs)} has ${commits(behind)} that the sandbox doesn't.`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
};
