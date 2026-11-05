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

    // Terug van een speler: pas draaien als de app weer echt in beeld is (eerder weigert iOS het soms).
    // De VLC-speler regelt dit zelf (closingPlayer), dit is voor Apple's speler.
    static var closingPlayer = false
    private var returning = false
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        returning = true
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard returning else { return }
        returning = false
        if !MainViewController.closingPlayer { MainViewController.backToPortrait(self) }
    }

    static func coverScreen(_ window: UIWindow?) -> UIView? {
        guard let window = window else { return nil }
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .black
        window.addSubview(cover)
        return cover
    }

    // Na het draaien: de webpagina opnieuw laten schikken, en daarna pas de app tonen
    static func settle(_ vc: UIViewController?, cover: UIView?) {
        let web = (vc as? CAPBridgeViewController)?.webView
        for t in [0.12, 0.38] {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                web?.setNeedsLayout(); web?.layoutIfNeeded()
                web?.evaluateJavaScript("window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('orientationchange'));", completionHandler: nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            UIView.setAnimationsEnabled(true)
            closingPlayer = false
            UIView.animate(withDuration: 0.18, animations: { cover?.alpha = 0 }, completion: { _ in cover?.removeFromSuperview() })
        }
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
