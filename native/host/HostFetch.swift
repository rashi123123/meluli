// `fetch` for the main-process code: flows' model calls, the update feed and the verified model
// download. The body streams to JS in chunks, and the transfer pauses while JS has more than a few
// megabytes it has not taken yet, so a 1.5 GB model never sits in memory.
import Foundation
import JavaScriptCore

final class HostFetch: NSObject, URLSessionDataDelegate {
  private struct Transfer {
    var task: URLSessionDataTask
    var onEvent: JSValue
    var pending = 0
    var paused = false
  }

  private let runtime: JSRuntime
  private var session: URLSession!
  private var transfers: [Int: Transfer] = [:]   // JS thread only
  private var ids: [Int: Int] = [:]              // task identifier -> transfer id, delegate queue only
  private var manual: Set<Int> = []              // task identifiers with redirect: "manual", delegate queue only
  private var refuse: Set<Int> = []              // task identifiers with redirect: "error", delegate queue only
  private let delegateQueue = OperationQueue()
  private var nextId = 1
  private static let pauseAbove = 8 << 20, resumeBelow = 2 << 20

  init(runtime: JSRuntime) {
    self.runtime = runtime
    super.init()
    delegateQueue.maxConcurrentOperationCount = 1
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 120
    configuration.timeoutIntervalForResource = 7 * 24 * 3600
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
  }

  func install() {
    // fetch({ url, method, headers, body, redirect }, onEvent) -> id
    let start: @convention(block) (JSValue, JSValue) -> Int = { [unowned self] request, onEvent in
      let id = self.nextId; self.nextId += 1
      guard let urlText = request.forProperty("url")?.toString(), let url = URL(string: urlText), ["http", "https"].contains(url.scheme ?? "") else {
        JSRuntime.throwError("Invalid URL", code: "ERR_INVALID_URL"); return 0
      }
      var urlRequest = URLRequest(url: url)
      urlRequest.httpMethod = request.forProperty("method")?.toString() ?? "GET"
      urlRequest.httpShouldHandleCookies = false
      if let headers = request.forProperty("headers")?.toArray() as? [[String]] {
        for pair in headers where pair.count == 2 { urlRequest.addValue(pair[1], forHTTPHeaderField: pair[0]) }
      }
      urlRequest.httpBody = JSRuntime.data(of: request.forProperty("body"))
      let task = self.session.dataTask(with: urlRequest)
      let redirect = request.forProperty("redirect")?.toString()
      self.transfers[id] = Transfer(task: task, onEvent: onEvent)
      let taskId = task.taskIdentifier
      self.delegateQueue.addOperation {
        self.ids[taskId] = id
        if redirect == "manual" { self.manual.insert(taskId) }
        if redirect == "error" { self.refuse.insert(taskId) }
        task.resume()
      }
      return id
    }
    runtime.define("fetch", start)
    let cancel: @convention(block) (Int) -> Void = { [unowned self] id in
      guard let transfer = self.transfers.removeValue(forKey: id) else { return }
      transfer.task.cancel()
    }
    runtime.define("fetchCancel", cancel)
    // JS reports how many bytes it consumed, so the transfer can resume.
    let consumed: @convention(block) (Int, Int) -> Void = { [unowned self] id, bytes in
      guard var transfer = self.transfers[id] else { return }
      transfer.pending = max(0, transfer.pending - bytes)
      if transfer.paused && transfer.pending < HostFetch.resumeBelow { transfer.paused = false; transfer.task.resume() }
      self.transfers[id] = transfer
    }
    runtime.define("fetchConsumed", consumed)
  }

  private func send(_ taskId: Int, _ event: String, _ build: @escaping (JSContext) -> [Any], update: ((inout Transfer) -> Void)? = nil, finished: Bool = false) {
    guard let id = ids[taskId] else { return }
    if finished { ids.removeValue(forKey: taskId); manual.remove(taskId); refuse.remove(taskId) }
    runtime.perform { [weak self] in
      guard let self, var transfer = self.transfers[id] else { return }
      update?(&transfer)
      if finished { self.transfers.removeValue(forKey: id) } else { self.transfers[id] = transfer }
      transfer.onEvent.call(withArguments: [event] + build(self.runtime.context))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    // redirect: "error" fails the fetch before any response goes out, with Node's cause message.
    if refuse.contains(task.taskIdentifier) {
      send(task.taskIdentifier, "error", { _ in ["unexpected redirect"] }, finished: true)
      completionHandler(nil)
      task.cancel()
      return
    }
    completionHandler(manual.contains(task.taskIdentifier) ? nil : request)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let http = response as? HTTPURLResponse
    var headers: [[String]] = []
    for (key, value) in http?.allHeaderFields ?? [:] { headers.append(["\(key)".lowercased(), "\(value)"]) }
    let status = http?.statusCode ?? 200
    let url = response.url?.absoluteString ?? ""
    send(dataTask.taskIdentifier, "response", { _ in [status, headers, url] })
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let count = data.count
    send(dataTask.taskIdentifier, "data", { context in [JSRuntime.bytes(data, in: context)] }, update: { transfer in
      transfer.pending += count
      if !transfer.paused && transfer.pending > HostFetch.pauseAbove { transfer.paused = true; transfer.task.suspend() }
    })
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // A manual redirect ends the task without a body; the response event already went out.
    if let error, (error as NSError).code != NSURLErrorCancelled {
      let message = error.localizedDescription
      send(task.taskIdentifier, "error", { _ in [message] }, finished: true)
    } else {
      send(task.taskIdentifier, "end", { _ in [] }, finished: true)
    }
  }
}
