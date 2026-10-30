import UIKit
import Capacitor

// Het hoofdscherm van de app (Capacitor):
// - altijd rechtop; alleen de spelers draaien liggend (anders bleef de app na een film soms scheef staan)
// - de thuisbalk onderin verdwijnt als je hem niet gebruikt
// - een veeg onderin het scherm gaat niet meteen naar het beginscherm (eerst de balk, dan pas bij een tweede veeg)
// - de ingebouwde VLC-speler wordt hier aangemeld
class MainViewController: CAPBridgeViewController {
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .portrait }
    override var shouldAutorotate: Bool { true }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VLCPlayerPlugin())
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        MainViewController.backToPortrait(self)
    }

    // Na het afspelen meteen terug naar rechtop
    static func backToPortrait(_ vc: UIViewController?) {
        guard let vc = vc else { return }
        if #available(iOS 16.0, *) {
            vc.setNeedsUpdateOfSupportedInterfaceOrientations()
            vc.view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in }
        } else {
            UIDevice.current.setValue(UIInterfaceOrientation.portrait.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}
