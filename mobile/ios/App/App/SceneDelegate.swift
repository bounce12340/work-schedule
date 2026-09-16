import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // **一定要是 MainViewController，不是 CAPBridgeViewController。**
        // 自寫的插件是在 MainViewController.capacitorDidLoad() 裡註冊的（見那個檔案）；
        // 這裡若用 Capacitor 的預設控制器，那段程式從頭到尾不會被執行，插件就不存在。
        // 而「插件不存在」在 JS 那一側的形狀是**最難查的一種**：nativePromise 回傳的
        // promise 不 reject、也不 resolve，完全不會 settle，啟動流程就停在 await 上
        // （TestFlight build 7–9 的症狀，見 docs/postmortems/2026-09-16-app-silent-standalone.md）。
        //
        // storyboard 的 customClass 指著 MainViewController，但這裡自己建窗戶就用不到它——
        // 兩處必須一致，tools/check-native-plugin.mjs 守著。
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
