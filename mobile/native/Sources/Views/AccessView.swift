import AuthenticationServices
import SwiftUI

struct AccessView: View {
    @ObservedObject var store: CloudStore
    @StateObject private var identity = NativeIdentity()
    @State private var email = ""
    @State private var password = ""
    @State private var showRegistration = false
    @State private var working = false
    @State private var error: String?
    @State private var appleNonce = UUID().uuidString

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                VStack(alignment: .leading, spacing: 13) {
                    Image(systemName: "calendar.badge.checkmark")
                        .font(.system(size: 31, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 66, height: 66)
                        .background(WorkspaceStyle.accent, in: RoundedRectangle(cornerRadius: 19))
                        .accessibilityHidden(true)
                    Text("工作排程").font(.largeTitle.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text("登入後，即可查看工作、行事曆和專案進度。")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 12) {
                    TextField("電子郵件", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .modifier(AccessField())
                    SecureField("密碼", text: $password)
                        .textContentType(.password)
                        .modifier(AccessField())
                    Button {
                        perform { try await store.login(email: normalizedEmail, password: password) }
                    } label: {
                        Text("登入").font(.headline).frame(maxWidth: .infinity, minHeight: 30)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(working || normalizedEmail.isEmpty || password.isEmpty)

                    if working || store.status == .checking {
                        ProgressView().frame(maxWidth: .infinity).accessibilityLabel("正在處理")
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    } else if let message = store.message, [.failed, .offline].contains(store.status) {
                        Text(message).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if [.failed, .offline].contains(store.status) {
                        Button("重試連線") { Task { await store.retryConnection() } }
                            .buttonStyle(.bordered)
                    }

                    SignInWithAppleButton(.signIn) { request in
                        appleNonce = UUID().uuidString + UUID().uuidString
                        NativeIdentity.configureAppleRequest(request, nonce: appleNonce)
                    } onCompletion: { result in
                        perform {
                            let credential = try NativeIdentity.appleCredential(from: result.get(), nonce: appleNonce)
                            try await store.signInWithApple(idToken: credential.idToken,
                                                           authorizationCode: credential.authorizationCode,
                                                           nonce: credential.nonce)
                        }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 48)
                    .disabled(working)

                    if NativeIdentity.isGoogleConfigured {
                        Button {
                            perform {
                                let credential = try await identity.googleCredential()
                                try await store.signInWithGoogle(authorizationCode: credential.authorizationCode,
                                                                codeVerifier: credential.codeVerifier,
                                                                redirectURI: credential.redirectURI)
                            }
                        } label: {
                            Text("使用 Google 登入").font(.headline).frame(maxWidth: .infinity, minHeight: 30)
                        }
                        .buttonStyle(.bordered).controlSize(.large)
                        .disabled(working)
                    }

                    ViewThatFits {
                        HStack {
                            Button("建立帳號") { showRegistration = true }
                            Spacer()
                            Link("忘記密碼", destination: StoreLinks.reset)
                        }
                        VStack {
                            Button("建立帳號") { showRegistration = true }
                            Link("忘記密碼", destination: StoreLinks.reset)
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 7)
                }
                Link("隱私權政策", destination: StoreLinks.privacy)
                    .font(.footnote)
            }
            .frame(maxWidth: 410, alignment: .leading)
            .padding(25)
            .padding(.top, 36)
            .frame(maxWidth: .infinity)
        }
        .background(WorkspaceStyle.canvas)
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showRegistration) { RegistrationView(store: store, email: normalizedEmail) }
    }

    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func perform(_ request: @escaping () async throws -> Void) {
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                try await request()
            } catch let failure as ASAuthorizationError where failure.code == .canceled {
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct AccessField: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct RegistrationView: View {
    @ObservedObject var store: CloudStore
    @State var email: String
    @State private var code = ""
    @State private var password = ""
    @State private var verifiedEmail: String?
    @State private var working = false
    @State private var notice: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("電子郵件驗證") {
                    TextField("電子郵件", text: $email)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    Button(verifiedEmail == nil ? "寄送驗證碼" : "重新寄送驗證碼") {
                        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
                        perform {
                            try await store.sendRegistrationCode(email: address)
                            verifiedEmail = address
                            notice = "驗證碼已寄出，請查看信箱。"
                        }
                    }
                    .disabled(working || !email.contains("@"))
                    if verifiedEmail == email.trimmingCharacters(in: .whitespacesAndNewlines) {
                        TextField("電子郵件驗證碼", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                        SecureField("密碼（至少 10 個字元）", text: $password).textContentType(.newPassword)
                    }
                }
                Section {
                    Link("使用條款", destination: StoreLinks.terms)
                    Link("隱私權政策", destination: StoreLinks.privacy)
                }
                if let notice { Text(notice).font(.footnote) }
                if working { ProgressView() }
            }
            .navigationTitle("建立帳號")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("建立") {
                        guard let verifiedEmail else { return }
                        perform {
                            let signed = try await NativeSubscriptions.appTransactionJWS()
                            try await store.register(email: verifiedEmail, code: code, password: password, appTransactionJWS: signed)
                            dismiss()
                        }
                    }
                    .disabled(working || code.count != 6 || password.utf16.count < 10 ||
                              verifiedEmail != email.trimmingCharacters(in: .whitespacesAndNewlines))
                }
            }
        }
    }

    private func perform(_ action: @escaping () async throws -> Void) {
        working = true
        notice = nil
        Task {
            defer { working = false }
            do { try await action() }
            catch { notice = error.localizedDescription }
        }
    }
}

enum StoreLinks {
    private static let base = URL(string: "https://work-schedule.bounceto12340.workers.dev")!
    static let privacy = base.appendingPathComponent("privacy.html")
    static let terms = base.appendingPathComponent("terms.html")
    static let support = base.appendingPathComponent("support.html")
    static let reset = URL(string: "https://work-schedule.bounceto12340.workers.dev/login.html")!
}
