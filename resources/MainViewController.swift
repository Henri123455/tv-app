import UIKit
import Capacitor
import GoogleCast

// Het hoofdscherm van de app (Capacitor):
// - draait mee met de telefoon (rechtop en liggend); na een film volgt de app weer hoe je de telefoon vasthoudt
// - de thuisbalk onderin verdwijnt als je hem niet gebruikt
// - een veeg onderin het scherm gaat niet meteen naar het beginscherm (eerst de balk, dan pas bij een tweede veeg)
// - de ingebouwde VLC-speler wordt hier aangemeld
// Tabbladen onderin aantikken terwijl het scherm nog doorrolt: iOS gebruikt die eerste tik normaal alleen om
// het scrollen te stoppen. Deze onzichtbare laag ligt over de tabbalk en vangt de tik alleen op zolang de
// pagina nog doorrolt; dan kiest hij meteen het juiste tabblad. Verder laat hij alles door naar de app.
final class TabTapOverlay: UIView {
    weak var scroll: UIScrollView?
    var top: CGFloat = .greatestFiniteMagnitude
    var tabs: [(x: CGFloat, w: CGFloat, tab: String)] = []
    var onTab: ((String) -> Void)?
    static weak var shared: TabTapOverlay?

    override func point(inside p: CGPoint, with event: UIEvent?) -> Bool {
        guard let s = scroll, s.isDecelerating, p.y >= top else { return false }
        return tabs.contains { p.x >= $0.x && p.x <= $0.x + $0.w }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let p = touches.first?.location(in: self), let hit = tabs.first(where: { p.x >= $0.x && p.x <= $0.x + $0.w }) else { return }
        if let s = scroll { s.setContentOffset(s.contentOffset, animated: false) } // doorrollen stoppen
        onTab?(hit.tab)
    }
}

class MainViewController: CAPBridgeViewController {
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var shouldAutorotate: Bool { true }

    override open func capacitorDidLoad() {
        // Chromecast klaarzetten (één keer, vóór de speler opent)
        if !GCKCastContext.isSharedInstanceInitialized() {
            let options = GCKCastOptions(discoveryCriteria: GCKDiscoveryCriteria(applicationID: kGCKDefaultMediaReceiverApplicationID))
            options.physicalVolumeButtonsWillControlDeviceVolume = true
            GCKCastContext.setSharedInstanceWith(options)
        }
        bridge?.registerPluginInstance(VLCPlayerPlugin())
        // Niet in- of uitzoomen (knijpen of dubbeltikken): de app blijft altijd op ware grootte
        if let sv = webView?.scrollView {
            sv.pinchGestureRecognizer?.isEnabled = false
            sv.minimumZoomScale = 1
            sv.maximumZoomScale = 1
            sv.bouncesZoom = false
        }
        // Tabbalk-laag (de app geeft door waar de tabbladen staan, zie VLCPlayer.setTabBar)
        let overlay = TabTapOverlay(frame: view.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = .clear
        overlay.scroll = webView?.scrollView
        overlay.onTab = { [weak self] tab in
            self?.webView?.evaluateJavaScript("window.setTab && setTab('\(tab)')", completionHandler: nil)
        }
        view.addSubview(overlay)
        TabTapOverlay.shared = overlay
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        MainViewController.backToPortrait(self)
    }

    // Na het afspelen: weer de stand van de telefoon volgen (houd je hem rechtop, dan meteen rechtop)
    static func backToPortrait(_ vc: UIViewController?) {
        guard let vc = vc else { return }
        let device = UIDevice.current.orientation
        let mask: UIInterfaceOrientationMask = device.isLandscape ? (device == .landscapeLeft ? .landscapeRight : .landscapeLeft) : .portrait
        if #available(iOS 16.0, *) {
            vc.setNeedsUpdateOfSupportedInterfaceOrientations()
            vc.view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
        // De webpagina opnieuw laten schikken (vaste balken op de juiste plek)
        if let web = (vc as? CAPBridgeViewController)?.webView {
            web.evaluateJavaScript("requestAnimationFrame(() => window.scrollTo(window.scrollX, window.scrollY));", completionHandler: nil)
        }
    }
}
