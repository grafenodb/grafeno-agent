#!/bin/sh
# Escape attempts against grafeno-sandbox, as an unprivileged user.
# Usage: escape-test.sh /path/to/grafeno-sandbox
# Each check prints PASS or FAIL; the exit status is the number of failures.
set -u
GS="$1"
fails=0
work="$(mktemp -d)"
secret="$(mktemp -d)"
echo "top secret" > "$secret/key"
chmod 600 "$secret/key"
tmp="$(mktemp -d)"

run() {
  # The system read-only, the work folder and a private temp writable, no network.
  "$GS" --report-fd 3 --ro /usr --ro /bin --ro /lib --ro /lib64 --ro /etc --ro /dev --rw /dev/null \
    --rw "$work" --rw "$tmp" --no-network --memory 268435456 --cpu 5 --procs 64 --files 256 \
    "$@" 3>"$tmp/report.json"
}

check() {
  name="$1"
  shift
  if "$@"; then echo "PASS $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}

expect_ok() { run -- sh -c "$1" >/dev/null 2>&1; }
expect_denied() { ! run -- sh -c "$1" >/dev/null 2>&1; }

check "runs a command" expect_ok "true"
check "writes in the work folder" expect_ok "echo hi > '$work/ok' && test -s '$work/ok'"
check "cannot read a file outside what it may read" expect_denied "cat '$secret/key'"
check "cannot list a folder outside what it may read" expect_denied "ls '$secret'"
check "cannot write outside the work folder" expect_denied "echo x > '$secret/new'"
check "cannot write the system" expect_denied "echo x > /etc/grafeno-test"
check "cannot reach the network" expect_denied "exec 3<>/dev/tcp/1.1.1.1/80"
check "cannot make a user namespace" expect_denied "unshare -U true"
check "cannot mount" expect_denied "mount -t tmpfs none '$work'"
check "a fork bomb is stopped" expect_denied "i=0; while [ \$i -lt 200 ]; do sleep 30 & i=\$((i+1)); done; wait"
check "a CPU loop is stopped" expect_denied "while :; do :; done"
check "too much memory is refused" expect_denied "head -c 400000000 /dev/zero | tr '\\0' 'x' | sort > /dev/null"
check "says what it applied" grep -q '"landlockFs":1' "$tmp/report.json"
cat "$tmp/report.json"
# Nothing left running.
sleep 1
left="$(ps -eo args | grep -c '[s]leep 30' || true)"
check "nothing is left running" test "$left" = "0"
rm -rf "$work" "$secret" "$tmp"
exit "$fails"
