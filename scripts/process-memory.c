// Test-only macOS process accounting. No browser code, credentials or arguments
// enter the stream. Lifetime footprint counters are NOT per-cycle/aggregate peaks.
#include <errno.h>
#include <libproc.h>
#include <poll.h>
#include <pthread.h>
#include <sys/qos.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_PROCESSES 4096
static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000 + (double)t.tv_nsec / 1000000;
}
static int usage(pid_t pid, struct rusage_info_v4 *r) {
  memset(r, 0, sizeof(*r));
  return proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)r);
}
static void fields(pid_t pid, const struct rusage_info_v4 *r) {
  printf("{\"pid\":%d,\"startIdentity\":\"%llu\",\"residentBytes\":%llu,\"footprintBytes\":%llu,\"lifetimePeakFootprintBytes\":%llu",
    pid, (unsigned long long)r->ri_proc_start_abstime,
    (unsigned long long)r->ri_resident_size, (unsigned long long)r->ri_phys_footprint,
    (unsigned long long)r->ri_lifetime_max_phys_footprint);
  // The running process may allocate while the kernel fills rusage fields.
  // Retain the first raw counters and independently confirm the peak afterward.
  struct rusage_info_v4 confirmation;
  if (usage(pid, &confirmation)) printf(",\"confirmationError\":%d}", errno);
  else printf(",\"confirmationStartIdentity\":\"%llu\",\"confirmedLifetimePeakFootprintBytes\":%llu}",
    (unsigned long long)confirmation.ri_proc_start_abstime,
    (unsigned long long)confirmation.ri_lifetime_max_phys_footprint);
}
static int sample(pid_t root) {
  pid_t pids[MAX_PROCESSES] = { root };
  int count = 1;
  // Each process is discovered through the captured browser's child tree.
  for (int i = 0; i < count; i++) {
    pid_t children[MAX_PROCESSES];
    int n = proc_listchildpids(pids[i], children, sizeof(children));
    // Unlike proc_listpids, proc_listchildpids returns a PID count, not bytes.
    if (n < 0 || n >= MAX_PROCESSES) return -1;
    for (int j = 0; j < n; j++) {
      if (children[j] <= 0) continue;
      int found = 0;
      for (int k = 0; k < count; k++) if (pids[k] == children[j]) found = 1;
      if (!found) { if (count == MAX_PROCESSES) return -1; pids[count++] = children[j]; }
    }
  }
  if (qos_class_self() != QOS_CLASS_USER_INITIATED) return -1;
  printf("{\"atMs\":%.6f,\"scheduling\":\"user-initiated\",\"processes\":[", now_ms());
  for (int i = 0; i < count; i++) {
    if (i) putchar(',');
    struct rusage_info_v4 r;
    if (usage(pids[i], &r)) printf("{\"pid\":%d,\"error\":%d}", pids[i], errno);
    else fields(pids[i], &r);
  }
  printf("],\"endMs\":%.6f}\n", now_ms()); fflush(stdout);
  return 0;
}
static int control(void) {
  struct rusage_info_v4 before, after;
  if (usage(getpid(), &before)) return 1;
  const size_t bytes = 48 * 1024 * 1024;
  volatile unsigned char *p = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (p == MAP_FAILED) return 1;
  for (size_t i = 0; i < bytes; i += (size_t)getpagesize()) p[i] = 1;
  if (munmap((void *)p, bytes) || usage(getpid(), &after)) return 1;
  printf("{\"allocatedBytes\":%zu,\"before\":", bytes); fields(getpid(), &before);
  printf(",\"afterFree\":"); fields(getpid(), &after); puts("}");
  return 0;
}
static int tree_control(void) {
  int ready[2], release[2];
  if (pipe(ready) || pipe(release)) return 1;
  pid_t child = fork();
  if (child < 0) return 1;
  if (child == 0) {
    close(ready[0]); close(release[1]);
    const size_t bytes = 48 * 1024 * 1024;
    volatile unsigned char *p = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (p == MAP_FAILED) _exit(1);
    for (size_t i = 0; i < bytes; i += (size_t)getpagesize()) p[i] = 1;
    char command = 'r';
    if (write(ready[1], &command, 1) != 1 || read(release[0], &command, 1) != 1) _exit(1);
    _exit(0);
  }
  close(ready[1]); close(release[0]);
  char command;
  int result = read(ready[0], &command, 1) != 1;
  if (!result) {
    printf("{\"childPid\":%d,\"allocatedBytes\":%d}\n", child, 48 * 1024 * 1024);
    result = sample(getpid()) != 0;
  }
  command = 'q'; if (write(release[1], &command, 1) != 1) result = 1;
  close(release[1]); close(ready[0]);
  int status; if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) result = 1;
  return result;
}
int main(int argc, char **argv) {
  // Only this test collector thread changes QoS. Keep the coverage ceiling
  // unchanged and fail closed if the OS cannot admit the declared scheduling.
  if (pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0)) return 6;
  if (argc == 2 && strcmp(argv[1], "--allocation-control") == 0) return control();
  if (argc == 2 && strcmp(argv[1], "--tree-control") == 0) return tree_control();
  if (argc != 3) return 2;
  char *end;
  long pid = strtol(argv[1], &end, 10); if (*end || pid <= 1) return 2;
  long interval = strtol(argv[2], &end, 10); if (*end || interval < 1 || interval > 1000) return 2;
  struct pollfd input = { STDIN_FILENO, POLLIN, 0 };
  double start = now_ms();
  for (;;) {
    if (sample((pid_t)pid)) return 3;
    int ready = poll(&input, 1, (int)interval);
    if (ready < 0) return 4;
    if (ready) {
      char command;
      if (read(STDIN_FILENO, &command, 1) != 1 || command != 'q') return 5;
      if (sample((pid_t)pid)) return 3;
      puts("{\"stopped\":\"requested\"}"); return 0;
    }
    // Orphan/blocked harnesses cannot leave an unbounded sampler behind.
    if (now_ms() - start > 180000) return 6;
  }
}
