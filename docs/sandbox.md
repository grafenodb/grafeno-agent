# Grafeno Sandbox

Grafeno Sandbox runs the agent's commands in isolated environments, made
and destroyed by the agent itself. It comes with Grafeno Agent
(`npm install -g @grafenodb/agent-cli`): no Docker, Podman, Bubblewrap or
other engine to install, no daemon, nothing left running.

## What goes through it

- The agent's `run_command` and `start_process`, in the chat and in each
  sub-agent of a run, for every provider.
- A run's acceptance checks (tests, lint, builds), in the task's own
  sandbox.

Provider CLIs (Claude Code, Codex, the ACP agents) run on the computer,
with their own tools turned off: every command they want runs through the
agent's tools, so in the sandbox. The agent's file tools (read, write,
edit, move, delete) run inside the agent, kept to the project's folder by
the agent's own checks; they are not isolated by the operating system.

## How it isolates, by platform

### Linux

A small native helper (`grafeno-sandbox`, built from
`native/sandbox/grafeno-sandbox.c` for x64 and arm64) ships inside the
package. The agent checks its SHA-256 against the package's manifest before
it runs it. For each command it applies what the kernel allows an
unprivileged user, and reports exactly what it applied:

| Mechanism                             | What it does                                                                                                     | Needs                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Landlock (files)                      | Reads only the system, the programs on PATH and the project; writes only the project and its own home and temp   | kernel 5.13+, Landlock enabled (required)    |
| User, PID, mount, IPC, UTS namespaces | Its own processes (it cannot see or signal yours), its own `/proc`, a private `/tmp`, your runtime folder hidden | unprivileged user namespaces                 |
| Network namespace                     | No network at all (loopback only) for commands that do not install or fetch                                      | unprivileged user namespaces                 |
| Landlock (TCP)                        | Without a network namespace: no TCP connections or listening                                                     | kernel 6.7+ (Landlock ABI 4)                 |
| seccomp                               | No mounts, new namespaces, ptrace, kernel modules, BPF, io_uring, keyrings, clock or reboot changes              | always                                       |
| cgroups v2                            | Memory, processes and CPU limited for the whole sandbox; ended together                                          | a cgroup delegated to your session (systemd) |
| rlimits                               | Without cgroups: memory per process, CPU time, processes per user, open files                                    | always                                       |

`/sandbox status` says which of these this computer has.

**Limitations on Linux**

- **Ubuntu 23.10 and later** (and some other distributions) restrict
  unprivileged user namespaces through AppArmor. The helper then has no
  namespaces: files are still closed off (Landlock) and system calls
  filtered (seccomp), but its processes can see your process list, and
  without network only TCP is blocked (with Landlock ABI 4): not UDP, and
  not Unix sockets reachable by path. What it leaves running is ended by
  process group when the command ends.
- A kernel without Landlock cannot close off files: the engine reports
  itself unavailable, and commands are not sandboxed (said on each one, or
  refused with `AGENT_SANDBOX=required`).
- Without a delegated cgroup, memory is limited per process (its address
  space) and processes per user (counting the ones you run already).
- Landlock does not mediate connecting to a Unix socket by path: without a
  mount namespace, a socket whose path is known stays reachable. The
  agent removes the variables that name your agents' sockets
  (`SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`…) and, with a mount
  namespace, hides `/run/user/<uid>`.

### macOS

`sandbox-exec`, part of macOS, with a profile written for each command:
no writes outside the project and the sandbox's own home and temp, no
reads in your home folder but those, no outbound network except
localhost (for commands that do not install or fetch), CPU time and open
files limited with `ulimit`.

**Limitations on macOS**: Apple deprecates the `sandbox-exec` command (it
works, and may change in a later macOS); no PID isolation; no memory limit;
processes are limited per user.

### Windows

A native helper (`grafeno-sandbox.exe`, built for x64 and arm64 and checked
against the package manifest) launches each command in its sandbox's
AppContainer. The AppContainer SID is granted access to the project and the
sandbox's own home and temporary folders; Windows denies other user files
and the network, and the command cannot open or signal other processes
(it may still list them, so the sandbox does not claim process isolation). Commands that install or fetch receive the
public and private network capabilities for that command only.

The process starts suspended and is placed in a Job Object before it runs.
The Job Object limits total memory, CPU time and process count, owns every
descendant, and ends the tree when the command ends or the sandbox is stopped.
The AppContainer profile and its inheritable ACL entries live for the sandbox,
so only its first command prepares the project tree (on a large tree, such
as one with `node_modules`, that first grant takes a while); `destroy` and
`cleanup` remove them. Those ACL entries are the one thing a sandbox leaves
on your folders while it exists, so they are never left behind on purpose:

- if removing them fails, the sandbox is kept, marked, and said in
  `/sandbox status`; `/sandbox cleanup` and the next session try again;
- a sandbox left by an agent that ended without removing it (killed,
  crashed) is swept, with its ACL entries, when a later session makes its
  first sandbox, or by `/sandbox cleanup`.

**Limitations on Windows**: Job Objects do not cap the number of open files.
MSYS/Git Bash needs a global named object that AppContainer denies, so the
default shell is `cmd.exe` when the sandbox can run here (its helper is
installed and checks out); otherwise, and with `AGENT_SANDBOX=off`, Git Bash
as before. `AGENT_SHELL` may still
select another AppContainer-compatible shell explicitly.

## Policies

| Setting                 | Values                      | Default | What                                                                                       |
| ----------------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `AGENT_SANDBOX`         | `auto`, `required`, `off`   | `auto`  | `auto`: sandboxed where possible, said where not; `required`: never unsandboxed; `off`     |
| `AGENT_SANDBOX_NETWORK` | `auto`, `always`, `never`   | `auto`  | The network only for commands that install or fetch (npm install, pip install, git clone…) |
| `AGENT_SANDBOX_KEEP`    | `never`, `failed`, `always` | `never` | Whether a sandbox is kept when its work ends                                               |

Profiles by what a command does: `standard` (4 GB, 15 min of CPU, 512
processes) for the agent's commands, `install` (6 GB, 30 min, 1024, with
the network) for installing dependencies, `strict` (2 GB, 5 min, 256, no
network) for checks.

Each sandbox has its own home and temporary folder: `HOME`, `TMPDIR`, the
npm, pip, cargo and go caches and global prefixes point there, so what a
command installs never changes the computer's own. Only your git name and
e-mail are copied in (for commits), never credentials, OAuth sessions or
private folders.

## Lifecycle and commands

Sandboxes are made when commands need them (one for the chat session, one
per task of a run) and destroyed when the session or task ends, or kept as
`AGENT_SANDBOX_KEEP` says. They live in the agent's data folder
(`sandboxes/<id>`). Each keeps a log of security events: what ran (the
program's name only), what isolated it, how it ended. Never a command's
text, output or secrets.

```text
/sandbox status     what isolates commands here, and what does not
/sandbox list       the sandboxes kept
/sandbox create     a sandbox for a folder
/sandbox inspect    one sandbox: folders, size, security events
/sandbox stop       end what runs in it
/sandbox destroy    end it and remove it
/sandbox cleanup    remove every sandbox where nothing runs
```

The same from a terminal: `grafeno-agent sandbox …`.

## Distribution and integrity

The release builds the native helpers on each architecture (x64 and arm64
Linux and Windows runners), attacks the Linux helper
(`native/sandbox/escape-test.sh`: files, network, namespaces, mounts, fork
bombs, CPU, memory, leftovers) and runs the agent's real sandbox tests on
Linux, Windows and macOS. Only then are the helpers put in the package, with
a manifest of their SHA-256, which the agent checks before running one.
Nothing is downloaded or run at install time.
Uninstalling the package removes everything: there is no service, and
nothing outlives the commands.

To build the helper yourself (on Linux or Windows with Visual C++ Build
Tools): `npm run build:sandbox`, or point `GRAFENO_SANDBOX_HELPER` at your
own build (said in `/sandbox status`).
