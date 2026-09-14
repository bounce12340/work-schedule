import UIKit
import Capacitor

/**
 * 主畫面的 view controller。唯一的工作是把自寫的插件註冊進 Capacitor 的 bridge。
 *
 * Capacitor 用 SPM 時，npm 套件裡的插件由 CLI 自動列進 packageClassList；寫在 app
 * 專案裡的插件不在那份清單上，要在 capacitorDidLoad 手動註冊。Main.storyboard 的
 * view controller 因此指到這個類別，而不是預設的 CAPBridgeViewController。
 */
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WorkScheduleNativePlugin())
    }
}
