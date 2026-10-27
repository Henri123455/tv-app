import UIKit
import Capacitor

// Het hoofdscherm van de app (Capacitor), met twee iPhone-instellingen:
// - de thuisbalk onderin verdwijnt als je hem niet gebruikt
// - een veeg onderin het scherm gaat niet meteen naar het beginscherm (eerst de balk, dan pas bij een tweede veeg)
class MainViewController: CAPBridgeViewController {
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }
}
