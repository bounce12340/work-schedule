import Foundation
import StoreKit

@MainActor
enum NativeSubscriptions {
    static let monthlyID = "com.bounceto.workschedule.pro.monthly"
    static let yearlyID = "com.bounceto.workschedule.pro.yearly"
    static let productIDs = [monthlyID, yearlyID]

    enum PurchaseOutcome {
        case completed, pending, cancelled
    }

    enum SubscriptionError: LocalizedError {
        case missingAccount, unexpectedProduct, unverified, wrongAccount, unknownResult, noWindow

        var errorDescription: String? {
            switch self {
            case .missingAccount: "請先同步帳號，再訂閱或恢復購買。"
            case .unexpectedProduct: "找不到這個訂閱商品。"
            case .unverified: "Apple 購買憑證驗證失敗。"
            case .wrongAccount: "請登入原先購買時使用的工作排程帳號。"
            case .unknownResult: "暫時無法確認購買結果。"
            case .noWindow: "目前無法開啟 Apple 訂閱設定。"
            }
        }
    }

    static func appTransactionJWS() async throws -> String {
        let result = try await AppTransaction.shared
        guard case .verified = result else { throw SubscriptionError.unverified }
        return result.jwsRepresentation
    }

    static func products() async throws -> [Product] {
        let products = try await Product.products(for: productIDs)
        return productIDs.compactMap { id in products.first { $0.id == id } }
    }

    static func purchase(
        _ product: Product,
        accountToken: UUID?,
        submit: ([String]) async throws -> Void
    ) async throws -> PurchaseOutcome {
        guard let accountToken else { throw SubscriptionError.missingAccount }
        guard productIDs.contains(product.id) else { throw SubscriptionError.unexpectedProduct }
        switch try await product.purchase(options: [.appAccountToken(accountToken)]) {
        case .success(let result):
            guard case .verified(let transaction) = result else { throw SubscriptionError.unverified }
            guard transaction.appAccountToken == accountToken else { throw SubscriptionError.wrongAccount }
            try await submit([result.jwsRepresentation])
            await transaction.finish()
            return .completed
        case .pending:
            return .pending
        case .userCancelled:
            return .cancelled
        @unknown default:
            throw SubscriptionError.unknownResult
        }
    }

    /// Called by the explicit Restore Purchases action because App Store may ask for authentication.
    static func restore(accountToken: UUID?, submit: ([String]) async throws -> Void) async throws -> Bool {
        guard accountToken != nil else { throw SubscriptionError.missingAccount }
        try await AppStore.sync()
        return try await refresh(accountToken: accountToken, submit: submit)
    }

    /// Call after login and on foreground so previously unfinished purchases can be delivered again.
    @discardableResult
    static func refresh(accountToken: UUID?, submit: ([String]) async throws -> Void) async throws -> Bool {
        guard let accountToken else { return false }
        var submitted = Set<UInt64>()
        for await result in Transaction.unfinished {
            try Task.checkCancellation()
            guard let transaction = matchingTransaction(result, accountToken) else { continue }
            try await submit([result.jwsRepresentation])
            await transaction.finish()
            submitted.insert(transaction.id)
        }

        for await result in Transaction.currentEntitlements {
            try Task.checkCancellation()
            guard let transaction = matchingTransaction(result, accountToken), !submitted.contains(transaction.id) else { continue }
            try await submit([result.jwsRepresentation])
            submitted.insert(transaction.id)
        }
        return !submitted.isEmpty
    }

    /// Attach to a SwiftUI task keyed to the signed-in account so changing accounts cancels the old listener.
    static func listen(accountToken: UUID?, submit: ([String]) async throws -> Void) async {
        guard let accountToken else { return }
        for await result in Transaction.updates {
            guard !Task.isCancelled else { return }
            guard let transaction = matchingTransaction(result, accountToken) else { continue }
            do {
                try await submit([result.jwsRepresentation])
                await transaction.finish()
            } catch {
                // StoreKit retains the unfinished transaction and refresh will retry delivery.
                if Task.isCancelled { return }
            }
        }
    }

    static func manage() async throws {
        guard let scene = NativeIdentity.activeScene else { throw SubscriptionError.noWindow }
        try await AppStore.showManageSubscriptions(in: scene)
    }

    private static func matchingTransaction(_ result: VerificationResult<Transaction>, _ accountToken: UUID) -> Transaction? {
        guard case .verified(let transaction) = result,
              productIDs.contains(transaction.productID), transaction.appAccountToken == accountToken else {
            return nil
        }
        return transaction
    }
}
