import Foundation
import Network

/// Follows this iPhone's own connection (wifi ↔ mobile data ↔ offline) and reports changes on the main actor, so the
/// app checks its link again right away instead of waiting for an error.
final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "app.teambot.companion.network")

    func start(_ onChange: @escaping @MainActor @Sendable (PhoneNetwork) -> Void) {
        monitor.pathUpdateHandler = { path in
            let net = PhoneNetwork(online: path.status == .satisfied, onWiFi: path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            Task { @MainActor in onChange(net) }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
    }
}
