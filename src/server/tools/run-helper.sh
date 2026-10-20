# makak-run: runs commands in a sandbox, detached, and keeps each one's
# command, process, log and exit code, so the Panel can show and stop them
# after it restarts. The Panel passes this script to
# `sh -c` on every call; nothing is installed.
#
#   start ID CWD COLS ROWS COMMAND
#                            runs COMMAND with bash, in CWD; COLUMNS and
#                            LINES tell it the size it is shown at
#   list                     one line per run, tab-separated; see below
#   stop ID                  TERM to its process group, then KILL after
#                            5 seconds
#   log ID OFFSET FOLLOW     the log from a byte offset; FOLLOW=1 waits
#                            for more until the run ends, or for five
#                            minutes
#   package CWD              the package manager, then package.json

set -eu

runs="$HOME/.local/state/makak/runs"

fail() {
  printf 'makak-run: %s\n' "$1" >&2
  exit 2
}

run_dir() {
  case "$1" in
    '' | *[!A-Za-z0-9-]*) fail "not a run id: $1" ;;
  esac
  dir="$runs/$1"
}

boot_id() {
  cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown
}

# Whether the run's process still runs. Its pid is meaningless after the
# sandbox restarts, which the boot id tells.
running() {
  [ -s "$1/pid" ] && [ "$(cat "$1/boot")" = "$(boot_id)" ] &&
    kill -0 "$(cat "$1/pid")" 2>/dev/null
}

command=${1:-}
[ $# -gt 0 ] && shift

case "$command" in
  start)
    [ $# -eq 5 ] || fail "usage: start ID CWD COLS ROWS COMMAND"
    run_dir "$1"
    for size in "$3" "$4"; do
      case "$size" in '' | *[!0-9]*) fail "not a size: $size" ;; esac
    done
    mkdir -p "$runs"
    mkdir "$dir" || fail "run $1 exists"
    printf '%s\n' "$5" > "$dir/cmd"
    printf '%s' "$2" > "$dir/cwd"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/started"
    boot_id > "$dir/boot"
    : > "$dir/log"
    # A session of its own, so it outlives `sbx exec`, waits for the command
    # and records its exit code. The command gets a session too, so stopping
    # its process group reaches everything it starts, but not this waiter.
    setsid sh -c '
      dir=$1
      if ! cd "$(cat "$dir/cwd")"; then
        printf "makak-run: cannot enter %s\n" "$(cat "$dir/cwd")" > "$dir/log"
        echo 1 > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
        exit
      fi
      COLUMNS=$2 LINES=$3 setsid bash -l "$dir/cmd" < /dev/null >> "$dir/log" 2>&1 &
      echo $! > "$dir/pid"
      status=0
      wait $! || status=$?
      echo "$status" > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
    ' makak-run "$dir" "$3" "$4" < /dev/null > /dev/null 2>&1 &
    # Stop works as soon as this returns.
    tries=0
    while [ ! -s "$dir/pid" ] && [ ! -f "$dir/exit" ] && [ $tries -lt 50 ]; do
      sleep 0.1
      tries=$((tries + 1))
    done
    ;;

  list)
    # ID, start time, state (running, exited, stopped or lost), exit code,
    # log size in
    # bytes, then the command and the directory in base64, so no character
    # in them can break the line.
    [ -d "$runs" ] || exit 0
    for dir in "$runs"/*; do
      [ -f "$dir/cmd" ] || continue
      code=
      if [ -f "$dir/exit" ]; then
        state=exited
        [ -f "$dir/stopped" ] && state=stopped
        code=$(cat "$dir/exit")
      elif running "$dir"; then
        state=running
      else
        state=lost
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${dir##*/}" \
        "$(cat "$dir/started")" "$state" "$code" \
        "$(wc -c < "$dir/log" | tr -d ' ')" \
        "$(base64 < "$dir/cmd" | tr -d '\n')" \
        "$(base64 < "$dir/cwd" | tr -d '\n')"
    done
    ;;

  stop)
    [ $# -eq 1 ] || fail "usage: stop ID"
    run_dir "$1"
    running "$dir" || exit 0
    pid=$(cat "$dir/pid")
    # Marked only if it was still there to stop, so a run that just ended on
    # its own keeps its exit code's meaning.
    kill -TERM "-$pid" 2>/dev/null || exit 0
    : > "$dir/stopped"
    tries=0
    while kill -0 "-$pid" 2>/dev/null && [ $tries -lt 50 ]; do
      sleep 0.1
      tries=$((tries + 1))
    done
    kill -KILL "-$pid" 2>/dev/null || true
    ;;

  log)
    [ $# -eq 3 ] || fail "usage: log ID OFFSET FOLLOW"
    run_dir "$1"
    case "$2" in '' | *[!0-9]*) fail "not an offset: $2" ;; esac
    [ -f "$dir/log" ] || fail "no run $1"
    from=$(($2 + 1))
    if [ "$3" = 1 ] && running "$dir"; then
      # At most five minutes, in case ending `sbx exec` doesn't end this; the
      # Panel follows on from where it got to.
      status=0
      timeout 300 tail -c "+$from" --pid="$(cat "$dir/pid")" -f "$dir/log" ||
        status=$?
      [ "$status" -eq 0 ] || [ "$status" -eq 124 ] || exit "$status"
      exit 0
    fi
    exec tail -c "+$from" "$dir/log"
    ;;

  package)
    [ $# -eq 1 ] || fail "usage: package CWD"
    cd "$1" || exit 0
    [ -f package.json ] || exit 0
    if [ -f pnpm-lock.yaml ]; then
      echo pnpm
    elif [ -f yarn.lock ]; then
      echo yarn
    elif [ -f bun.lockb ] || [ -f bun.lock ]; then
      echo bun
    else
      echo npm
    fi
    cat package.json
    ;;

  *)
    fail "unknown command: $command"
    ;;
esac
