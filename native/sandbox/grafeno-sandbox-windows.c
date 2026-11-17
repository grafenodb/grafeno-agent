/*
 * grafeno-sandbox: Grafeno Agent's isolation helper for Windows.
 *
 * A command runs in a fresh AppContainer.  Only the paths named with --rw
 * and --ro are added to its DACL, and the internetClient capability is added
 * only with --network.  A Job Object owns the complete process tree and
 * enforces memory, CPU and process limits.  The helper waits for the command
 * and closes the job (ending descendants). A sandbox reuses its profile and
 * ACL entries until --cleanup removes them.
 *
 * Usage:
 *   grafeno-sandbox.exe --probe
 *   grafeno-sandbox.exe [--rw PATH]... [--ro PATH]... [--network]
 *     --memory BYTES --cpu SECONDS --procs COUNT --report-fd FD -- COMMAND...
 */

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <aclapi.h>
#include <fcntl.h>
#include <io.h>
#include <objbase.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <userenv.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "userenv.lib")

typedef struct {
  wchar_t **rw;
  size_t rw_count;
  wchar_t **ro;
  size_t ro_count;
  BOOL network;
  SIZE_T memory;
  DWORD cpu_seconds;
  DWORD processes;
  int report_fd;
  int command_at;
  wchar_t *profile;
} Options;

static void message(const wchar_t *what, DWORD error) {
  wchar_t text[512] = L"";
  FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                 NULL, error, 0, text, (DWORD)(sizeof(text) / sizeof(*text)), NULL);
  fwprintf(stderr, L"grafeno-sandbox: %ls: %ls (%lu)\n", what, text, error);
}

static int fail(const wchar_t *what, DWORD error) {
  message(what, error);
  return 125;
}

static BOOL number(const wchar_t *text, unsigned long long *out) {
  wchar_t *end = NULL;
  unsigned long long value = _wcstoui64(text, &end, 10);
  if (!text[0] || !end || *end) return FALSE;
  *out = value;
  return TRUE;
}

static BOOL push(wchar_t ***items, size_t *count, wchar_t *value) {
  wchar_t **next = (wchar_t **)realloc(*items, (*count + 1) * sizeof(**items));
  if (!next) return FALSE;
  next[*count] = value;
  *items = next;
  ++*count;
  return TRUE;
}

static BOOL parse(int argc, wchar_t **argv, Options *o) {
  memset(o, 0, sizeof(*o));
  o->report_fd = 3;
  for (int i = 1; i < argc; ++i) {
    if (!wcscmp(argv[i], L"--")) {
      o->command_at = i + 1;
      return o->command_at < argc && o->profile != NULL;
    }
#define VALUE(name)                                      \
    if (i + 1 >= argc) {                                 \
      fwprintf(stderr, L"grafeno-sandbox: %ls needs a value\n", name); \
      return FALSE;                                      \
    }                                                    \
    ++i
    if (!wcscmp(argv[i], L"--rw")) {
      VALUE(L"--rw");
      if (!push(&o->rw, &o->rw_count, argv[i])) return FALSE;
    } else if (!wcscmp(argv[i], L"--ro")) {
      VALUE(L"--ro");
      if (!push(&o->ro, &o->ro_count, argv[i])) return FALSE;
    } else if (!wcscmp(argv[i], L"--network")) {
      o->network = TRUE;
    } else if (!wcscmp(argv[i], L"--memory")) {
      unsigned long long n;
      VALUE(L"--memory");
      if (!number(argv[i], &n) || n > (unsigned long long)SIZE_MAX) return FALSE;
      o->memory = (SIZE_T)n;
    } else if (!wcscmp(argv[i], L"--cpu")) {
      unsigned long long n;
      VALUE(L"--cpu");
      if (!number(argv[i], &n) || n > MAXDWORD) return FALSE;
      o->cpu_seconds = (DWORD)n;
    } else if (!wcscmp(argv[i], L"--procs")) {
      unsigned long long n;
      VALUE(L"--procs");
      if (!number(argv[i], &n) || n > MAXDWORD) return FALSE;
      o->processes = (DWORD)n;
    } else if (!wcscmp(argv[i], L"--report-fd")) {
      unsigned long long n;
      VALUE(L"--report-fd");
      if (!number(argv[i], &n) || n > 1024) return FALSE;
      o->report_fd = (int)n;
    } else if (!wcscmp(argv[i], L"--name")) {
      VALUE(L"--name");
      o->profile = argv[i];
    } else {
      fwprintf(stderr, L"grafeno-sandbox: unknown option %ls\n", argv[i]);
      return FALSE;
    }
#undef VALUE
  }
  return FALSE;
}

static void report(const Options *o, BOOL error) {
  char line[256];
  int length = snprintf(line, sizeof(line),
                        "{\"appContainer\":%d,\"job\":%d,\"network\":\"%s\"%s}\n",
                        error ? 0 : 1, error ? 0 : 1, o->network ? "open" : "none",
                        error ? ",\"error\":true" : "");
  if (length > 0) _write(o->report_fd, line, (unsigned int)length);
}

/* Adds (or removes) the package SID on a directory. Inheritable ACEs are
 * automatically propagated by SetNamedSecurityInfo to existing children. */
static DWORD access_path(const wchar_t *path, PSID sid, DWORD rights, ACCESS_MODE mode) {
  PACL old_acl = NULL;
  PACL new_acl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD result = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                       DACL_SECURITY_INFORMATION, NULL, NULL,
                                       &old_acl, NULL, &descriptor);
  if (result != ERROR_SUCCESS) return result;

  if (mode == GRANT_ACCESS && old_acl) {
    for (DWORD i = 0; i < old_acl->AceCount; ++i) {
      void *raw = NULL;
      if (!GetAce(old_acl, i, &raw)) continue;
      ACE_HEADER *header = (ACE_HEADER *)raw;
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
          (header->AceFlags & INHERITED_ACE) != 0) continue;
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw;
      if (EqualSid((PSID)&ace->SidStart, sid) && (ace->Mask & rights) == rights &&
          (header->AceFlags & SUB_CONTAINERS_AND_OBJECTS_INHERIT) ==
              SUB_CONTAINERS_AND_OBJECTS_INHERIT) {
        LocalFree(descriptor);
        return ERROR_SUCCESS;
      }
    }
  }

  EXPLICIT_ACCESSW entry;
  ZeroMemory(&entry, sizeof(entry));
  entry.grfAccessPermissions = rights;
  entry.grfAccessMode = mode;
  entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entry.Trustee.ptstrName = (LPWSTR)sid;
  result = SetEntriesInAclW(1, &entry, old_acl, &new_acl);
  if (result == ERROR_SUCCESS) {
    result = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION, NULL, NULL,
                                   new_acl, NULL);
  }
  if (new_acl) LocalFree(new_acl);
  if (descriptor) LocalFree(descriptor);
  return result;
}

static wchar_t *quote_command(int argc, wchar_t **argv, int first) {
  size_t capacity = 1;
  for (int i = first; i < argc; ++i) capacity += 2 * wcslen(argv[i]) + 4;
  wchar_t *line = (wchar_t *)calloc(capacity, sizeof(*line));
  if (!line) return NULL;
  wchar_t *at = line;
  for (int i = first; i < argc; ++i) {
    if (i != first) *at++ = L' ';
    BOOL needs_quotes = !argv[i][0] || wcspbrk(argv[i], L" \t\"") != NULL;
    if (!needs_quotes) {
      size_t length = wcslen(argv[i]);
      memcpy(at, argv[i], length * sizeof(*at));
      at += length;
      continue;
    }
    *at++ = L'"';
    size_t slashes = 0;
    for (const wchar_t *p = argv[i];; ++p) {
      if (*p == L'\\') {
        ++slashes;
        continue;
      }
      if (*p == L'"') {
        for (size_t n = 0; n < slashes * 2 + 1; ++n) *at++ = L'\\';
        *at++ = L'"';
        slashes = 0;
        continue;
      }
      if (!*p) {
        for (size_t n = 0; n < slashes * 2; ++n) *at++ = L'\\';
        break;
      }
      for (size_t n = 0; n < slashes; ++n) *at++ = L'\\';
      slashes = 0;
      *at++ = *p;
    }
    *at++ = L'"';
  }
  *at = L'\0';
  return line;
}

static HRESULT make_profile(const wchar_t *name, PSID *sid, BOOL *created) {
  *created = FALSE;
  HRESULT hr = CreateAppContainerProfile(name, L"Grafeno Sandbox",
                                          L"Temporary Grafeno Agent sandbox",
                                          NULL, 0, sid);
  if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    hr = DeriveAppContainerSidFromAppContainerName(name, sid);
  } else if (SUCCEEDED(hr)) {
    *created = TRUE;
  }
  return hr;
}

static BOOL make_capability(WELL_KNOWN_SID_TYPE type, SID_AND_ATTRIBUTES *capability,
                            BYTE *buffer, DWORD size) {
  DWORD needed = size;
  if (!CreateWellKnownSid(type, NULL, buffer, &needed)) return FALSE;
  capability->Sid = buffer;
  capability->Attributes = SE_GROUP_ENABLED;
  return TRUE;
}

static HANDLE make_job(const Options *o) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (o->memory) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit = o->memory;
  }
  if (o->cpu_seconds) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_TIME;
    limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart =
        (LONGLONG)o->cpu_seconds * 10000000LL;
  }
  if (o->processes) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = o->processes;
  }
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    CloseHandle(job);
    return NULL;
  }
  return job;
}

static int probe(void) {
  wchar_t name[64];
  swprintf_s(name, sizeof(name) / sizeof(*name), L"GrafenoSandbox.Probe.%lu",
             GetCurrentProcessId());
  PSID sid = NULL;
  BOOL created = FALSE;
  HRESULT hr = make_profile(name, &sid, &created);
  if (FAILED(hr)) return fail(L"AppContainer is unavailable", (DWORD)hr);
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) {
    DWORD error = GetLastError();
    FreeSid(sid);
    if (created) DeleteAppContainerProfile(name);
    return fail(L"Job Objects are unavailable", error);
  }
  CloseHandle(job);
  FreeSid(sid);
  if (created) DeleteAppContainerProfile(name);
  fputs("{\"appContainer\":1,\"job\":1}\n", stdout);
  return 0;
}

static int cleanup_profile(int argc, wchar_t **argv) {
  if (argc < 3) return fail(L"--cleanup needs a profile name", ERROR_INVALID_PARAMETER);
  PSID sid = NULL;
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(argv[2], &sid);
  if (FAILED(hr)) return fail(L"cannot derive AppContainer SID", (DWORD)hr);
  LPWSTR sid_text = NULL;
  if (!ConvertSidToStringSidW(sid, &sid_text)) {
    DWORD error = GetLastError();
    FreeSid(sid);
    return fail(L"cannot format AppContainer SID", error);
  }
  PWSTR profile_path = NULL;
  hr = GetAppContainerFolderPath(sid_text, &profile_path);
  LocalFree(sid_text);
  if (FAILED(hr)) {
    /* A manually-created sandbox may never have run a command. */
    FreeSid(sid);
    DeleteAppContainerProfile(argv[2]);
    return 0;
  }
  CoTaskMemFree(profile_path);
  DWORD first_error = ERROR_SUCCESS;
  for (int i = 3; i < argc; ++i) {
    if ((!wcscmp(argv[i], L"--rw") || !wcscmp(argv[i], L"--ro")) && i + 1 < argc) {
      DWORD result = access_path(argv[++i], sid, 0, REVOKE_ACCESS);
      if (first_error == ERROR_SUCCESS && result != ERROR_SUCCESS) first_error = result;
    } else {
      FreeSid(sid);
      return fail(L"invalid --cleanup arguments", ERROR_INVALID_PARAMETER);
    }
  }
  FreeSid(sid);
  hr = DeleteAppContainerProfile(argv[2]);
  if (first_error != ERROR_SUCCESS) return fail(L"cannot remove sandbox ACL", first_error);
  if (FAILED(hr)) return fail(L"cannot delete AppContainer profile", (DWORD)hr);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && !wcscmp(argv[1], L"--probe")) return probe();
  if (argc >= 2 && !wcscmp(argv[1], L"--cleanup")) return cleanup_profile(argc, argv);

  Options o;
  if (!parse(argc, argv, &o)) {
    fwprintf(stderr, L"grafeno-sandbox: no command after --, or invalid arguments\n");
    return 125;
  }

  PSID package_sid = NULL;
  BOOL created = FALSE;
  HRESULT hr = make_profile(o.profile, &package_sid, &created);
  if (FAILED(hr)) {
    report(&o, TRUE);
    return fail(L"cannot create AppContainer profile", (DWORD)hr);
  }

  size_t granted_rw = 0;
  size_t granted_ro = 0;
  DWORD error = ERROR_SUCCESS;
  for (; granted_rw < o.rw_count; ++granted_rw) {
    error = access_path(o.rw[granted_rw], package_sid, FILE_ALL_ACCESS, GRANT_ACCESS);
    if (error != ERROR_SUCCESS) break;
  }
  if (error == ERROR_SUCCESS) {
    for (; granted_ro < o.ro_count; ++granted_ro) {
      error = access_path(o.ro[granted_ro], package_sid,
                          FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, GRANT_ACCESS);
      if (error != ERROR_SUCCESS) break;
    }
  }

  HANDLE job = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  wchar_t *command = NULL;
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  int exit_code = 125;

  if (error != ERROR_SUCCESS) {
    message(L"cannot grant the AppContainer access to a sandbox path", error);
    goto cleanup;
  }

  SID_AND_ATTRIBUTES capabilities[2];
  BYTE capability_sids[2][SECURITY_MAX_SID_SIZE];
  SECURITY_CAPABILITIES security;
  ZeroMemory(&security, sizeof(security));
  security.AppContainerSid = package_sid;
  if (o.network) {
    if (!make_capability(WinCapabilityInternetClientServerSid, &capabilities[0],
                         capability_sids[0], sizeof(capability_sids[0])) ||
        !make_capability(WinCapabilityPrivateNetworkClientServerSid, &capabilities[1],
                         capability_sids[1], sizeof(capability_sids[1]))) {
      error = GetLastError();
      message(L"cannot make the network capabilities", error);
      goto cleanup;
    }
    security.Capabilities = capabilities;
    security.CapabilityCount = 2;
  }

  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
  attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attribute_size);
  if (!attributes ||
      !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size) ||
      !UpdateProcThreadAttribute(attributes, 0,
                                 PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                 &security, sizeof(security), NULL, NULL)) {
    error = GetLastError();
    message(L"cannot prepare AppContainer process attributes", error);
    goto cleanup;
  }

  job = make_job(&o);
  if (!job) {
    error = GetLastError();
    message(L"cannot create the Job Object", error);
    goto cleanup;
  }
  command = quote_command(argc, argv, o.command_at);
  if (!command) {
    message(L"cannot allocate the command line", ERROR_OUTOFMEMORY);
    goto cleanup;
  }

  STARTUPINFOEXW si;
  ZeroMemory(&si, sizeof(si));
  si.StartupInfo.cb = sizeof(si);
  si.lpAttributeList = attributes;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  if (!CreateProcessW(NULL, command, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                          CREATE_UNICODE_ENVIRONMENT,
                      NULL, NULL, &si.StartupInfo, &pi)) {
    error = GetLastError();
    message(L"cannot create the AppContainer process", error);
    goto cleanup;
  }
  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    error = GetLastError();
    TerminateProcess(pi.hProcess, 125);
    message(L"cannot put the process in its Job Object", error);
    goto cleanup;
  }
  report(&o, FALSE);
  ResumeThread(pi.hThread);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 125;
  if (GetExitCodeProcess(pi.hProcess, &code)) exit_code = (int)code;

cleanup:
  if (pi.hThread) CloseHandle(pi.hThread);
  if (pi.hProcess) CloseHandle(pi.hProcess);
  /* KILL_ON_JOB_CLOSE ends descendants when the command's root process exits. */
  if (job) CloseHandle(job);
  if (attributes) {
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
  }
  free(command);
  FreeSid(package_sid);
  free(o.rw);
  free(o.ro);
  if (exit_code == 125) report(&o, TRUE);
  return exit_code;
}
