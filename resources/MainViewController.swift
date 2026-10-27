import UIKit
import Capacitor

// Het hoofdscherm van de app (Capacitor):
// - de thuisbalk onderin verdwijnt als je hem niet gebruikt
// - een veeg onderin het scherm gaat niet meteen naar het beginscherm (eerst de balk, dan pas bij een tweede veeg)
// - de ingebouwde VLC-speler wordt hier aangemeld
class MainViewController: CAPBridgeViewController {
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VLCPlayerPlugin())
    }
}
