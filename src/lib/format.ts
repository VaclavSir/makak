const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A timestamp in the viewer's locale and time zone. The Panel and its browser
 * run on the same machine, so server and client render the same text.
 */
export const formatTime = (iso: string | undefined): string | undefined => {
  if (iso === undefined) {
    return undefined;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
};
