/**
 * The size the browser shows a run at, passed to it as COLUMNS and LINES.
 * Runs get no terminal: tools that check for one print plain output, and
 * the browser's terminal shows the progress bars and colours of the rest.
 */
export const RUN_COLUMNS = 120;
export const RUN_ROWS = 40;

/** What a run id may be; the run helper checks the same. */
export const RUN_ID = /^[A-Za-z0-9-]+$/u;
