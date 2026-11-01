import UIKit
import Capacitor
import GoogleCast

// Het hoofdscherm van de app (Capacitor):
// - draait mee met de telefoon (rechtop en liggend); na een film volgt de app weer hoe je de telefoon vasthoudt
// - de thuisbalk onderin verdwijnt als je hem niet gebruikt
// - een veeg onderin het scherm gaat niet meteen naar het beginscherm (eerst de balk, dan pas bij een tweede veeg)
// - de ingebouwde VLC-speler wordt hier aangemeld
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
            web.evaluateJavaScript("window.scrollTo(window.scrollX, window.scrollY); window.dispatchEvent(new Event('resize'));", completionHandler: nil)
        }
    }
}
