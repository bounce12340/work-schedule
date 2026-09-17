import UIKit
import Capacitor

/**
 * 推播的 device token 只會從 UIApplicationDelegate 的兩個 callback 回來，**不會**
 * 出現在插件裡。所以這裡收到之後要交給插件，再由它 resolve 那通還在等的電話。
 *
 * 這是**又一條跨檔案的接線**——與 build 7～10 那個「storyboard 指著 A、實際跑的是 B」
 * 同一個形狀：兩邊各自看起來都對，合起來卻不通，而且不會報錯，只是永遠不回話。
 * tools/check-native-plugin.mjs 因此也驗這兩個 callback 在不在。
 */
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    // MARK: - 推播（子專案 B）

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        WorkScheduleNativePlugin.deliverPushToken(deviceToken.map { String(format: "%02x", $0) }.joined(), error: nil)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // 失敗一定要往上送。不送的話那通電話會**永遠不會 settle**，而那種故障沒有任何
        // 事件——build 9 追了一整輪的就是這個形狀。
        WorkScheduleNativePlugin.deliverPushToken(nil, error: error.localizedDescription)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
