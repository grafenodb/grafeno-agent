/*
 * grafeno-sandbox: Grafeno Agent's isolation helper for Linux.
 *
 * It runs one command isolated with what the kernel allows an unprivileged
 * user, and says exactly what it applied (never more):
 *
 *   - user, PID, mount, IPC, UTS and (without network) network namespaces,
 *     when unprivileged user namespaces are allowed;
 *   - Landlock: the files it may read, and the folders it may write;
 *     without a network namespace, Landlock's TCP rules (ABI 4) when the
 *     command may not use the network;
 *   - seccomp: no mounts, no new namespaces, no ptrace, no kernel modules,
 *     no BPF, no io_uring, no keyrings, no clock or reboot changes;
 *   - cgroups v2 (memory, processes, CPU) in a delegated cgroup, when it is
 *     given one it may write; else resource limits (rlimits).
 *
 * It never asks for privileges, has no daemon and leaves nothing behind:
 * when it ends, everything it started ends (the PID namespace's init, its
 * parent-death signal, the cgroup's kill).
 *
 * Usage:
 *   grafeno-sandbox --probe
 *   grafeno-sandbox [--rw PATH]... [--ro PATH]... [--no-network]
 *                   [--memory BYTES] [--cpu SECONDS] [--procs N] [--files N]
 *                   [--cgroup DIR] [--private-tmp] [--hide PATH]...
 *                   [--report-fd FD] [--require fs,net] -- PROGRAM [ARGS]...
 *
 * Exit status: the command's, or 128 + its signal; 125 when the sandbox
 * could not be made as required (said on the report descriptor).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <net/if.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define VERSION "1"
#define SANDBOX_FAILED 125
#define MAX_PATHS 256

/* ---------- Landlock, defined here so older headers build it ---------- */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};
struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define LL_FS_EXECUTE (1ULL << 0)
#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_READ_FILE (1ULL << 2)
#define LL_FS_READ_DIR (1ULL << 3)
#define LL_FS_REFER (1ULL << 13)
#define LL_FS_TRUNCATE (1ULL << 14)
#define LL_FS_IOCTL_DEV (1ULL << 15)
#define LL_NET_BIND_TCP (1ULL << 0)
#define LL_NET_CONNECT_TCP (1ULL << 1)

#if defined(__x86_64__)
#define AUDIT_ARCH_HERE AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_HERE AUDIT_ARCH_AARCH64
#else
#error "grafeno-sandbox is built for x86_64 and aarch64"
#endif

/* ---------- what was asked ---------- */
struct options {
  const char *rw[MAX_PATHS];
  int rw_count;
  const char *ro[MAX_PATHS];
  int ro_count;
  const char *hide[MAX_PATHS];
  int hide_count;
  int no_network;
  unsigned long long memory;
  unsigned long cpu;
  unsigned long procs;
  unsigned long files;
  const char *cgroup;
  int private_tmp;
  int report_fd;
  int require_fs;
  int require_net;
  char **argv;
};

/* ---------- what was applied ---------- */
struct applied {
  int userns, pidns, netns, mountns, procfs, private_tmp;
  long landlock_abi;
  int landlock_fs, landlock_net, seccomp, cgroup, rlimits;
};

static struct options opt;
static struct applied done;
static char cgroup_dir[4096];
static volatile pid_t forward_to = -1;

static void fail(const char *what) {
  if (opt.report_fd >= 0) {
    dprintf(opt.report_fd, "{\"error\":\"%s\",\"errno\":%d}\n", what, errno);
  } else {
    fprintf(stderr, "grafeno-sandbox: %s (%s)\n", what, strerror(errno));
  }
  _exit(SANDBOX_FAILED);
}

static const char *network_word(void) {
  if (!opt.no_network) return "open";
  if (done.netns) return "none";
  if (done.landlock_net) return "tcp-blocked";
  return "open";
}

static void report(int fd) {
  if (fd < 0) return;
  dprintf(fd,
          "{\"engine\":\"linux\",\"version\":\"" VERSION
          "\",\"userns\":%d,\"pidns\":%d,\"netns\":%d,\"mountns\":%d,\"procfs\":%d,"
          "\"privateTmp\":%d,\"landlockAbi\":%ld,\"landlockFs\":%d,\"landlockNet\":%d,"
          "\"seccomp\":%d,\"cgroup\":%d,\"rlimits\":%d,\"network\":\"%s\"}\n",
          done.userns, done.pidns, done.netns, done.mountns, done.procfs, done.private_tmp,
          done.landlock_abi, done.landlock_fs, done.landlock_net, done.seccomp, done.cgroup,
          done.rlimits, network_word());
}

static int write_file(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = write(fd, text, strlen(text));
  int saved = errno;
  close(fd);
  errno = saved;
  return n == (ssize_t)strlen(text) ? 0 : -1;
}

/* ---------- namespaces ---------- */
static int enter_namespaces(void) {
  uid_t uid = getuid();
  gid_t gid = getgid();
  int flags = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS;
  if (opt.no_network) flags |= CLONE_NEWNET;
  if (unshare(flags) != 0) return -1;
  char map[64];
  if (write_file("/proc/self/setgroups", "deny") != 0 && errno != ENOENT) return -1;
  snprintf(map, sizeof map, "%u %u 1", (unsigned)uid, (unsigned)uid);
  if (write_file("/proc/self/uid_map", map) != 0) return -1;
  snprintf(map, sizeof map, "%u %u 1", (unsigned)gid, (unsigned)gid);
  if (write_file("/proc/self/gid_map", map) != 0) return -1;
  done.userns = 1;
  done.pidns = 1;
  done.mountns = 1;
  done.netns = opt.no_network ? 1 : 0;
  return 0;
}

static void loopback_up(void) {
  int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (s < 0) return;
  struct ifreq ifr;
  memset(&ifr, 0, sizeof ifr);
  strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
  if (ioctl(s, SIOCGIFFLAGS, &ifr) == 0) {
    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
    ioctl(s, SIOCSIFFLAGS, &ifr);
  }
  close(s);
}

/* Inside the new namespaces, as their init: a private /proc, /tmp and hidden folders. */
static void prepare_mounts(void) {
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) return;
  if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == 0) done.procfs = 1;
  if (opt.private_tmp &&
      mount("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=512m") == 0)
    done.private_tmp = 1;
  for (int i = 0; i < opt.hide_count; i++) {
    /* An empty, read-only folder over what must not be seen (sockets, keys). */
    mount("tmpfs", opt.hide[i], "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY,
          "mode=0555,size=4k");
  }
}

/* ---------- cgroups v2 ---------- */
/* Made by the outer process (which removes it at the end), joined by the sandbox. */
static void make_cgroup(void) {
  if (!opt.cgroup) return;
  snprintf(cgroup_dir, sizeof cgroup_dir, "%s/grafeno-sandbox-%d", opt.cgroup, (int)getpid());
  if (mkdir(cgroup_dir, 0755) != 0) {
    cgroup_dir[0] = 0;
    return;
  }
  char path[4200], value[64];
  int ok = 1;
  if (opt.memory) {
    snprintf(path, sizeof path, "%s/memory.max", cgroup_dir);
    snprintf(value, sizeof value, "%llu", opt.memory);
    ok &= write_file(path, value) == 0;
    snprintf(path, sizeof path, "%s/memory.swap.max", cgroup_dir);
    write_file(path, "0");
  }
  if (opt.procs) {
    snprintf(path, sizeof path, "%s/pids.max", cgroup_dir);
    snprintf(value, sizeof value, "%lu", opt.procs);
    ok &= write_file(path, value) == 0;
  }
  if (!ok) {
    rmdir(cgroup_dir);
    cgroup_dir[0] = 0;
  }
}

static void join_cgroup(void) {
  if (!cgroup_dir[0]) return;
  char path[4200];
  snprintf(path, sizeof path, "%s/cgroup.procs", cgroup_dir);
  if (write_file(path, "0") == 0) done.cgroup = 1;
}

static void end_cgroup(void) {
  if (!cgroup_dir[0]) return;
  char path[4200];
  snprintf(path, sizeof path, "%s/cgroup.kill", cgroup_dir);
  write_file(path, "1");
  for (int i = 0; i < 50 && rmdir(cgroup_dir) != 0; i++) usleep(20000);
}

/* ---------- resource limits ---------- */
static unsigned long processes_of(uid_t uid) {
  DIR *d = opendir("/proc");
  if (!d) return 0;
  unsigned long n = 0;
  struct dirent *e;
  struct stat st;
  char path[300];
  while ((e = readdir(d))) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    snprintf(path, sizeof path, "/proc/%s", e->d_name);
    if (stat(path, &st) == 0 && st.st_uid == uid) n++;
  }
  closedir(d);
  return n;
}

static void apply_rlimits(unsigned long baseline) {
  struct rlimit r;
  int any = 0;
  r.rlim_cur = r.rlim_max = 0;
  setrlimit(RLIMIT_CORE, &r);
  if (opt.memory && !done.cgroup) {
    r.rlim_cur = r.rlim_max = (rlim_t)opt.memory;
    any |= setrlimit(RLIMIT_AS, &r) == 0;
  }
  if (opt.cpu) {
    r.rlim_cur = (rlim_t)opt.cpu;
    r.rlim_max = (rlim_t)opt.cpu + 2;
    any |= setrlimit(RLIMIT_CPU, &r) == 0;
  }
  if (opt.procs && !done.cgroup) {
    /* Per user, across the system: what the user runs already, and the sandbox's share. */
    r.rlim_cur = r.rlim_max = (rlim_t)(baseline + opt.procs);
    any |= setrlimit(RLIMIT_NPROC, &r) == 0;
  }
  if (opt.files) {
    r.rlim_cur = r.rlim_max = (rlim_t)opt.files;
    any |= setrlimit(RLIMIT_NOFILE, &r) == 0;
  }
  done.rlimits = any || done.cgroup;
}

/* ---------- Landlock ---------- */
static int add_path_rule(int ruleset, const char *path, uint64_t rights, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return 0; /* A path that is not there is not reachable either. */
  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    return 0;
  }
  if (!S_ISDIR(st.st_mode)) {
    /* A file takes only the rights a file has. */
    rights &= LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV;
  }
  struct ll_path_beneath_attr rule = {.allowed_access = rights & handled, .parent_fd = fd};
  long r = syscall(__NR_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(fd);
  errno = saved;
  return r == 0 ? 0 : -1;
}

static void apply_landlock(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  done.landlock_abi = abi > 0 ? abi : 0;
  if (abi <= 0) return;
  uint64_t fs = (1ULL << 13) - 1;
  if (abi >= 2) fs |= LL_FS_REFER;
  if (abi >= 3) fs |= LL_FS_TRUNCATE;
  if (abi >= 5) fs |= LL_FS_IOCTL_DEV;
  struct ll_ruleset_attr attr = {.handled_access_fs = fs, .handled_access_net = 0};
  int block_tcp = opt.no_network && !done.netns && abi >= 4;
  if (block_tcp) attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
  /* Only the first fields the kernel knows: ABI 1 to 3 have no network rules. */
  size_t size = abi >= 4 ? sizeof attr : sizeof attr.handled_access_fs;
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, size, 0);
  if (ruleset < 0) return;
  uint64_t read_only = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  for (int i = 0; i < opt.ro_count; i++) add_path_rule(ruleset, opt.ro[i], read_only, fs);
  for (int i = 0; i < opt.rw_count; i++) add_path_rule(ruleset, opt.rw[i], fs, fs);
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) == 0) {
    done.landlock_fs = 1;
    done.landlock_net = block_tcp;
  }
  close(ruleset);
}

/* ---------- seccomp ---------- */
#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
                 BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static void apply_seccomp(void) {
  const uint32_t namespaces = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID |
                              CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP;
  struct sock_filter filter[] = {
    /* The architecture it was built for; another one is never let through. */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_HERE, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* The x32 calls are another way in. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
#endif
    /* clone: no new namespaces. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, namespaces, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#ifdef __NR_clone3
    /* clone3's flags cannot be read here: "not there", so libc falls back to clone. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
    DENY(__NR_mount),
    DENY(__NR_umount2),
    DENY(__NR_pivot_root),
    DENY(__NR_unshare),
    DENY(__NR_setns),
    DENY(__NR_ptrace),
    DENY(__NR_process_vm_readv),
    DENY(__NR_process_vm_writev),
    DENY(__NR_kexec_load),
#ifdef __NR_kexec_file_load
    DENY(__NR_kexec_file_load),
#endif
    DENY(__NR_init_module),
    DENY(__NR_finit_module),
    DENY(__NR_delete_module),
    DENY(__NR_bpf),
    DENY(__NR_perf_event_open),
    DENY(__NR_keyctl),
    DENY(__NR_add_key),
    DENY(__NR_request_key),
    DENY(__NR_userfaultfd),
    DENY(__NR_open_by_handle_at),
    DENY(__NR_name_to_handle_at),
#ifdef __NR_io_uring_setup
    DENY(__NR_io_uring_setup),
    DENY(__NR_io_uring_enter),
    DENY(__NR_io_uring_register),
#endif
#ifdef __NR_fsopen
    DENY(__NR_fsopen),
    DENY(__NR_fsmount),
    DENY(__NR_fsconfig),
    DENY(__NR_fspick),
    DENY(__NR_move_mount),
    DENY(__NR_open_tree),
#endif
#ifdef __NR_mount_setattr
    DENY(__NR_mount_setattr),
#endif
    DENY(__NR_swapon),
    DENY(__NR_swapoff),
    DENY(__NR_reboot),
    DENY(__NR_settimeofday),
    DENY(__NR_clock_settime),
    DENY(__NR_clock_adjtime),
    DENY(__NR_adjtimex),
    DENY(__NR_syslog),
    DENY(__NR_acct),
    DENY(__NR_quotactl),
    DENY(__NR_vhangup),
#if defined(__x86_64__)
    DENY(__NR_iopl),
    DENY(__NR_ioperm),
    DENY(__NR_uselib),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof filter / sizeof filter[0]),
    .filter = filter,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0) done.seccomp = 1;
}

/* ---------- the command ---------- */
static void run_command(unsigned long baseline) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");
  apply_rlimits(baseline);
  apply_landlock();
  if (opt.require_fs && !done.landlock_fs) {
    errno = ENOTSUP;
    fail("landlock_unavailable");
  }
  if (opt.require_net && opt.no_network && !done.netns && !done.landlock_net) {
    errno = ENOTSUP;
    fail("network_isolation_unavailable");
  }
  apply_seccomp();
  report(opt.report_fd);
  if (opt.report_fd >= 0) close(opt.report_fd);
  execvp(opt.argv[0], opt.argv);
  fprintf(stderr, "grafeno-sandbox: cannot run %s: %s\n", opt.argv[0], strerror(errno));
  _exit(127);
}

static int status_code(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

static void forward(int sig) {
  if (forward_to > 0) kill(forward_to, sig);
}

static void forward_signals(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = forward;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGQUIT, &sa, NULL);
}

/* The namespaces' init: runs the command, reaps what is left, ends with the command's status. */
static void be_init(unsigned long baseline) {
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  prepare_mounts();
  if (done.netns) loopback_up();
  pid_t command = fork();
  if (command < 0) fail("fork");
  if (command == 0) run_command(baseline);
  if (opt.report_fd >= 0) close(opt.report_fd);
  forward_to = command;
  forward_signals();
  int status = 0, result = 1;
  for (;;) {
    pid_t ended = waitpid(-1, &status, 0);
    if (ended == command) {
      result = status_code(status);
      break;
    }
    if (ended < 0 && errno != EINTR) break;
  }
  /* Ending init ends every process left in the namespace. */
  _exit(result);
}

/* ---------- probe ---------- */
static void probe(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  int userns = 0;
  pid_t child = fork();
  if (child == 0) {
    /*
     * The same steps as a real run (maps included): AppArmor on recent Ubuntu
     * lets the namespace be made, then refuses what makes it usable.
     */
    opt.no_network = 1;
    _exit(enter_namespaces() == 0 ? 0 : 1);
  }
  int status = 0;
  if (child > 0 && waitpid(child, &status, 0) == child && WIFEXITED(status) &&
      WEXITSTATUS(status) == 0)
    userns = 1;
  int seccomp = prctl(PR_GET_SECCOMP, 0, 0, 0, 0) >= 0;
  printf("{\"engine\":\"linux\",\"version\":\"" VERSION
         "\",\"userns\":%d,\"landlockAbi\":%ld,\"seccomp\":%d,"
#if defined(__x86_64__)
         "\"arch\":\"x64\"}\n",
#else
         "\"arch\":\"arm64\"}\n",
#endif
         userns, abi > 0 ? abi : 0, seccomp);
  exit(0);
}

/*
 * Without a PID namespace nothing ends what the command left running: the
 * processes of the sandbox's process group are ended here, all but this one.
 */
static void end_group(void) {
  pid_t self = getpid();
  pid_t group = getpgrp();
  for (int round = 0; round < 3; round++) {
    DIR *d = opendir("/proc");
    if (!d) return;
    struct dirent *e;
    int found = 0;
    while ((e = readdir(d))) {
      if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
      pid_t pid = (pid_t)atoi(e->d_name);
      if (pid == self) continue;
      char path[64], line[512];
      snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
      int fd = open(path, O_RDONLY | O_CLOEXEC);
      if (fd < 0) continue;
      ssize_t n = read(fd, line, sizeof line - 1);
      close(fd);
      if (n <= 0) continue;
      line[n] = 0;
      /* After the command's name, in parentheses: state, parent, group. */
      char *end = strrchr(line, ')');
      int parent = 0, pgrp = 0;
      char state = 0;
      if (!end || sscanf(end + 1, " %c %d %d", &state, &parent, &pgrp) != 3) continue;
      if (pgrp == (int)group && state != 'Z') {
        kill(pid, SIGKILL);
        found = 1;
      }
    }
    closedir(d);
    if (!found) return;
    usleep(20000);
  }
}

/* ---------- arguments ---------- */
static unsigned long long number(const char *text) {
  char *end = NULL;
  errno = 0;
  unsigned long long n = strtoull(text, &end, 10);
  if (errno || !end || *end) {
    fprintf(stderr, "grafeno-sandbox: not a number: %s\n", text);
    exit(2);
  }
  return n;
}

static void parse(int argc, char **argv) {
  opt.report_fd = -1;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *next = i + 1 < argc ? argv[i + 1] : NULL;
#define NEED()                                                         \
  do {                                                                 \
    if (!next) {                                                       \
      fprintf(stderr, "grafeno-sandbox: %s needs a value\n", a);       \
      exit(2);                                                         \
    }                                                                  \
    i++;                                                               \
  } while (0)
    if (strcmp(a, "--probe") == 0) probe();
    else if (strcmp(a, "--version") == 0) {
      puts(VERSION);
      exit(0);
    } else if (strcmp(a, "--rw") == 0) {
      NEED();
      if (opt.rw_count < MAX_PATHS) opt.rw[opt.rw_count++] = next;
    } else if (strcmp(a, "--ro") == 0) {
      NEED();
      if (opt.ro_count < MAX_PATHS) opt.ro[opt.ro_count++] = next;
    } else if (strcmp(a, "--hide") == 0) {
      NEED();
      if (opt.hide_count < MAX_PATHS) opt.hide[opt.hide_count++] = next;
    } else if (strcmp(a, "--no-network") == 0) opt.no_network = 1;
    else if (strcmp(a, "--private-tmp") == 0) opt.private_tmp = 1;
    else if (strcmp(a, "--memory") == 0) {
      NEED();
      opt.memory = number(next);
    } else if (strcmp(a, "--cpu") == 0) {
      NEED();
      opt.cpu = (unsigned long)number(next);
    } else if (strcmp(a, "--procs") == 0) {
      NEED();
      opt.procs = (unsigned long)number(next);
    } else if (strcmp(a, "--files") == 0) {
      NEED();
      opt.files = (unsigned long)number(next);
    } else if (strcmp(a, "--cgroup") == 0) {
      NEED();
      opt.cgroup = next;
    } else if (strcmp(a, "--report-fd") == 0) {
      NEED();
      opt.report_fd = (int)number(next);
    } else if (strcmp(a, "--require") == 0) {
      NEED();
      opt.require_fs = strstr(next, "fs") != NULL;
      opt.require_net = strstr(next, "net") != NULL;
    } else if (strcmp(a, "--") == 0) {
      if (i + 1 >= argc) break;
      opt.argv = &argv[i + 1];
      return;
    } else {
      fprintf(stderr, "grafeno-sandbox: unknown option %s\n", a);
      exit(2);
    }
  }
  fprintf(stderr, "grafeno-sandbox: no command after --\n");
  exit(2);
}

int main(int argc, char **argv) {
  parse(argc, argv);
  /* A process group of its own: what is ended at the end is only what it started. */
  setpgid(0, 0);
  unsigned long baseline = processes_of(getuid());
  make_cgroup();
  pid_t sandbox = fork();
  if (sandbox < 0) fail("fork");
  if (sandbox == 0) {
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    join_cgroup();
    if (enter_namespaces() == 0) {
      pid_t init = fork();
      if (init < 0) fail("fork");
      if (init == 0) be_init(baseline);
      if (opt.report_fd >= 0) close(opt.report_fd);
      forward_to = init;
      forward_signals();
      int status = 0;
      while (waitpid(init, &status, 0) < 0 && errno == EINTR) {
      }
      _exit(status_code(status));
    }
    /* No namespaces here: the same process runs the command, isolated as it can be. */
    run_command(baseline);
  }
  if (opt.report_fd >= 0) close(opt.report_fd);
  forward_to = sandbox;
  forward_signals();
  int status = 0;
  while (waitpid(sandbox, &status, 0) < 0 && errno == EINTR) {
  }
  /* What the command left running in this process group ends with it. */
  end_group();
  end_cgroup();
  return status_code(status);
}
