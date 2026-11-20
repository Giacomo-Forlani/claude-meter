import AppKit
import Charts
import SwiftUI

final class MeterModel: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var history: [DailyTokens]?
    @Published var now = Date()
    @Published var setupMessage: String?
    private let worker = DispatchQueue(label: "ClaudeMeter.usage", qos: .utility)
    private let scanner = TokenHistory()
    private var nextScan = Date.distantPast
    private var refreshing = false
    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        let date = Date()
        let scan = date >= nextScan
        if scan { nextScan = date.addingTimeInterval(60) }
        worker.async {
            let snapshot = Snapshot.read()
            let history = scan ? self.scanner.scan(Integration.configDirectory.appendingPathComponent("projects")) : nil
            DispatchQueue.main.async {
                self.now = date
                self.snapshot = snapshot
                if scan { self.history = history }
                self.refreshing = false
            }
        }
    }

    func configure() {
        guard let executable = Bundle.main.executableURL,
              !executable.path.contains("/AppTranslocation/") else {
            setupMessage = "Sposta Claude Meter in Applicazioni e riaprila prima di collegarla."
            return
        }
        worker.async {
            let message: String
            do {
                try Integration.configure(file: Integration.configDirectory.appendingPathComponent("settings.json"),
                                          executable: executable.path)
                message = "Avvia una nuova sessione di Claude Code e invia un messaggio per ricevere i primi dati."
            } catch { message = error.localizedDescription }
            DispatchQueue.main.async { self.setupMessage = message }
        }
    }
}

private struct LimitView: View {
    let name: String
    let window: PlanWindow?
    let now: Date

    var body: some View {
        let active = window.flatMap { $0.available(at: now) ? $0 : nil }
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(name)
                Spacer()
                Text(active.map { "\(Int($0.used.rounded()))%" } ?? "—").monospacedDigit()
            }
            if let active {
                ProgressView(value: active.used, total: 100)
                if let reset = active.reset {
                    Text("Reset \(reset.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct MeterPanel: View {
    @ObservedObject var model: MeterModel
    let guide = URL(string: "https://github.com/Giacomo-Forlani/claude-meter/blob/main/macos/README.md")!

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Claude Meter").font(.headline)
            LimitView(name: "Ultime 5 ore", window: model.snapshot?.limits.fiveHour, now: model.now)
            LimitView(name: "Settimana", window: model.snapshot?.limits.sevenDay, now: model.now)
            if let snapshot = model.snapshot {
                Text("Ultimi dati \(snapshot.updated.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Button("Collega Claude Code") { model.configure() }
                if let message = model.setupMessage {
                    Text(message).font(.caption).fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider()
            Text("Token locali di oggi").font(.headline)
            if let history = model.history, let today = history.last {
                HStack {
                    Text("Input  \(today.tokens.input.formatted())")
                    Spacer()
                    Text("Output  \(today.tokens.output.formatted())")
                }.monospacedDigit()
                Text("Totale giornaliero · ultimi 7 giorni").font(.caption).foregroundStyle(.secondary)
                Chart(history, id: \.date) { day in
                    BarMark(x: .value("Data", day.date, unit: .day),
                            y: .value("Token", day.tokens.input + day.tokens.output))
                }
                .chartXAxis { AxisMarks(values: .stride(by: .day)) { AxisValueLabel(format: .dateTime.day()) } }
                .frame(height: 75)
            } else {
                Text("In attesa dei registri locali di Claude Code.").foregroundStyle(.secondary)
            }
            Divider()
            HStack {
                Link("Istruzioni", destination: guide)
                Spacer()
                Button("Esci") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(16).frame(width: 320).onAppear { model.refresh() }
    }
}

private struct MeterApp: App {
    @StateObject private var model = MeterModel()
    var body: some Scene {
        MenuBarExtra {
            MeterPanel(model: model)
        } label: {
            Image(systemName: "gauge.medium").accessibilityLabel("Claude Meter")
            if let window = model.snapshot?.limits.fiveHour, window.available(at: model.now) {
                Text("\(Int(window.used.rounded()))%")
            }
        }.menuBarExtraStyle(.window)
    }
}

@main
enum Entry {
    static func main() {
        let arguments = CommandLine.arguments.dropFirst()
        if let mode = arguments.first, ["--capture", "--capture-only"].contains(mode) {
            do {
                let text = try Snapshot.capture(FileHandle.standardInput.readDataToEndOfFile())
                if mode == "--capture" { print(text ?? "Claude") }
            } catch {
                if mode == "--capture" { print("Claude") }
                exit(1)
            }
        } else {
            MeterApp.main()
        }
    }
}
