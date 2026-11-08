// File system calls for the Node `fs` surface. Each operation is plain POSIX so errors carry the
// errno Node would report; the JS side decides sync or async.
import Foundation
import JavaScriptCore

enum HostFS {
  static func install(in runtime: JSRuntime) {
    let sync: @convention(block) (String, JSValue, JSValue) -> JSValue = { op, args, data in
      let context = JSContext.current()!
      do { return JSRuntime.value(try perform(op, arguments(args), JSRuntime.data(of: data)), in: context) }
      catch let error as HostError { context.exception = JSRuntime.errorValue(error, in: context); return JSValue(undefinedIn: context) }
      catch { JSRuntime.throwError("\(error)"); return JSValue(undefinedIn: context) }
    }
    runtime.define("fsSync", sync)
    let async: @convention(block) (String, JSValue, JSValue, JSValue) -> Void = { [unowned runtime] op, args, data, callback in
      let input = arguments(args)
      let bytes = JSRuntime.data(of: data)
      runtime.io.async {
        let result: Result<Any?, HostError>
        do { result = .success(try perform(op, input, bytes)) }
        catch let error as HostError { result = .failure(error) }
        catch { result = .failure(HostError(message: "\(error)")) }
        runtime.perform {
          let context = runtime.context!
          switch result {
          case .success(let value): callback.call(withArguments: [NSNull(), JSRuntime.value(value, in: context)])
          case .failure(let error): callback.call(withArguments: [JSRuntime.errorValue(error, in: context)])
          }
        }
      }
    }
    runtime.define("fsAsync", async)
  }

  private static func arguments(_ value: JSValue) -> [Any] { value.isArray ? (value.toArray() ?? []) : [] }

  private static func string(_ args: [Any], _ index: Int) throws -> String {
    guard let value = args.string(index) else { throw HostError(message: "argument \(index) must be a string", code: "ERR_INVALID_ARG_TYPE") }
    return value
  }
  private static func number(_ args: [Any], _ index: Int, _ fallback: Int = 0) -> Int { args.int(index) ?? fallback }
  private static func flag(_ args: [Any], _ index: Int) -> Bool { args.bool(index) ?? false }

  private static func entryName(_ entry: UnsafeMutablePointer<dirent>) -> String {
    withUnsafePointer(to: entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
  }

  /// Open flags as Node accepts them: a string ("w", "ax+") or the numeric `fs.constants` bits,
  /// which on macOS are the system's own values.
  private static func flagValue(_ args: [Any], _ index: Int, _ fallback: String) throws -> Int32 {
    guard index < args.count else { return try openFlags(fallback) }
    if let number = args[index] as? NSNumber, !(args[index] is String) { return number.int32Value }
    return try openFlags(args[index] as? String ?? fallback)
  }

  static func openFlags(_ flags: String) throws -> Int32 {
    switch flags {
    case "r": return O_RDONLY
    case "r+": return O_RDWR
    case "rs+": return O_RDWR | O_SYNC
    case "w": return O_WRONLY | O_CREAT | O_TRUNC
    case "wx", "xw": return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL
    case "w+": return O_RDWR | O_CREAT | O_TRUNC
    case "wx+", "xw+": return O_RDWR | O_CREAT | O_TRUNC | O_EXCL
    case "a": return O_WRONLY | O_CREAT | O_APPEND
    case "ax", "xa": return O_WRONLY | O_CREAT | O_APPEND | O_EXCL
    case "a+": return O_RDWR | O_CREAT | O_APPEND
    case "ax+", "xa+": return O_RDWR | O_CREAT | O_APPEND | O_EXCL
    default: throw HostError(message: "Unknown file open flag: \(flags)", code: "ERR_INVALID_ARG_VALUE")
    }
  }

  private static func statDictionary(_ info: stat) -> [String: Any] {
    func ms(_ time: timespec) -> Double { Double(time.tv_sec) * 1000 + Double(time.tv_nsec) / 1e6 }
    let type = info.st_mode & S_IFMT
    return [
      "dev": Int(info.st_dev), "ino": Int(info.st_ino), "mode": Int(info.st_mode), "nlink": Int(info.st_nlink),
      "uid": Int(info.st_uid), "gid": Int(info.st_gid), "rdev": Int(info.st_rdev), "size": Int(info.st_size),
      "blksize": Int(info.st_blksize), "blocks": Int(info.st_blocks),
      "atimeMs": ms(info.st_atimespec), "mtimeMs": ms(info.st_mtimespec), "ctimeMs": ms(info.st_ctimespec), "birthtimeMs": ms(info.st_birthtimespec),
      // Whole seconds and nanoseconds apart, so { bigint: true } keeps every digit a Double would round away.
      "times": [info.st_atimespec, info.st_mtimespec, info.st_ctimespec, info.st_birthtimespec].flatMap { [Int($0.tv_sec), Int($0.tv_nsec)] },
      "isFile": type == S_IFREG, "isDirectory": type == S_IFDIR, "isSymbolicLink": type == S_IFLNK,
      "isFIFO": type == S_IFIFO, "isSocket": type == S_IFSOCK, "isBlockDevice": type == S_IFBLK, "isCharacterDevice": type == S_IFCHR
    ]
  }

  private static func readAll(_ fd: Int32, path: String?) throws -> Data {
    var result = Data()
    var info = stat()
    if fstat(fd, &info) == 0, info.st_size > 0 { result.reserveCapacity(Int(info.st_size)) }
    var buffer = [UInt8](repeating: 0, count: 1 << 16)
    while true {
      let count = read(fd, &buffer, buffer.count)
      if count < 0 { if errno == EINTR { continue }; throw HostError.posix(errno, "read", path) }
      if count == 0 { break }
      result.append(buffer, count: count)
    }
    return result
  }

  private static func writeAll(_ fd: Int32, _ data: Data, position: Int?, path: String?) throws -> Int {
    var written = 0
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      while written < data.count {
        let count = position.map { pwrite(fd, base.advanced(by: written), data.count - written, off_t($0 + written)) }
          ?? write(fd, base.advanced(by: written), data.count - written)
        if count < 0 { if errno == EINTR { continue }; throw HostError.posix(errno, "write", path) }
        written += count
      }
    }
    return written
  }

  /// Node's rm. With force, an entry that disappears while the tree is being removed is not an error.
  /// Below the top folder every step is relative to a folder already opened without following links,
  /// so a folder swapped for a link part way through never leads the removal outside the tree.
  private static func removeTree(_ path: String, force: Bool = false, recursive: Bool = true) throws {
    var info = stat()
    guard lstat(path, &info) == 0 else {
      if errno == ENOENT && force { return }
      throw HostError.posix(errno, "lstat", path)
    }
    if info.st_mode & S_IFMT == S_IFDIR {
      guard recursive else { throw HostError(message: "Path is a directory: rm returned EISDIR (is a directory) \(path)", code: "ERR_FS_EISDIR", errno: EISDIR, syscall: "rm", path: path) }
      let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else {
        if errno == ENOENT && force { return }
        throw HostError.posix(errno == ELOOP ? ENOTDIR : errno, "opendir", path)
      }
      try emptyDirectory(fd, path: path, force: force)
      guard rmdir(path) == 0 || (errno == ENOENT && force) else { throw HostError.posix(errno, "rmdir", path) }
    } else {
      guard unlink(path) == 0 || (errno == ENOENT && force) else { throw HostError.posix(errno, "unlink", path) }
    }
  }

  /// Removes everything inside the open folder `fd`, then closes it. `path` only names it in errors.
  private static func emptyDirectory(_ fd: Int32, path: String, force: Bool) throws {
    guard let directory = fdopendir(fd) else { let failure = errno; close(fd); throw HostError.posix(failure, "opendir", path) }
    var names: [String] = []
    while let entry = readdir(directory) {
      let name = entryName(entry)
      if name != "." && name != ".." { names.append(name) }
    }
    defer { closedir(directory) }
    for name in names {
      let child = path + "/" + name
      var info = stat()
      guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        if errno == ENOENT && force { continue }
        throw HostError.posix(errno, "lstat", child)
      }
      if info.st_mode & S_IFMT == S_IFDIR {
        let inner = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard inner >= 0 else {
          if errno == ENOENT && force { continue }
          throw HostError.posix(errno == ELOOP ? ENOTDIR : errno, "opendir", child)
        }
        try emptyDirectory(inner, path: child, force: force)
        guard unlinkat(fd, name, AT_REMOVEDIR) == 0 || (errno == ENOENT && force) else { throw HostError.posix(errno, "rmdir", child) }
      } else {
        guard unlinkat(fd, name, 0) == 0 || (errno == ENOENT && force) else { throw HostError.posix(errno, "unlink", child) }
      }
    }
  }

  private static func makeDirectory(_ path: String, mode: mode_t, recursive: Bool) throws -> String? {
    if mkdir(path, mode) == 0 { return path }
    let failure = errno
    if !recursive { throw HostError.posix(failure, "mkdir", path) }
    if failure == EEXIST {
      var info = stat()
      if stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR { return nil }
      throw HostError.posix(EEXIST, "mkdir", path)
    }
    guard failure == ENOENT else { throw HostError.posix(failure, "mkdir", path) }
    let parent = (path as NSString).deletingLastPathComponent
    guard !parent.isEmpty, parent != path else { throw HostError.posix(failure, "mkdir", path) }
    let first = try makeDirectory(parent, mode: mode, recursive: true)
    if mkdir(path, mode) != 0 && errno != EEXIST { throw HostError.posix(errno, "mkdir", path) }
    return first ?? path
  }

  static func perform(_ op: String, _ args: [Any], _ data: Data?) throws -> Any? {
    switch op {
    case "exists":
      return access(try string(args, 0), F_OK) == 0
    case "access":
      let path = try string(args, 0)
      guard access(path, Int32(number(args, 1, Int(F_OK)))) == 0 else { throw HostError.posix(errno, "access", path) }
      return nil
    case "stat", "lstat":
      let path = try string(args, 0)
      var info = stat()
      guard (op == "stat" ? stat(path, &info) : lstat(path, &info)) == 0 else { throw HostError.posix(errno, op, path) }
      return statDictionary(info)
    case "fstat":
      var info = stat()
      guard fstat(Int32(number(args, 0)), &info) == 0 else { throw HostError.posix(errno, "fstat") }
      return statDictionary(info)
    case "statfs":
      let path = try string(args, 0)
      var info = statfs()
      guard statfs(path, &info) == 0 else { throw HostError.posix(errno, "statfs", path) }
      return ["type": Int(info.f_type), "bsize": Int(info.f_bsize), "blocks": Int(info.f_blocks), "bfree": Int(info.f_bfree),
              "bavail": Int(info.f_bavail), "files": Int(info.f_files), "ffree": Int(info.f_ffree)]
    case "mkdir":
      let path = try string(args, 0)
      return try makeDirectory(path, mode: mode_t(number(args, 2, 0o777)), recursive: flag(args, 1))
    case "readdir":
      let path = try string(args, 0)
      guard let directory = opendir(path) else { throw HostError.posix(errno, "scandir", path) }
      defer { closedir(directory) }
      var entries: [[String: Any]] = []
      while let entry = readdir(directory) {
        let name = entryName(entry)
        if name == "." || name == ".." { continue }
        let kind: String
        switch Int32(entry.pointee.d_type) {
        case DT_REG: kind = "file"
        case DT_DIR: kind = "directory"
        case DT_LNK: kind = "symlink"
        default: kind = "other"
        }
        entries.append(["name": name, "type": kind])
      }
      return entries.sorted { ($0["name"] as! String) < ($1["name"] as! String) }
    case "readFile":
      let path = try string(args, 0)
      let fd = open(path, O_RDONLY | O_CLOEXEC)
      guard fd >= 0 else { throw HostError.posix(errno, "open", path) }
      defer { close(fd) }
      var info = stat()
      if fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR { throw HostError.posix(EISDIR, "read", path) }
      return try readAll(fd, path: path)
    case "writeFile":
      let path = try string(args, 0)
      let flags = try flagValue(args, 1, "w")
      let fd = open(path, flags | O_CLOEXEC, mode_t(number(args, 2, 0o666)))
      guard fd >= 0 else { throw HostError.posix(errno, "open", path) }
      defer { close(fd) }
      _ = try writeAll(fd, data ?? Data(), position: nil, path: path)
      return nil
    case "rename":
      let from = try string(args, 0), to = try string(args, 1)
      guard rename(from, to) == 0 else { throw HostError.posix(errno, "rename", from) }
      return nil
    case "unlink":
      let path = try string(args, 0)
      guard unlink(path) == 0 else { throw HostError.posix(errno, "unlink", path) }
      return nil
    case "rmdir":
      let path = try string(args, 0)
      guard rmdir(path) == 0 else { throw HostError.posix(errno, "rmdir", path) }
      return nil
    case "rm":
      try removeTree(try string(args, 0), force: flag(args, 2), recursive: flag(args, 1))
      return nil
    case "realpath":
      let path = try string(args, 0)
      guard let resolved = realpath(path, nil) else { throw HostError.posix(errno, "realpath", path) }
      defer { free(resolved) }
      return String(cString: resolved)
    case "mkdtemp":
      var template = Array((try string(args, 0) + "XXXXXX").utf8CString)
      guard mkdtemp(&template) != nil else { throw HostError.posix(errno, "mkdtemp") }
      return String(cString: template)
    case "copyFile":
      let from = try string(args, 0), to = try string(args, 1)
      var options = copyfile_flags_t(COPYFILE_ALL)
      if number(args, 2) & 1 != 0 { options |= copyfile_flags_t(COPYFILE_EXCL) }
      guard copyfile(from, to, nil, options) == 0 else { throw HostError.posix(errno, "copyfile", from) }
      return nil
    case "chmod":
      let path = try string(args, 0)
      guard chmod(path, mode_t(number(args, 1))) == 0 else { throw HostError.posix(errno, "chmod", path) }
      return nil
    case "open":
      let path = try string(args, 0)
      let flags = try flagValue(args, 1, "r")
      let fd = open(path, flags | O_CLOEXEC, mode_t(number(args, 2, 0o666)))
      guard fd >= 0 else { throw HostError.posix(errno, "open", path) }
      return Int(fd)
    case "close":
      guard close(Int32(number(args, 0))) == 0 else { throw HostError.posix(errno, "close") }
      return nil
    case "read":
      let fd = Int32(number(args, 0)), length = number(args, 1), position = number(args, 2, -1)
      var buffer = [UInt8](repeating: 0, count: max(length, 0))
      var count: Int
      repeat {
        count = position >= 0 ? pread(fd, &buffer, buffer.count, off_t(position)) : read(fd, &buffer, buffer.count)
      } while count < 0 && errno == EINTR
      guard count >= 0 else { throw HostError.posix(errno, "read") }
      return Data(buffer.prefix(count))
    case "write":
      let fd = Int32(number(args, 0)), position = number(args, 1, -1)
      return try writeAll(fd, data ?? Data(), position: position >= 0 ? position : nil, path: nil)
    case "fchmod":
      guard fchmod(Int32(number(args, 0)), mode_t(number(args, 1))) == 0 else { throw HostError.posix(errno, "fchmod") }
      return nil
    case "fsync":
      guard fsync(Int32(number(args, 0))) == 0 else { throw HostError.posix(errno, "fsync") }
      return nil
    case "ftruncate":
      guard ftruncate(Int32(number(args, 0)), off_t(number(args, 1))) == 0 else { throw HostError.posix(errno, "ftruncate") }
      return nil
    default:
      throw HostError(message: "fs operation \(op) is not available in the native host", code: "ERR_METHOD_NOT_IMPLEMENTED")
    }
  }
}
