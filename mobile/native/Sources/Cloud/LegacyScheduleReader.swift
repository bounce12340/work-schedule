import Foundation
import WebKit

enum LegacyScheduleProbe {
    case found(ScheduleCache)
    case absent
    case unavailable
}

/// The active app screens are native. This temporary, offscreen view can read
/// the old installation's local storage through its original WebKit origin.
@MainActor
final class LegacyScheduleReader: NSObject, WKNavigationDelegate {
    private var view: WKWebView?
    private var continuation: CheckedContinuation<LegacyScheduleProbe, Never>?
    private var timeout: Task<Void, Never>?

    func read() async -> LegacyScheduleProbe {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            config.setURLSchemeHandler(LegacyOrigin(), forURLScheme: "capacitor")
            let view = WKWebView(frame: .zero, configuration: config)
            self.view = view
            view.navigationDelegate = self
            view.load(URLRequest(url: URL(string: "capacitor://localhost/")!))
            timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard !Task.isCancelled else { return }
                self?.finish(.unavailable)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("""
            (() => {
                const state = localStorage.getItem('workSchedule.v1');
                const meta = localStorage.getItem('workSchedule.v1.cloudMeta');
                if (state === null) return JSON.stringify({kind: 'absent'});
                return JSON.stringify({kind: 'found', state: JSON.parse(state), meta: JSON.parse(meta)});
            })()
            """) { [weak self] value, _ in
            guard let text = value as? String, let data = text.data(using: .utf8),
                  let payload = try? JSONDecoder().decode(Snapshot.self, from: data) else {
                self?.finish(.unavailable)
                return
            }
            if payload.kind == "absent" {
                self?.finish(.absent)
                return
            }
            guard payload.kind == "found", let metadata = payload.meta, !metadata.owner.isEmpty,
                  let state = payload.state, CloudStore.supports(state) else {
                self?.finish(.unavailable)
                return
            }
            self?.finish(.found(ScheduleCache(
                user: CloudUser(email: metadata.owner),
                state: state,
                base: metadata.baseSnapshot,
                updatedAt: metadata.updatedAt,
                dirty: state != metadata.baseSnapshot
            )))
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.unavailable) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.unavailable) }

    private func finish(_ cache: LegacyScheduleProbe) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel()
        timeout = nil
        view?.navigationDelegate = nil
        view = nil
        continuation.resume(returning: cache)
    }

    private struct Snapshot: Decodable {
        struct Metadata: Decodable {
            let owner: String
            let updatedAt: Int64?
            let baseSnapshot: JSONObject?
        }

        let kind: String
        let state: JSONObject?
        let meta: Metadata?
    }
}

private final class LegacyOrigin: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let page = Data("<!doctype html><meta charset=utf-8>".utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: page.count, textEncodingName: "UTF-8"))
        urlSchemeTask.didReceive(page)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
