import SwiftUI

@main
struct WorkScheduleApp: App {
    @UIApplicationDelegateAdaptor(WorkScheduleAppDelegate.self) private var delegate
    @StateObject private var store: CloudStore
    @Environment(\.scenePhase) private var scenePhase

    @MainActor
    init() {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--preview-workspace") {
            _store = StateObject(wrappedValue: PreviewWorkspace.store())
            return
        }
        #endif
        _store = StateObject(wrappedValue: CloudStore())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if store.user != nil {
                    WorkspaceView(store: store)
                } else {
                    AccessView(store: store)
                }
            }
            .tint(WorkspaceStyle.accent)
            .task { await store.start() }
            .task(id: store.user?.appAccountToken) {
                guard let account = store.user?.appAccountToken else { return }
                await NativeSubscriptions.listen(accountToken: account) { transactions in
                    try Task.checkCancellation()
                    guard store.user?.appAccountToken == account else { throw CloudError.noSession }
                    try await store.syncAppleEntitlements(transactions)
                }
            }
            .task(id: scenePhase == .active ? store.user?.appAccountToken : nil) {
                guard scenePhase == .active, let account = store.user?.appAccountToken else { return }
                _ = try? await NativeSubscriptions.refresh(accountToken: account) { transactions in
                    try Task.checkCancellation()
                    guard store.user?.appAccountToken == account else { throw CloudError.noSession }
                    try await store.syncAppleEntitlements(transactions)
                }
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active {
                    Task { await store.retryConnection() }
                }
            }
        }
    }
}

enum WorkspaceStyle {
    static let accent = Color(red: 0.02, green: 0.40, blue: 0.35)
    static let canvas = Color(uiColor: .systemGroupedBackground)
    static let paper = Color(uiColor: .secondarySystemGroupedBackground)

    static func color(_ kind: ScheduleItem.Kind) -> Color {
        switch kind {
        case .work: return accent
        case .meeting: return .indigo
        case .assignment: return .orange
        }
    }

    static func title(_ kind: ScheduleItem.Kind) -> String {
        switch kind {
        case .work: return "工作"
        case .meeting: return "會議"
        case .assignment: return "交辦"
        }
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            Spacer()
            if let detail {
                Text(detail).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }
}

struct EmptySchedule: View {
    let label: String
    let icon: String
    var detail: String?

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: icon).font(.system(size: 26)).foregroundStyle(WorkspaceStyle.accent)
                .accessibilityHidden(true)
            Text(label).font(.headline)
            if let detail {
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(22)
        .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct WorkspaceView: View {
    @ObservedObject var store: CloudStore

    var body: some View {
        TabView {
            NavigationStack { AgendaView(store: store) }
                .tabItem { Label("排程", systemImage: "checklist") }
            NavigationStack { MonthView(store: store) }
                .tabItem { Label("月曆", systemImage: "calendar") }
            NavigationStack { ProjectsView(store: store) }
                .tabItem { Label("專案", systemImage: "chart.bar.xaxis") }
            NavigationStack { SettingsView(store: store) }
                .tabItem { Label("設定", systemImage: "gearshape") }
        }
    }
}

extension CloudStore {
    func editSchedule(_ edit: (inout ScheduleDocument) -> Void) {
        updateState { state in
            var schedule = ScheduleDocument(state)
            edit(&schedule)
            state = schedule.state
        }
    }
}

enum ScheduleDisplay {
    static let locale = Locale(identifier: "zh_Hant_TW")

    static var calendar: Calendar {
        var result = Calendar(identifier: .gregorian)
        result.locale = locale
        return result
    }

    static func add(_ component: Calendar.Component, _ value: Int, to day: ScheduleDay) -> ScheduleDay {
        ScheduleDay(calendar.date(byAdding: component, value: value, to: day.date) ?? day.date)
    }

    static func label(_ day: ScheduleDay, format: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = format
        return formatter.string(from: day.date)
    }
}
