#!/bin/sh
# Builds the helper and runs the sandbox's tests as an unprivileged user,
# inside a Linux container (for development on a computer that is not Linux).
#   docker run --rm -v "$PWD:/src:ro" node:26-bookworm sh /src/native/sandbox/docker-test.sh
# Add --security-opt seccomp=unconfined to let it use user namespaces.
set -eu
apt-get update -qq >/dev/null
apt-get install -y -qq gcc libc6-dev procps util-linux >/dev/null 2>&1
mkdir -p /work
tar --exclude=./node_modules --exclude=./dist --exclude=./.git -C /src -cf - . | tar -C /work -xf -
gcc -O2 -Wall -Wextra -Werror -static -o /opt/grafeno-sandbox /work/native/sandbox/grafeno-sandbox.c
useradd -m tester
chown -R tester /work
su tester -c "cd /work && npm ci --no-audit --no-fund --loglevel=error >/dev/null && sh native/sandbox/escape-test.sh /opt/grafeno-sandbox && GRAFENO_SANDBOX_HELPER=/opt/grafeno-sandbox npx vitest run test/sandbox"
