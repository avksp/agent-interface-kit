import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const imageTool = "/usr/bin/hdiutil";

/**
 * @param {(mount: string) => Promise<void>} use
 * @param {"on" | "off"} [owners]
 */
export async function onApfsx(use, owners = "on") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "aik-apfsx-"));
  const mount = join(root, "volume");
  const image = join(root, "case.sparseimage");
  const options = { timeout: 25_000 };
  await mkdir(mount);
  const initialDevice = (await lstat(mount)).dev;
  try {
    await execute(imageTool, ["create", "-type", "SPARSE", "-size", "256m", "-fs", "Case-sensitive APFS",
      "-volname", "AIK-Case-Proof", image], options);
    await execute(imageTool, ["attach", "-owners", owners, "-nobrowse", "-mountpoint", mount, image], options);
    assert.notEqual((await lstat(mount)).dev, initialDevice);
    await use(mount);
  } finally {
    if ((await lstat(mount)).dev !== initialDevice) await execute(imageTool, ["detach", mount], options);
    assert.equal((await lstat(mount)).dev, initialDevice);
    await rm(root, { recursive: true });
  }
}

/**
 * @param {unknown} value
 * @param {import("@aik/compile-core/writer").SecureFs} interfaceSample
 * @returns {value is import("@aik/compile-core/writer").SecureFs}
 */
function matchesSecureFs(value, interfaceSample) {
  return typeof value === "object" && value !== null &&
    Object.getOwnPropertyNames(interfaceSample).every((method) => typeof Reflect.get(value, method) === "function");
}

/**
 * Build a test-only copy of the production translation unit with controlled query results.
 * @param {string} root
 * @param {import("@aik/compile-core/writer").SecureFs} interfaceSample
 * @returns {Promise<import("@aik/compile-core/writer").SecureFs>}
 */
export async function buildQualificationProbe(root, interfaceSample) {
  const nativeSource = fileURLToPath(new URL("../../../../packages/cli/native/darwin-arm64/secure-fs.c", import.meta.url));
  const probe = join(root, "qualification.c");
  const addon = join(root, "qualification.node");
  await writeFile(probe, `
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>
static int probe_attributes(int fd, void *attributes, void *buffer, size_t size, unsigned long options) {
  const int result = fgetattrlist(fd, attributes, buffer, size, options);
  const char *fault = getenv("AIK_TEST_QUALIFICATION_FAULT");
  if (result || !fault) return result;
  struct { uint32_t length; vol_capabilities_attr_t values; } *value = buffer;
  if (!strcmp(fault, "clear")) value->values.capabilities[VOL_CAPABILITIES_INTERFACES] &= ~VOL_CAP_INT_RENAME_EXCL;
  if (!strcmp(fault, "invalid")) value->values.valid[VOL_CAPABILITIES_INTERFACES] &= ~VOL_CAP_INT_RENAME_EXCL;
  if (!strcmp(fault, "short")) value->length -= sizeof(uint32_t);
  if (!strcmp(fault, "query")) { errno = EIO; return -1; }
  return result;
}
static acl_t probe_acl(int fd, acl_type_t type) {
  const char *fault = getenv("AIK_TEST_QUALIFICATION_FAULT");
  if (fault && !strcmp(fault, "acl")) { errno = EBADF; return NULL; }
  if (fault && !strcmp(fault, "acl-unsupported")) { errno = EOPNOTSUPP; return NULL; }
  if (fault && !strcmp(fault, "empty-acl")) {
    acl_t empty = acl_init(0);
    if (!empty) return NULL;
    const int result = acl_set_fd_np(fd, empty, type);
    acl_free(empty);
    if (result != 0) { errno = EIO; return NULL; }
  }
  return acl_get_fd_np(fd, type);
}
static unsigned observed_stats, observed_reads, observed_writes;
static const char *transfer_fault(void) {
  return getenv("AIK_TEST_TRANSFER_FAULT");
}
static int probe_stat(int fd, struct stat *value) {
  const char *fault = transfer_fault();
  if (!fault) return fstat(fd, value);
  observed_stats++;
  if ((!strcmp(fault, "initial-stat") && observed_stats == 1) ||
      (!strcmp(fault, "final-stat") && observed_stats == 2)) { errno = EIO; return -1; }
  const int result = fstat(fd, value);
  if (!result && observed_stats == 2 && !strcmp(fault, "unstable")) value->st_ctimespec.tv_nsec ^= 1;
  return result;
}
static ssize_t probe_read(int fd, void *bytes, size_t count) {
  const char *fault = transfer_fault();
  if (!fault) return read(fd, bytes, count);
  if (!strcmp(fault, "read-error") || !strcmp(fault, "read-close")) { errno = EIO; return -1; }
  if (!strcmp(fault, "early-eof")) { errno = EIO; return 0; }
  if (!strcmp(fault, "short-read") && observed_reads++ == 0 && count > 1) count = 1;
  return read(fd, bytes, count);
}
static ssize_t probe_write(int fd, const void *bytes, size_t count) {
  const char *fault = transfer_fault();
  if (fault && !strcmp(fault, "short-write") && observed_writes++ == 0 && count > 1) count = 1;
  return write(fd, bytes, count);
}
static int probe_close(int fd) {
  const char *fault = transfer_fault();
  const int result = close(fd);
  const int close_error = errno;
  if (!fault) return result;
  const char *trace = getenv("AIK_TEST_TRANSFER_TRACE");
  FILE *log = trace ? fopen(trace, "a") : NULL;
  if (!log || fprintf(log, "%u,%u,%u;", observed_stats, observed_reads, observed_writes) < 0 || fclose(log)) abort();
  observed_stats = observed_reads = observed_writes = 0;
  if (result) { errno = close_error; return result; }
  if (!strcmp(fault, "read-close")) { errno = ENOENT; return -1; }
  if (!strcmp(fault, "close")) { errno = EIO; return -1; }
  return 0;
}
static int probe_rename(int from, const char *name, int to, const char *destination, unsigned int flags) {
  const char *fault = getenv("AIK_TEST_RENAME_FAULT");
  if (!fault) return renameatx_np(from, name, to, destination, flags);
  if (!strcmp(fault, "ENOTSUP")) { errno = ENOTSUP; return -1; }
  if (!strcmp(fault, "EOPNOTSUPP")) { errno = EOPNOTSUPP; return -1; }
  if (!strcmp(fault, "EIO")) { errno = EIO; return -1; }
  return renameatx_np(from, name, to, destination, flags);
}
#define renameatx_np probe_rename
#define fstat probe_stat
#define read probe_read
#define write probe_write
#define close probe_close
#define fgetattrlist probe_attributes
#define acl_get_fd_np probe_acl
#include ${JSON.stringify(nativeSource)}
`);
  const options = { timeout: 25_000 };
  const { stdout } = await execute("/usr/bin/xcrun", ["--show-sdk-path"], options);
  const headers = resolve(process.execPath, "../../include/node");
  await execute("/usr/bin/xcrun", ["clang", "-isysroot", stdout.trim(), "-arch", "arm64", "-std=c17", "-O2",
    "-Wall", "-Wextra", "-Werror", "-fvisibility=hidden", "-bundle", "-undefined", "dynamic_lookup", "-I", headers,
    probe, "-o", addon], options);
  const require = createRequire(import.meta.url);
  /** @type {unknown} */
  const loaded = require(addon);
  assert.ok(matchesSecureFs(loaded, interfaceSample));
  return loaded;
}
