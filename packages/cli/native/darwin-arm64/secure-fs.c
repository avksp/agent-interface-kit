#define _DARWIN_C_SOURCE
#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

enum { MAX_FILE_BYTES = 32 * 1024 * 1024 };
static const int directory_flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;

typedef struct {
  int fd;
  dev_t device;
} Directory;

static napi_value io_error(napi_env env, int error) {
  const char *code = "UNSAFE_FS";
  switch (error) {
    case ENOENT: code = "ENOENT"; break;
    case EEXIST: code = "EEXIST"; break;
    case EFBIG: code = "EFBIG"; break;
    case E2BIG: code = "ENTRY_LIMIT"; break;
    case EIO: code = "EIO"; break;
    case EFTYPE: code = "INVALID_FILE"; break;
    case ELOOP: code = "ELOOP"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case EAGAIN: code = "EAGAIN"; break;
    case ENOTSUP:
    case ENOSYS: code = "ENOTSUP"; break;
    case EACCES:
    case EPERM: code = "EACCES"; break;
  }
  napi_throw_error(env, code, "Secure filesystem operation refused");
  return NULL;
}

static napi_value invalid(napi_env env) {
  napi_throw_type_error(env, NULL, "Invalid secure filesystem argument");
  return NULL;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  return napi_get_undefined(env, &result) == napi_ok ? result : NULL;
}

static bool arguments(napi_env env, napi_callback_info info, size_t count, napi_value *values) {
  size_t actual = count;
  return napi_get_cb_info(env, info, &actual, values, NULL, NULL) == napi_ok && actual == count;
}

static bool string_value(napi_env env, napi_value value, char *text, size_t capacity) {
  size_t length = 0;
  size_t copied = 0;
  return napi_get_value_string_utf8(env, value, NULL, 0, &length) == napi_ok &&
    length > 0 && length < capacity &&
    napi_get_value_string_utf8(env, value, text, capacity, &copied) == napi_ok &&
    copied == length && strlen(text) == length;
}

static bool is_component(const char *name) {
  return name[0] != '\0' && strchr(name, '/') == NULL &&
    strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}

static bool component(napi_env env, napi_value value, char name[NAME_MAX + 1]) {
  return string_value(env, value, name, NAME_MAX + 1) && is_component(name);
}

static Directory *directory(napi_env env, napi_value value) {
  void *data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == NULL) return NULL;
  Directory *dir = data;
  return dir->fd >= 0 ? dir : NULL;
}

static void finalize_directory(napi_env env, void *data, void *hint) {
  (void) env;
  (void) hint;
  Directory *dir = data;
  if (dir->fd >= 0) close(dir->fd);
  free(dir);
}

static napi_value directory_value(napi_env env, int fd, dev_t device) {
  Directory *dir = malloc(sizeof(*dir));
  if (dir == NULL) {
    close(fd);
    return io_error(env, ENOMEM);
  }
  *dir = (Directory) { .fd = fd, .device = device };
  napi_value value;
  if (napi_create_external(env, dir, finalize_directory, NULL, &value) != napi_ok) {
    finalize_directory(env, dir, NULL);
    return NULL;
  }
  return value;
}

static napi_value open_root(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  char path[PATH_MAX];
  if (!arguments(env, info, 1, argv) || !string_value(env, argv[0], path, sizeof(path)) || path[0] != '/') {
    return invalid(env);
  }
  int fd = open("/", directory_flags);
  if (fd < 0) return io_error(env, errno);
  char *rest;
  for (char *name = strtok_r(path, "/", &rest); name != NULL; name = strtok_r(NULL, "/", &rest)) {
    if (!is_component(name)) {
      close(fd);
      return invalid(env);
    }
    int next = openat(fd, name, directory_flags);
    int error = errno;
    close(fd);
    if (next < 0) return io_error(env, error);
    fd = next;
  }
  struct stat stat;
  if (fstat(fd, &stat) < 0) {
    int error = errno;
    close(fd);
    return io_error(env, error);
  }
  return directory_value(env, fd, stat.st_dev);
}

static bool directory_arguments(napi_env env, napi_callback_info info, size_t count,
    napi_value *argv, Directory **dir, char name[NAME_MAX + 1]) {
  if (!arguments(env, info, count, argv)) return false;
  *dir = directory(env, argv[0]);
  return *dir != NULL && component(env, argv[1], name);
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  Directory *dir;
  char name[NAME_MAX + 1];
  if (!directory_arguments(env, info, 2, argv, &dir, name)) return invalid(env);
  int fd = openat(dir->fd, name, directory_flags);
  if (fd < 0) return io_error(env, errno);
  struct stat stat;
  if (fstat(fd, &stat) < 0 || stat.st_dev != dir->device) {
    close(fd);
    return io_error(env, EINVAL);
  }
  return directory_value(env, fd, dir->device);
}

static napi_value close_directory(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!arguments(env, info, 1, argv)) return invalid(env);
  Directory *dir = directory(env, argv[0]);
  if (dir == NULL) return invalid(env);
  const int fd = dir->fd;
  dir->fd = -1;
  return close(fd) == 0 ? undefined(env) : io_error(env, errno);
}

static int file_status(int fd, const Directory *dir, struct stat *stat) {
  if (fstat(fd, stat) < 0) return errno;
  return S_ISREG(stat->st_mode) && stat->st_nlink == 1 &&
    stat->st_dev == dir->device && stat->st_size >= 0 ? 0 : EFTYPE;
}

static bool same_time(struct timespec a, struct timespec b) {
  return a.tv_sec == b.tv_sec && a.tv_nsec == b.tv_nsec;
}

static bool same_file(const struct stat *before, const struct stat *after) {
  return before->st_ino == after->st_ino && before->st_size == after->st_size &&
    same_time(before->st_mtimespec, after->st_mtimespec) &&
    same_time(before->st_ctimespec, after->st_ctimespec);
}

static int transfer(int fd, void *buffer, size_t bytes, bool writing) {
  size_t offset = 0;
  while (offset < bytes) {
    char *next = (char *) buffer + offset;
    ssize_t count = writing ? write(fd, next, bytes - offset) : read(fd, next, bytes - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return errno;
    if (count == 0) return EFTYPE;
    offset += (size_t) count;
  }
  return 0;
}

static napi_value read_file(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t count = 4;
  if (napi_get_cb_info(env, info, &count, argv, NULL, NULL) != napi_ok ||
      (count != 3 && count != 4)) return invalid(env);
  Directory *dir = directory(env, argv[0]);
  char name[NAME_MAX + 1];
  double limit;
  bool compare_lock = false;
  if (!dir || !component(env, argv[1], name) ||
      napi_get_value_double(env, argv[2], &limit) != napi_ok ||
      !(limit >= 0 && limit <= MAX_FILE_BYTES) || (size_t) limit != limit ||
      (count == 4 && napi_get_value_bool(env, argv[3], &compare_lock) != napi_ok)) return invalid(env);
  int fd = openat(dir->fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return io_error(env, errno);
  struct stat before;
  int error = file_status(fd, dir, &before);
  if (error != 0) {
    close(fd);
    return io_error(env, compare_lock ? error : EINVAL);
  }
  if (before.st_size > limit) {
    close(fd);
    return io_error(env, EFBIG);
  }
  napi_value result;
  void *data;
  if (napi_create_buffer(env, (size_t) before.st_size, &data, &result) != napi_ok) {
    close(fd);
    return NULL;
  }
  error = transfer(fd, data, (size_t) before.st_size, false);
  if (error == 0) {
    struct stat after;
    error = file_status(fd, dir, &after);
    if (error == 0 && !same_file(&before, &after)) error = EFTYPE;
  }
  const int closed = close(fd);
  if (error != 0) return io_error(env, compare_lock ? error : EINVAL);
  if (closed < 0 && compare_lock) return io_error(env, errno);
  return result;
}

static napi_value write_file(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  Directory *dir;
  char name[NAME_MAX + 1];
  void *data;
  size_t bytes;
  if (!directory_arguments(env, info, 3, argv, &dir, name) ||
      napi_get_buffer_info(env, argv[2], &data, &bytes) != napi_ok || bytes > MAX_FILE_BYTES) return invalid(env);
  int fd = openat(dir->fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return io_error(env, errno);
  bool complete = transfer(fd, data, bytes, true) == 0;
  if (close(fd) < 0) complete = false;
  return complete ? undefined(env) : io_error(env, EINVAL);
}

static napi_value create_directory(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  Directory *dir;
  char name[NAME_MAX + 1];
  if (!directory_arguments(env, info, 2, argv, &dir, name)) return invalid(env);
  return mkdirat(dir->fd, name, 0700) == 0 ? undefined(env) : io_error(env, errno);
}

static bool same_directory(const struct stat *a, const struct stat *b) {
  return S_ISDIR(b->st_mode) && a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static bool supports_exclusive_rename(int fd) {
  struct attrlist attributes = {
    .bitmapcount = ATTR_BIT_MAP_COUNT, .volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES,
  };
  struct {
    uint32_t length;
    vol_capabilities_attr_t values;
  } result = {0};
  if (fgetattrlist(fd, &attributes, &result, sizeof(result), 0) != 0 || result.length != sizeof(result)) {
    return false;
  }
  const int slot = VOL_CAPABILITIES_INTERFACES;
  return (result.values.valid[slot] & result.values.capabilities[slot] & VOL_CAP_INT_RENAME_EXCL) != 0;
}

static napi_value qualify_lock_staging(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!arguments(env, info, 2, argv)) return invalid(env);
  Directory *capture = directory(env, argv[0]);
  Directory *parent = directory(env, argv[1]);
  if (!capture || !parent) return invalid(env);
  struct stat root, stage, current;
  struct statfs volume;
  if (fstat(capture->fd, &root) || fstat(parent->fd, &stage) || fstatfs(parent->fd, &volume)) {
    return io_error(env, errno);
  }
  if (!S_ISDIR(stage.st_mode) || stage.st_nlink == 0 || root.st_dev != stage.st_dev ||
      same_directory(&root, &stage) || stage.st_uid != geteuid() || (stage.st_mode & 07777) != 0700 ||
      (volume.f_flags & (MNT_IGNORE_OWNERSHIP | MNT_RDONLY)) != 0) {
    return io_error(env, EACCES);
  }
  acl_t acl = acl_get_fd_np(parent->fd, ACL_TYPE_EXTENDED);
  if (acl != NULL) {
    acl_free(acl);
    return io_error(env, EACCES);
  }
  const int acl_error = errno;
  if (acl_error != ENOENT) {
    const bool unsupported = acl_error == ENOTSUP || acl_error == EOPNOTSUPP || acl_error == ENOSYS;
    return io_error(env, unsupported ? ENOTSUP : EIO);
  }
  if (fstat(parent->fd, &current) != 0) return io_error(env, errno);
  if (!same_directory(&stage, &current) || current.st_nlink == 0 ||
      current.st_uid != stage.st_uid || current.st_mode != stage.st_mode) return io_error(env, EACCES);
  return supports_exclusive_rename(capture->fd) ? undefined(env) : io_error(env, ENOTSUP);
}

static napi_value acquire_lock_guard(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!arguments(env, info, 1, argv)) return invalid(env);
  Directory *root = directory(env, argv[0]);
  if (!root) return invalid(env);
  const int fd = openat(root->fd, ".", directory_flags);
  if (fd < 0) return io_error(env, errno);
  struct stat expected, opened;
  int error = 0;
  if (fstat(root->fd, &expected) || fstat(fd, &opened)) {
    error = errno;
  } else if (!same_directory(&expected, &opened)) {
    error = EINVAL;
  } else if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    error = errno == EOPNOTSUPP ? ENOTSUP : errno;
  }
  if (error != 0) {
    close(fd);
    return io_error(env, error);
  }
  return directory_value(env, fd, opened.st_dev);
}

typedef struct {
  struct stat parent;
  struct stat child;
  bool present;
  char name[sizeof(".aik-lock-0000000000000000")];
} LockStage;

static const napi_type_tag stage_tag = {0xe3001eb528956147ULL, 0xba51a704197d8986ULL};

static void finalize_lock_stage(napi_env env, void *data, void *hint) {
  (void) env;
  (void) hint;
  free(data);
}

static napi_value create_lock_stage(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!arguments(env, info, 1, argv)) return invalid(env);
  Directory *dir = directory(env, argv[0]);
  if (!dir) return invalid(env);
  napi_value token;
  if (napi_create_object(env, &token) != napi_ok ||
      napi_type_tag_object(env, token, &stage_tag) != napi_ok) return NULL;
  LockStage *stage = calloc(1, sizeof(*stage));
  if (!stage) return io_error(env, ENOMEM);
  if (napi_wrap(env, token, stage, finalize_lock_stage, NULL, NULL) != napi_ok) {
    free(stage);
    return NULL;
  }
  if (fstat(dir->fd, &stage->parent) != 0) return io_error(env, errno);
  for (int attempt = 0; attempt < 8; attempt++) {
    snprintf(stage->name, sizeof(stage->name), ".aik-lock-%08x%08x", arc4random(), arc4random());
    if (mkdirat(dir->fd, stage->name, 0700) == 0) {
      if (fstatat(dir->fd, stage->name, &stage->child, AT_SYMLINK_NOFOLLOW) != 0 ||
          !S_ISDIR(stage->child.st_mode) || stage->child.st_dev != stage->parent.st_dev) {
        napi_throw_error(env, "UNVERIFIED_STAGE", "Lock stage identity is unavailable");
        return NULL;
      }
      stage->present = true;
      return token;
    }
    if (errno != EEXIST) return io_error(env, errno);
  }
  return io_error(env, EEXIST);
}

static LockStage *stage_value(napi_env env, napi_value value) {
  bool tagged = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, &stage_tag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, value, &data) != napi_ok || !data) return NULL;
  LockStage *stage = data;
  return stage->present ? stage : NULL;
}

static bool stage_parent(Directory *parent, LockStage *stage) {
  struct stat held;
  return fstat(parent->fd, &held) == 0 && same_directory(&stage->parent, &held);
}

static napi_value open_lock_stage(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!arguments(env, info, 2, argv)) return invalid(env);
  Directory *parent = directory(env, argv[0]);
  LockStage *stage = stage_value(env, argv[1]);
  if (!parent || !stage || !stage_parent(parent, stage)) return invalid(env);
  const int fd = openat(parent->fd, stage->name, directory_flags);
  if (fd < 0) return io_error(env, errno);
  struct stat opened;
  if (fstat(fd, &opened) != 0 || !same_directory(&stage->child, &opened)) {
    close(fd);
    return io_error(env, EINVAL);
  }
  return directory_value(env, fd, opened.st_dev);
}

static napi_value remove_lock_stage(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!arguments(env, info, 2, argv)) return invalid(env);
  Directory *parent = directory(env, argv[0]);
  LockStage *stage = stage_value(env, argv[1]);
  if (!parent || !stage || !stage_parent(parent, stage)) return invalid(env);
  struct stat child;
  if (fstatat(parent->fd, stage->name, &child, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) return io_error(env, errno);
  } else {
    if (!same_directory(&stage->child, &child)) return io_error(env, EINVAL);
    if (unlinkat(parent->fd, stage->name, AT_REMOVEDIR) != 0 && errno != ENOENT) return io_error(env, errno);
  }
  stage->present = false;
  return undefined(env);
}

static napi_value unlink_entry(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  Directory *dir;
  char name[NAME_MAX + 1];
  bool is_dir;
  if (!directory_arguments(env, info, 3, argv, &dir, name) ||
      napi_get_value_bool(env, argv[2], &is_dir) != napi_ok) return invalid(env);
  return unlinkat(dir->fd, name, is_dir ? AT_REMOVEDIR : 0) == 0 ? undefined(env) : io_error(env, errno);
}

static napi_value rename_exclusive(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  Directory *from;
  char old_name[NAME_MAX + 1];
  char new_name[NAME_MAX + 1];
  if (!directory_arguments(env, info, 4, argv, &from, old_name) ||
      !component(env, argv[3], new_name)) return invalid(env);
  Directory *to = directory(env, argv[2]);
  if (to == NULL || from->device != to->device) return invalid(env);
  if (renameatx_np(from->fd, old_name, to->fd, new_name, RENAME_EXCL) == 0) return undefined(env);
  const int error = errno;
  return io_error(env, error == EOPNOTSUPP ? ENOTSUP : error);
}

static napi_value visit(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t count = 3;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &count, argv, NULL, NULL) != napi_ok ||
      (count != 2 && count != 3) || napi_typeof(env, argv[1], &type) != napi_ok ||
      type != napi_function) return invalid(env);
  const bool bounded = count == 3;
  double limit = 0;
  if (bounded && (napi_get_value_double(env, argv[2], &limit) != napi_ok ||
      !(limit >= 1 && limit <= UINT32_MAX) || (uint32_t) limit != limit)) return invalid(env);
  uint32_t remaining = (uint32_t) limit;
  Directory *dir = directory(env, argv[0]);
  if (dir == NULL) return invalid(env);
  int fd = openat(dir->fd, ".", directory_flags);
  if (fd < 0) return io_error(env, errno);
  DIR *reader = fdopendir(fd);
  if (reader == NULL) {
    int error = errno;
    close(fd);
    return io_error(env, error);
  }
  int error = 0;
  napi_value receiver = undefined(env);
  for (;;) {
    errno = 0;
    const struct dirent *entry = readdir(reader);
    if (entry == NULL) {
      error = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (bounded) {
      if (remaining == 0) {
        error = E2BIG;
        break;
      }
      remaining--;
    }
    if (!is_component(entry->d_name)) continue;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
      closedir(reader);
      return NULL;
    }
    napi_value name;
    napi_status status = napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_call_function(env, receiver, argv[1], 1, &name, NULL);
    napi_close_handle_scope(env, scope);
    if (status != napi_ok) {
      closedir(reader);
      return NULL;
    }
  }
  if (closedir(reader) < 0 && bounded && error == 0) error = errno;
  return error == 0 ? undefined(env) : io_error(env, error);
}

#define METHOD(name, function) { name, NULL, function, NULL, NULL, NULL, napi_default, NULL }

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    METHOD("openRoot", open_root),
    METHOD("openDirectory", open_directory),
    METHOD("closeDirectory", close_directory),
    METHOD("readFile", read_file),
    METHOD("writeFile", write_file),
    METHOD("createDirectory", create_directory),
    METHOD("qualifyLockStaging", qualify_lock_staging),
    METHOD("acquireLockGuard", acquire_lock_guard),
    METHOD("createLockStage", create_lock_stage),
    METHOD("openLockStage", open_lock_stage),
    METHOD("removeLockStage", remove_lock_stage),
    METHOD("unlinkEntry", unlink_entry),
    METHOD("renameExclusive", rename_exclusive),
    METHOD("visit", visit),
  };
  return napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) == napi_ok
    ? exports : NULL;
}

NAPI_MODULE(secure_fs, initialize)
