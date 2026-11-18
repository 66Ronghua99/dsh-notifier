// DSHNotifier — a tiny macOS helper app that posts one native notification and,
// when the user clicks it, records the pending session for DSH and brings the
// DeepSeek Harness window forward.
//
// Modes
//   (default)            post one notification from --title/--body/--session
//   --status             print the notification authorization status as JSON
//   --ensure-permission  request authorization only when it is undetermined
//   --list               print delivered notification identifiers as JSON
//
// Click handling does not depend on the caller: the notification carries the
// session id, the pending file path, and the URL to open in its userInfo, so a
// launch-on-click can act without any arguments.

import Cocoa
import UserNotifications

// MARK: - Output helpers

func writeStdout(_ text: String) {
  FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

func writeStderr(_ text: String) {
  FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

func statusName(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .denied: return "denied"
  case .authorized: return "authorized"
  case .provisional: return "provisional"
  case .ephemeral: return "ephemeral"
  @unknown default: return "unknown"
  }
}

// MARK: - Arguments

struct Options {
  var title: String?
  var subtitle: String?
  var body: String = ""
  var session: String = ""
  var sessionTitle: String = ""
  var pendingFile: String = ""
  var openURL: String = "dsh://open"
  var silent: Bool = false
  var sound: Bool = true
  var mode: String = "post"
  var group: String = ""
}

func parseOptions(_ arguments: [String]) -> Options {
  var options = Options()
  var index = 0
  func next() -> String {
    index += 1
    return index < arguments.count ? arguments[index] : ""
  }
  while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--title": options.title = next()
    case "--subtitle": options.subtitle = next()
    case "--body": options.body = next()
    case "--session": options.session = next()
    case "--session-title": options.sessionTitle = next()
    case "--pending-file": options.pendingFile = next()
    case "--open-url": options.openURL = next()
    case "--group": options.group = next()
    case "--silent": options.silent = true
    case "--no-sound": options.sound = false
    case "--status": options.mode = "status"
    case "--list": options.mode = "list"
    case "--ensure-permission": options.mode = "ensure-permission"
    default: break
    }
    index += 1
  }
  return options
}

// MARK: - Pending request store (shared with the DSH host plugin)

enum PendingStore {
  /// Append one `{ sessionId, title, at }` entry, replacing an older entry for
  /// the same session, then atomically replace the file.
  static func append(path: String, sessionId: String, title: String, target: String = "desktop") {
    guard !path.isEmpty, !sessionId.isEmpty else { return }
    let url = URL(fileURLWithPath: path)
    let directory = url.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    var items: [[String: Any]] = []
    if let data = try? Data(contentsOf: url),
       let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let stored = root["items"] as? [[String: Any]] {
      items = stored
    }
    items.removeAll { ($0["sessionId"] as? String) == sessionId }
    items.append([
      "sessionId": sessionId,
      "title": title,
      "at": Int(Date().timeIntervalSince1970 * 1000),
      "target": target,
    ])
    if items.count > 20 { items = Array(items.suffix(20)) }
    let root: [String: Any] = ["version": 1, "items": items]
    guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]) else { return }
    // One writer (this helper) plus the plugin's reader, so an atomic replace is
    // enough; a leftover temp file would only clutter the state directory.
    try? data.write(to: url, options: [.atomic])
  }
}

// MARK: - Application delegate

final class Helper: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let center = UNUserNotificationCenter.current()
  private let options: Options
  private var handledClick = false
  private var watchdog: DispatchWorkItem?

  init(options: Options) {
    self.options = options
    super.init()
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    center.delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    switch options.mode {
    case "status":
      printStatus(andExit: true)
    case "list":
      printDelivered()
    case "ensure-permission":
      ensurePermission()
    default:
      if options.title == nil && options.session.isEmpty {
        // No arguments: this launch was caused by a notification click. Wait for
        // the delegate callback, and give up if the system never delivers one.
        let watchdog = DispatchWorkItem { exit(0) }
        self.watchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: watchdog)
      } else {
        post()
      }
    }
  }

  // MARK: Posting

  private func post() {
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      if let error = error {
        writeStderr("authorization-error: \(error.localizedDescription)")
        exit(3)
      }
      self.center.getNotificationSettings { settings in
        let status = statusName(settings.authorizationStatus)
        guard granted || status == "provisional" else {
          writeStderr("denied:\(status)")
          exit(3)
        }
        self.schedule(status: status)
      }
    }
  }

  private func schedule(status: String) {
    let content = UNMutableNotificationContent()
    content.title = options.title ?? "DSH"
    if let subtitle = options.subtitle, !subtitle.isEmpty { content.subtitle = subtitle }
    content.body = options.body
    if options.sound && !options.silent { content.sound = .default }
    content.userInfo = [
      "sessionId": options.session,
      "sessionTitle": options.sessionTitle.isEmpty ? (options.title ?? "") : options.sessionTitle,
      "pendingFile": options.pendingFile,
      "openURL": options.openURL,
    ]
    let identifier = options.group.isEmpty
      ? "dsh-notifier-\(Int(Date().timeIntervalSince1970 * 1000))"
      : "\(options.group)-\(Int(Date().timeIntervalSince1970 * 1000))"
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    center.add(request) { error in
      if let error = error {
        writeStderr("deliver-error: \(error.localizedDescription)")
        exit(4)
      }
      writeStdout("posted:\(status)")
      exit(0)
    }
  }

  // MARK: Queries

  private func printStatus(andExit: Bool) {
    center.getNotificationSettings { settings in
      let payload: [String: Any] = [
        "authorization": statusName(settings.authorizationStatus),
        "alertSetting": settings.alertSetting.rawValue,
        "alertStyle": settings.alertStyle.rawValue,
        "badgeSetting": settings.badgeSetting.rawValue,
        "soundSetting": settings.soundSetting.rawValue,
        "timeSensitive": settings.timeSensitiveSetting.rawValue,
        "scheduledDelivery": settings.scheduledDeliverySetting.rawValue,
        "bundle": Bundle.main.bundleIdentifier ?? "",
      ]
      if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
         let text = String(data: data, encoding: .utf8) {
        writeStdout(text)
      }
      if andExit { exit(0) }
    }
  }

  private func printDelivered() {
    center.getDeliveredNotifications { delivered in
      let identifiers = delivered.map { $0.request.identifier }
      if let data = try? JSONSerialization.data(withJSONObject: identifiers, options: [.sortedKeys]),
         let text = String(data: data, encoding: .utf8) {
        writeStdout(text)
      }
      exit(0)
    }
  }

  private func ensurePermission() {
    center.getNotificationSettings { settings in
      let status = statusName(settings.authorizationStatus)
      if status != "notDetermined" {
        writeStdout("skipped:\(status)")
        exit(0)
      }
      self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error = error {
          writeStderr("authorization-error: \(error.localizedDescription)")
          exit(3)
        }
        writeStdout(granted ? "granted" : "denied")
        exit(granted ? 0 : 3)
      }
    }
  }

  // MARK: Delegates

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    handleClick(response)
    completionHandler()
    exit(0)
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  private func handleClick(_ response: UNNotificationResponse) {
    guard !handledClick else { return }
    handledClick = true
    watchdog?.cancel()
    let info = response.notification.request.content.userInfo
    let sessionId = info["sessionId"] as? String ?? ""
    let sessionTitle = info["sessionTitle"] as? String ?? ""
    let pendingFile = info["pendingFile"] as? String ?? ""
    let openURL = info["openURL"] as? String ?? "dsh://open"
    PendingStore.append(path: pendingFile, sessionId: sessionId, title: sessionTitle)

    // Bring DeepSeek Harness forward (or launch it) through LaunchServices.
    guard let url = URL(string: openURL) else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [url.absoluteString]
    try? process.run()
    process.waitUntilExit()
  }
}

// MARK: - Entry point

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let helper = Helper(options: parseOptions(Array(CommandLine.arguments.dropFirst())))
application.delegate = helper
application.run()
