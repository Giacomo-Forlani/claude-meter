import Foundation

@main
enum Tests {
    static func main() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }

        let now = Date()
        let url = dir.appendingPathComponent("snapshot")
        let payload = #"{"cwd":"private-project","rate_limits":{"five_hour":{"used_percentage":0,"resets_at":4102444800}}}"#
        let text = try Snapshot.capture(Data(payload.utf8), to: url)
        precondition(text == "5h 0%")
        let saved = try Data(contentsOf: url)
        precondition(!String(decoding: saved, as: UTF8.self).contains("private-project"))
        let empty = try Snapshot.capture(Data("{}".utf8), to: url)
        precondition(empty == nil && Snapshot.read(from: url)?.limits.fiveHour?.used == 0)
        precondition(PlanWindow(used: 50, reset: now).available(at: now) == false)

        let settings = dir.appendingPathComponent("settings.json")
        try Data(#"{"theme":"dark"}"#.utf8).write(to: settings)
        try Integration.configure(file: settings, executable: "/Applications/Claude Meter.app/test")
        try Integration.configure(file: settings, executable: "/Applications/Claude Meter.app/test")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: settings)) as? [String: Any]
        precondition(object?["theme"] as? String == "dark")
        let custom = Data(#"{"statusLine":{"type":"command","command":"my-status"}}"#.utf8)
        try custom.write(to: settings)
        do {
            try Integration.configure(file: settings, executable: "/test")
            fatalError("statusLine personalizzata sovrascritta")
        } catch Integration.SetupError.existing {}
        let unchanged = try Data(contentsOf: settings)
        precondition(unchanged == custom)

        let root = dir.appendingPathComponent("projects")
        let sub = root.appendingPathComponent("demo/subagents")
        try fm.createDirectory(at: sub, withIntermediateDirectories: true)
        let log = sub.appendingPathComponent("session.jsonl")
        let row = #"{"uuid":"u","message":{"id":"m","usage":{"input_tokens":4,"output_tokens":6,"cache_read_input_tokens":1000}},"requestId":"r","timestamp":\#(Int(now.timeIntervalSince1970 * 1000))}"#
        try Data((row + "\n" + row + "\n{").utf8).write(to: log)
        let scanner = TokenHistory()
        let initial = scanner.scan(root, now: now)
        precondition(initial?.last?.tokens.input == 4 && initial?.last?.tokens.output == 6)
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(("}\n" + row.replacingOccurrences(of: "\"r\"", with: "\"r2\"") + "\n").utf8))
        try handle.close()
        precondition(scanner.scan(root, now: now)?.last?.tokens.input == 8)
        try Data((row + "\n").utf8).write(to: log, options: .atomic)
        precondition(scanner.scan(root, now: now)?.last?.tokens.output == 6)
        print("OK: limiti, collegamento e conteggi locali")
    }
}
