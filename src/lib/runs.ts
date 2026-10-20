/**
 * The size the browser shows a run at, passed to it as COLUMNS and LINES.
 * Runs get no terminal: tools that check for one print plain output, and
 * the browser's terminal shows the progress bars and colours of the rest.
 */
export const RUN_COLUMNS = 120;
export const RUN_ROWS = 40;

/** What a run id may be; the run helper checks the same. */
export const RUN_ID = /^[A-Za-z0-9-]+$/u;

interface RunOutcome {
  exitCode: number | undefined;
  state: "exited" | "lost" | "running" | "stopped";
}

/** How a run is doing, in words. */
export const runLabel = ({ exitCode, state }: RunOutcome): string => {
  if (state === "running") {
    return "running";
  }
  if (state === "lost") {
    return "ended unrecorded";
  }
  if (state === "stopped") {
    return "stopped";
  }
  return exitCode === 0 ? "done" : `failed (${exitCode})`;
};

/** How a run is doing, as a colour: stopping it on purpose is fine. */
export const runTone = ({
  exitCode,
  state,
}: RunOutcome): "bad" | "ok" | "running" => {
  if (state === "running") {
    return "running";
  }
  return state === "stopped" || (state === "exited" && exitCode === 0)
    ? "ok"
    : "bad";
};
