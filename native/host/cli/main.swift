// meluli-js: runs one bundled script in the native host runtime with the full Node surface, for the
// conformance checks (scripts/meluli2/native-host-conformance.mjs). The script ends the process
// with process.exit; an uncaught error ends it with status 70.
import Foundation

signal(SIGPIPE, SIG_IGN)
guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: meluli-js <bundle.js>\n".data(using: .utf8)!)
  exit(64)
}
let path = CommandLine.arguments[1]
guard let source = try? String(contentsOfFile: path, encoding: .utf8) else {
  FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
  exit(66)
}
let runtime = JSRuntime()
let fetcher = HostFetch(runtime: runtime)
runtime.performAndWait { runtime.installNodeHost(fetcher: fetcher) }
runtime.onUncaught = { message in
  FileHandle.standardError.write("[uncaught] \(message)\n".data(using: .utf8)!)
  exit(70)
}
runtime.perform { runtime.evaluate(source, url: URL(fileURLWithPath: path)) }
dispatchMain()
