import Darwin
import Foundation

struct Tokens {
    var input = 0
    var output = 0
}

struct DailyTokens {
    let date: Date
    var tokens = Tokens()
}

// Owned by one background queue. Keep only offsets and usage records in memory.
final class TokenHistory {
    private struct Record {
        let id: String
        let day: Date
        let tokens: Tokens
    }
    private struct Cursor {
        var inode: UInt64
        var modified: Date
        var offset: Int64 = 0
        var records: [Record] = []
    }
    private var files: [URL: Cursor] = [:]
    private let iso = ISO8601DateFormatter()
    private let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func parse(_ data: Data, since start: Date, calendar: Calendar) -> Record? {
        guard let row = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let message = row["message"] as? [String: Any],
              let usage = message["usage"] as? [String: Any] else { return nil }
        let timestamp: Date?
        if let text = row["timestamp"] as? String {
            timestamp = fractional.date(from: text) ?? iso.date(from: text)
        } else {
            timestamp = (row["timestamp"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        }
        guard let timestamp, timestamp >= start else { return nil }
        let key: String
        if let id = message["id"] as? String, !id.isEmpty,
           let request = row["requestId"] as? String, !request.isEmpty {
            key = "request:\(id):\(request)"
        } else if let uuid = row["uuid"] as? String, !uuid.isEmpty {
            key = "uuid:\(uuid)"
        } else { return nil }
        let tokens = Tokens(input: max(0, usage["input_tokens"] as? Int ?? 0),
                            output: max(0, usage["output_tokens"] as? Int ?? 0))
        return Record(id: key, day: calendar.startOfDay(for: timestamp), tokens: tokens)
    }

    private func scanFile(_ url: URL, since start: Date, calendar: Calendar) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let modified = attributes[.modificationDate] as? Date,
              modified >= start, let size = attributes[.size] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber else {
            files.removeValue(forKey: url)
            return
        }
        var cursor = files[url] ?? Cursor(inode: inode.uint64Value, modified: modified)
        if cursor.inode != inode.uint64Value || size.int64Value < cursor.offset ||
            (size.int64Value == cursor.offset && modified != cursor.modified) {
            cursor = Cursor(inode: inode.uint64Value, modified: modified)
        }
        if size.int64Value > cursor.offset {
            guard let stream = fopen(url.path, "r") else { throw CocoaError(.fileReadUnknown) }
            var buffer: UnsafeMutablePointer<CChar>?
            var capacity = 0
            defer { free(buffer); fclose(stream) }
            guard fseeko(stream, cursor.offset, SEEK_SET) == 0 else { throw CocoaError(.fileReadUnknown) }
            while true {
                let length = getline(&buffer, &capacity, stream)
                guard length > 0, let line = buffer, line[length - 1] == 10 else { break }
                let data = Data(bytesNoCopy: line, count: length, deallocator: .none)
                if let record = parse(data, since: start, calendar: calendar) {
                    cursor.records.append(record)
                }
                cursor.offset += Int64(length)
            }
            guard ferror(stream) == 0 else { throw CocoaError(.fileReadUnknown) }
        }
        cursor.modified = modified
        files[url] = cursor
    }

    func scan(_ root: URL, now: Date = Date(), calendar: Calendar = .current) -> [DailyTokens]? {
        let today = calendar.startOfDay(for: now)
        let dates = (-6...0).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
        guard let start = dates.first, FileManager.default.isReadableFile(atPath: root.path) else { return nil }
        var complete = true
        guard let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles], errorHandler: { _, _ in complete = false; return true })
        else { return nil }
        var present = Set<URL>()
        for case let file as URL in entries where file.pathExtension == "jsonl" {
            present.insert(file)
            do { try scanFile(file, since: start, calendar: calendar) }
            catch { complete = false }
        }
        guard complete else { return nil }
        files = files.filter { present.contains($0.key) }
        var seen = Set<String>()
        var totals: [Date: Tokens] = [:]
        for cursor in files.values {
            for record in cursor.records where record.day >= start && seen.insert(record.id).inserted {
                totals[record.day, default: Tokens()].input += record.tokens.input
                totals[record.day, default: Tokens()].output += record.tokens.output
            }
        }
        return dates.map { DailyTokens(date: $0, tokens: totals[$0] ?? Tokens()) }
    }
}
