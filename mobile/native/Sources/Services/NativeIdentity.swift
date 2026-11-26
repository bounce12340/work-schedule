import AuthenticationServices
import CryptoKit
import Foundation
import Security
import SwiftUI
import UIKit

@MainActor
final class NativeIdentity: NSObject, ObservableObject {
    struct AppleCredential {
        let idToken: String
        let authorizationCode: String?
        let nonce: String
    }

    struct GoogleCredential {
        let authorizationCode: String
        let codeVerifier: String
        let redirectURI: String
    }

    enum IdentityError: LocalizedError {
        case unavailable, alreadyPresenting, missingCredential, invalidCallback, randomUnavailable

        var errorDescription: String? {
            switch self {
            case .unavailable: "這個登入服務目前無法開啟。"
            case .alreadyPresenting: "請先完成目前的登入。"
            case .missingCredential: "登入服務沒有回傳憑證。"
            case .invalidCallback: "無法驗證登入回應，請重新嘗試。"
            case .randomUnavailable: "暫時無法建立安全的登入請求。"
            }
        }
    }

    private struct GoogleConfiguration {
        let clientID: String
        let scheme: String
        let redirectURI: String
        static let redirectPath = "/oauth2redirect/google"
    }

    private var appleController: ASAuthorizationController?
    private var appleCompletion: CheckedContinuation<ASAuthorization, Error>?
    private var googleSession: ASWebAuthenticationSession?
    private var googleCompletion: CheckedContinuation<URL, Error>?

    static var isGoogleConfigured: Bool { googleConfiguration != nil }

    private static var googleConfiguration: GoogleConfiguration? {
        guard let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              clientID.range(of: #"^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$"#, options: .regularExpression) != nil,
              let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] else {
            return nil
        }
        let scheme = clientID.split(separator: ".").reversed().joined(separator: ".")
        guard urlTypes.contains(where: { ($0["CFBundleURLSchemes"] as? [String])?.contains(scheme) == true }) else {
            return nil
        }
        return GoogleConfiguration(clientID: clientID, scheme: scheme, redirectURI: scheme + ":" + GoogleConfiguration.redirectPath)
    }

    static func newAppleNonce() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "") }

    static func configureAppleRequest(_ request: ASAuthorizationAppleIDRequest, nonce: String) {
        request.requestedScopes = [.email]
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func appleCredential(from authorization: ASAuthorization, nonce: String) throws -> AppleCredential {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityData = credential.identityToken,
              let idToken = String(data: identityData, encoding: .utf8), !idToken.isEmpty else {
            throw IdentityError.missingCredential
        }
        let code = credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        return AppleCredential(idToken: idToken, authorizationCode: code, nonce: nonce)
    }

    func appleCredential() async throws -> AppleCredential {
        guard appleController == nil, googleSession == nil else { throw IdentityError.alreadyPresenting }
        guard Self.activeScene?.keyWindow != nil else { throw IdentityError.unavailable }
        let nonce = Self.newAppleNonce()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        Self.configureAppleRequest(request, nonce: nonce)
        let authorization = try await withCheckedThrowingContinuation { continuation in
            let controller = ASAuthorizationController(authorizationRequests: [request])
            appleCompletion = continuation
            appleController = controller
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
        return try Self.appleCredential(from: authorization, nonce: nonce)
    }

    func googleCredential() async throws -> GoogleCredential {
        guard appleController == nil, googleSession == nil else { throw IdentityError.alreadyPresenting }
        guard let configuration = Self.googleConfiguration, Self.activeScene?.keyWindow != nil else {
            throw IdentityError.unavailable
        }
        let verifier = try Self.randomVerifier()
        let state = try Self.randomVerifier()
        let digest = SHA256.hash(data: Data(verifier.utf8))
        var authorizationURL = URLComponents()
        authorizationURL.scheme = "https"
        authorizationURL.host = "accounts.google.com"
        authorizationURL.path = "/o/oauth2/v2/auth"
        authorizationURL.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: Self.base64URL(Data(digest))),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let url = authorizationURL.url else { throw IdentityError.unavailable }

        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            googleCompletion = continuation
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: configuration.scheme) { [weak self] callback, error in
                Task { @MainActor in
                    if let error { self?.finishGoogle(.failure(error)) }
                    else if let callback { self?.finishGoogle(.success(callback)) }
                    else { self?.finishGoogle(.failure(IdentityError.invalidCallback)) }
                }
            }
            session.presentationContextProvider = self
            googleSession = session
            if !session.start() {
                finishGoogle(.failure(IdentityError.unavailable))
            }
        }
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let states = query.filter { $0.name == "state" }
        let codes = query.filter { $0.name == "code" }
        guard callback.scheme == configuration.scheme, callback.host == nil,
              callback.path == GoogleConfiguration.redirectPath,
              states.count == 1, states.first?.value == state,
              codes.count == 1, let code = codes.first?.value, !code.isEmpty else {
            throw IdentityError.invalidCallback
        }
        return GoogleCredential(authorizationCode: code, codeVerifier: verifier, redirectURI: configuration.redirectURI)
    }

    private func finishGoogle(_ result: Result<URL, Error>) {
        let completion = googleCompletion
        googleCompletion = nil
        googleSession = nil
        completion?.resume(with: result)
    }

    private static func randomVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw IdentityError.randomUnavailable
        }
        return base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static var activeScene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive && $0.keyWindow != nil }
            ?? scenes.first { $0.activationState == .foregroundInactive && $0.keyWindow != nil }
    }
}

extension NativeIdentity: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding,
                          ASWebAuthenticationPresentationContextProviding {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        finishApple(.success(authorization))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finishApple(.failure(error))
    }

    private func finishApple(_ result: Result<ASAuthorization, Error>) {
        let completion = appleCompletion
        appleCompletion = nil
        appleController = nil
        completion?.resume(with: result)
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        Self.activeScene?.keyWindow ?? ASPresentationAnchor()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        Self.activeScene?.keyWindow ?? ASPresentationAnchor()
    }
}
