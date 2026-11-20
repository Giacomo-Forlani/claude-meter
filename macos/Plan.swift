import Foundation

struct PlanWindow: Codable {
    let used: Double
    let reset: Date?

    enum CodingKeys: String, CodingKey {
        case used = "used_percentage"
        case reset = "resets_at"
    }

    func available(at date: Date) -> Bool {
        (0...100).contains(used) && (reset.map { $0 > date } ?? true)
    }
}

struct Limits: Codable {
    let fiveHour: PlanWindow?
    let sevenDay: PlanWindow?

    enum CodingKeys: String, CodingKey {
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
    }
}

struct Snapshot: Codable {
    let updated: Date
    let limits: Limits

    static var file: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Claude Meter/usage.json")
    }

    static func read(from url: URL = file) -> Snapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    // The status-line payload can contain project information. Persist only the two limits.
    static func capture(_ data: Data, to url: URL = file, now: Date = Date()) throws -> String? {
        struct Input: Decodable { let rate_limits: Limits? }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let limits = try decoder.decode(Input.self, from: data).rate_limits,
              [limits.fiveHour, limits.sevenDay].contains(where: { $0?.available(at: now) == true })
        else { return nil }

        let snapshot = Self(updated: now, limits: limits)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
        let labels = [("5h", limits.fiveHour), ("7g", limits.sevenDay)]
        return labels.compactMap { label, window in
            guard let window, window.available(at: now) else { return nil }
            return "\(label) \(Int(window.used.rounded()))%"
        }.joined(separator: " · ")
    }
}

enum Integration {
    static let configDirectory: URL = {
        if let path = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }()

    static func command(executable: String, quiet: Bool = false) -> String {
        let quoted = executable.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(quoted)' " + (quiet ? "--capture-only" : "--capture")
    }

    enum SetupError: LocalizedError {
        case existing, invalid
        var errorDescription: String? {
            switch self {
            case .existing: return "Hai già una riga di stato personalizzata. Consulta le istruzioni per collegarla."
            case .invalid: return "Impossibile modificare settings.json. Consulta le istruzioni per il collegamento manuale."
            }
        }
    }

    static func configure(file: URL, executable: String) throws {
        let fm = FileManager.default
        let exists = fm.fileExists(atPath: file.path)
        let before = exists ? try Data(contentsOf: file) : nil
        var settings: [String: Any] = [:]
        if let before {
            guard let object = try? JSONSerialization.jsonObject(with: before) as? [String: Any] else {
                throw SetupError.invalid
            }
            settings = object
        }
        let cmd = command(executable: executable)
        if let existing = settings["statusLine"] {
            if let object = existing as? [String: Any], object["command"] as? String == cmd { return }
            throw SetupError.existing
        }
        settings["statusLine"] = ["type": "command", "command": cmd]
        let encoded = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys])
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let before {
            guard try Data(contentsOf: file) == before else { throw SetupError.invalid }
            try encoded.write(to: file, options: .atomic)
        } else {
            try encoded.write(to: file, options: .withoutOverwriting)
        }
    }
}
