// `crypto.createHash`, `randomUUID` and `randomBytes`. Hashes are incremental, so the 1.5 GB model
// is checked in chunks as it is read.
import CryptoKit
import Foundation
import JavaScriptCore

enum HostCrypto {
  private enum Hasher {
    case sha256(SHA256), sha384(SHA384), sha512(SHA512), sha1(Insecure.SHA1), md5(Insecure.MD5)
    mutating func update(_ data: Data) {
      switch self {
      case .sha256(var h): h.update(data: data); self = .sha256(h)
      case .sha384(var h): h.update(data: data); self = .sha384(h)
      case .sha512(var h): h.update(data: data); self = .sha512(h)
      case .sha1(var h): h.update(data: data); self = .sha1(h)
      case .md5(var h): h.update(data: data); self = .md5(h)
      }
    }
    func finalize() -> Data {
      switch self {
      case .sha256(let h): return Data(h.finalize())
      case .sha384(let h): return Data(h.finalize())
      case .sha512(let h): return Data(h.finalize())
      case .sha1(let h): return Data(h.finalize())
      case .md5(let h): return Data(h.finalize())
      }
    }
  }
  private static var hashers: [Int: Hasher] = [:]
  private static var nextId = 1

  static func install(in runtime: JSRuntime) {
    let create: @convention(block) (String) -> Int = { algorithm in
      let hasher: Hasher
      switch algorithm.lowercased().replacingOccurrences(of: "-", with: "") {
      case "sha256": hasher = .sha256(SHA256())
      case "sha384": hasher = .sha384(SHA384())
      case "sha512": hasher = .sha512(SHA512())
      case "sha1": hasher = .sha1(Insecure.SHA1())
      case "md5": hasher = .md5(Insecure.MD5())
      default: JSRuntime.throwError("Digest method not supported", code: "ERR_CRYPTO_INVALID_DIGEST"); return 0
      }
      let id = nextId; nextId += 1
      hashers[id] = hasher
      return id
    }
    runtime.define("hashCreate", create)
    let update: @convention(block) (Int, JSValue) -> Void = { id, value in
      // Node throws ERR_CRYPTO_HASH_FINALIZED for an update after digest; here it is a no-op. No caller does that.
      guard hashers[id] != nil, let data = JSRuntime.data(of: value) else { return }
      hashers[id]!.update(data)
    }
    runtime.define("hashUpdate", update)
    let digest: @convention(block) (Int) -> JSValue = { id in
      let context = JSContext.current()!
      guard let hasher = hashers.removeValue(forKey: id) else { JSRuntime.throwError("Digest already called", code: "ERR_CRYPTO_HASH_FINALIZED"); return JSValue(undefinedIn: context) }
      return JSRuntime.bytes(hasher.finalize(), in: context)
    }
    runtime.define("hashDigest", digest)
    let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
    runtime.define("randomUUID", uuid)
    let random: @convention(block) (Int) -> JSValue = { count in
      var data = Data(count: max(count, 0))
      _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
      return JSRuntime.bytes(data, in: JSContext.current())
    }
    runtime.define("randomBytes", random)
  }
}
