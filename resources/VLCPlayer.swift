import UIKit
import AVFoundation
import AVKit
import Capacitor
import GoogleCast
import MobileVLCKit

// Ingebouwde VLC-speler (zoals in UHF): speelt ook .mkv/.avi, HEVC-zenders en streams met een verkeerd label af,
// die Apple's eigen speler weigert. Schermvullend en liggend, met eigen bediening.
// Vanuit de app: VLCPlayer.play({ url, title, start }) en de meldingen "exit"/"ended" met { currentTime }.
@objc(VLCPlayerPlugin)
public class VLCPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VLCPlayerPlugin"
    public let jsName = "VLCPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTabBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchTo", returnType: CAPPluginReturnPromise),
    ]

    // Zappen: andere zender in de speler die al open is
    @objc func switchTo(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { call.reject("Geen geldig adres"); return }
        let title = call.getString("title") ?? ""
        DispatchQueue.main.async {
            VLCPlayerViewController.current?.switchTo(url: url, title: title)
            call.resolve()
        }
    }

    // Waar de tabbladen onderin staan (in punten), voor de laag die tikken tijdens het doorrollen opvangt
    @objc func setTabBar(_ call: CAPPluginCall) {
        let top = call.getDouble("top") ?? .greatestFiniteMagnitude
        let tabs = (call.getArray("tabs", JSObject.self) ?? []).compactMap { t -> (x: CGFloat, w: CGFloat, tab: String)? in
            guard let x = (t["x"] as? NSNumber)?.doubleValue, let w = (t["w"] as? NSNumber)?.doubleValue, let tab = t["tab"] as? String else { return nil }
            return (CGFloat(x), CGFloat(w), tab)
        }
        DispatchQueue.main.async {
            TabTapOverlay.shared?.top = CGFloat(top)
            TabTapOverlay.shared?.tabs = tabs
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { call.reject("Geen geldig adres"); return }
        let title = call.getString("title") ?? ""
        let start = call.getDouble("start") ?? 0
        let live = call.getBool("live") ?? false
        let series = call.getBool("series") ?? false
        let nextTitle = call.getString("nextTitle") ?? ""
        let castFirst = call.getBool("castFirst") ?? false
        DispatchQueue.main.async {
            let vc = VLCPlayerViewController(url: url, title: title, start: start, live: live)
            vc.series = series
            vc.nextTitle = nextTitle
            vc.castFirst = castFirst
            // user = zelf op het kruisje getikt (dan nooit een andere bron proberen), anders kapot/geen beeld
            vc.onExit = { [weak self] seconds, ended, length, user in
                self?.notifyListeners(ended ? "ended" : "exit", data: ["currentTime": seconds, "duration": length, "user": user])
            }
            // Elke 10 seconden doorgeven waar je bent: zo blijft "verder kijken" kloppen, ook als de app wordt afgesloten
            vc.onProgress = { [weak self] seconds, length in
                self?.notifyListeners("progress", data: ["currentTime": seconds, "duration": length])
            }
            // AirPlay gekozen: VLC kan geen beeld naar de tv sturen, dus de app gaat verder in Apple's speler (die dat wel kan)
            vc.onAirPlay = { [weak self] seconds in
                self?.notifyListeners("airplay", data: ["currentTime": seconds])
            }
            // Beeld-in-beeld: VLC kan dat niet, Apple's speler wel; de app gaat daar op dezelfde plek verder
            vc.onPip = { [weak self] seconds in
                self?.notifyListeners("pip", data: ["currentTime": seconds])
            }
            vc.onZap = { [weak self] dir in self?.notifyListeners("zap", data: ["dir": dir]) }
            vc.onReload = { [weak self] seconds in self?.notifyListeners("reload", data: ["currentTime": seconds]) }
            VLCPlayerViewController.current = vc
            vc.modalPresentationStyle = .fullScreen
            self.bridge?.viewController?.present(vc, animated: true)
            call.resolve()
        }
    }
}

final class VLCPlayerViewController: UIViewController, VLCMediaPlayerDelegate, UIGestureRecognizerDelegate, GCKSessionManagerListener {
    var onExit: ((Double, Bool, Double, Bool) -> Void)?
    var onProgress: ((Double, Double) -> Void)?
    // Series: "Intro overslaan" in het begin, en aan het eind "Volgende aflevering" met aftellen
    var series = false
    var nextTitle = ""
    var castFirst = false // "Op tv" gekozen: meteen de Chromecast-keuze tonen
    private let introButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private var introSkipped = false
    private var nextCancelled = false
    var onAirPlay: ((Double) -> Void)?
    var onPip: ((Double) -> Void)?
    var onZap: ((Int) -> Void)?       // -1 = vorige zender, 1 = volgende
    var onReload: ((Double) -> Void)? // opnieuw openen op deze plek (bijv. na andere ondertitelgrootte)
    static weak var current: VLCPlayerViewController?
    private let titleLabel = UILabel()
    private let settingsButton = UIButton(type: .system)
    private var sleepTimer: Timer?
    private var sleepUntil: Date?

    // ---- Instellingen: slaaptimer en ondertitelgrootte ----
    private func buildSettingsMenu() {
        guard #available(iOS 14.0, *) else { return }
        let left = sleepUntil.map { max(0, Int($0.timeIntervalSinceNow / 60)) }
        let sleep = UIMenu(title: left != nil ? "Slaaptimer (nog \(left!) min)" : "Slaaptimer", image: UIImage(systemName: "moon"), children:
            [("Uit", 0), ("15 minuten", 15), ("30 minuten", 30), ("60 minuten", 60), ("90 minuten", 90)].map { (name, min) in
                UIAction(title: name, state: (min == 0 && sleepUntil == nil) ? .on : .off) { [weak self] _ in self?.setSleep(minutes: min) }
            })
        let cur = UserDefaults.standard.string(forKey: Self.subSizeKey) ?? "normal"
        let size = UIMenu(title: "Ondertitelgrootte", image: UIImage(systemName: "textformat.size"), children:
            [("Klein", "small"), ("Normaal", "normal"), ("Groot", "large")].map { (name, key) in
                UIAction(title: name, state: cur == key ? .on : .off) { [weak self] _ in self?.setSubSize(key) }
            })
        settingsButton.menu = UIMenu(title: "Instellingen", children: [sleep, size])
    }
    private func setSleep(minutes: Int) {
        sleepTimer?.invalidate(); sleepTimer = nil; sleepUntil = nil
        if minutes > 0 {
            sleepUntil = Date().addingTimeInterval(Double(minutes) * 60)
            sleepTimer = Timer.scheduledTimer(withTimeInterval: Double(minutes) * 60, repeats: false) { [weak self] _ in
                self?.finish(ended: false, user: true) // slaaptimer: stoppen (telt als zelf gesloten)
            }
            showHint("Slaaptimer: \(minutes) minuten")
        } else { showHint("Slaaptimer uit") }
        buildSettingsMenu()
    }
    private func setSubSize(_ key: String) {
        guard key != (UserDefaults.standard.string(forKey: Self.subSizeKey) ?? "normal") else { return }
        UserDefaults.standard.set(key, forKey: Self.subSizeKey)
        // De lettergrootte zit vast in de speler: opnieuw openen op dezelfde plek
        guard !finished else { return }
        finished = true
        let t = everPlayed ? seconds : start
        player.stop()
        closeQuickly { [weak self] in self?.onReload?(t) }
    }
    private func showHint(_ text: String) {
        hint.text = "  \(text)  "
        hint.alpha = 1
        UIView.animate(withDuration: 0.4, delay: 1.5, options: []) { self.hint.alpha = 0 }
    }

    // ---- Zappen: naar links/rechts vegen tijdens live tv ----
    @objc private func swiped(_ g: UISwipeGestureRecognizer) {
        guard live, !casting else { return }
        onZap?(g.direction == .left ? 1 : -1)
    }
    // Andere zender in dezelfde speler (geen sluiten/openen, dus snel)
    func switchTo(url newURL: URL, title: String) {
        guard !finished else { return }
        titleLabel.text = title
        showHint(title)
        everPlayed = false; startChecked = false; subsApplied = false; lastBars = nil
        if cropped { player.videoCropGeometry = nil; cropped = false; crop = (0, 0, 0, 0) }
        spinner.startAnimating()
        let media = VLCMedia(url: newURL)
        media.addOption(":network-caching=3000")
        media.addOption(":adaptive-logic=highest")
        player.media = media
        player.play()
        scheduleBarChecks()
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, !self.everPlayed, !self.finished, !self.casting else { return }
            self.showHint("Deze zender werkt nu niet")
        }
    }
    private let castLabel = UILabel()
    private var casting = false
    private let airplay = AVRoutePickerView()
    private var lastProgress: Double = 0
    private var startChecked = false
    private var length: Double { Double(player.media?.length.intValue ?? 0) / 1000 }

    private let url: URL
    private let titleText: String
    private let start: Double
    // Ondertitels zoals Netflix/UHF: groot, wit en vet, met een stevige zwarte rand en schaduw (leesbaar op elk beeld),
    // geen balk erachter.
    // Beeld: hardware-decodering en het volledige deblocking-filter (scherper, geen blokjes).
    // Ondertitelgrootte (instellingen-knop): kleiner getal = grotere letters
    static let subSizeKey = "tvSubSize" // "small", "normal" (standaard) of "large"
    static var subSizeValue: Int { ["small": 16, "large": 10][UserDefaults.standard.string(forKey: subSizeKey) ?? ""] ?? 13 }
    private let player: VLCMediaPlayer = VLCMediaPlayer(options: [
        "--freetype-font=Helvetica Neue",
        "--freetype-rel-fontsize=\(VLCPlayerViewController.subSizeValue)",
        "--freetype-bold",
        "--freetype-color=16777215",
        "--freetype-opacity=255",
        "--freetype-outline-thickness=6",
        "--freetype-outline-color=0",
        "--freetype-outline-opacity=255",
        "--freetype-shadow-color=0",
        "--freetype-shadow-opacity=220",
        "--freetype-shadow-angle=-90",
        "--freetype-shadow-distance=0.05",
        "--freetype-background-opacity=0",
        "--sub-margin=4",
        "--avcodec-hw=any",
        "--avcodec-skiploopfilter=0",
        "--avcodec-skip-frame=0",
        "--avcodec-skip-idct=0",
        "--deinterlace=-1",
        "--deinterlace-mode=yadif2x",
    ])
    private let subsButton = UIButton(type: .system)
    private var subsApplied = false
    private let videoView = UIView()
    private let controls = UIView()
    private let playButton = UIButton(type: .system)
    private let slider = UISlider()
    private let timeLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private var hideTimer: Timer?
    private var seeking = false
    private var finished = false
    private var everPlayed = false

    // Live tv: geen tijdbalk of tijden (die sloegen nergens op, bijv. "0:50 / 0:59"), maar gewoon "LIVE"
    private let live: Bool
    init(url: URL, title: String, start: Double, live: Bool = false) {
        self.url = url
        self.titleText = title
        self.start = start
        self.live = live
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) wordt niet gebruikt") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        view.backgroundColor = .black

        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)

        controls.frame = view.bounds
        controls.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controls.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        view.addSubview(controls)

        let close = symbolButton("xmark", size: 20, action: #selector(closeTapped))
        let back = symbolButton("gobackward.10", size: 28, action: #selector(back10))
        let fwd = symbolButton("goforward.10", size: 28, action: #selector(forward10))
        setPlayIcon(playing: true)
        playButton.tintColor = .white
        playButton.addTarget(self, action: #selector(togglePlay), for: .touchUpInside)

        let title = titleLabel
        title.text = titleText
        title.textColor = .white
        title.font = .boldSystemFont(ofSize: 17)

        timeLabel.textColor = .white
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        timeLabel.text = "0:00"
        if live {
            // Rood "LIVE"-label, geen tijdbalk en geen 10 s terug/vooruit
            timeLabel.text = "  LIVE  "
            timeLabel.font = .systemFont(ofSize: 13, weight: .heavy)
            timeLabel.backgroundColor = .systemRed
            timeLabel.layer.cornerRadius = 6
            timeLabel.clipsToBounds = true
            slider.isHidden = true
            back.isHidden = true
            fwd.isHidden = true
        }

        slider.minimumTrackTintColor = .white
        slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.3)
        slider.addTarget(self, action: #selector(sliderStart), for: .touchDown)
        slider.addTarget(self, action: #selector(sliderMoved), for: .valueChanged)
        slider.addTarget(self, action: #selector(sliderEnd), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        spinner.color = .white
        spinner.hidesWhenStopped = true

        subsButton.setImage(UIImage(systemName: "captions.bubble", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        subsButton.tintColor = .white
        if #available(iOS 14.0, *) { subsButton.showsMenuAsPrimaryAction = true }
        subsButton.isHidden = true

        airplay.tintColor = .white
        airplay.activeTintColor = .systemBlue
        if #available(iOS 13.0, *) { airplay.prioritizesVideoDevices = true }
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged), name: AVAudioSession.routeChangeNotification, object: nil)

        // Chromecast-knop (verschijnt alleen als er een Chromecast/tv in je wifi is)
        let castButton = GCKUICastButton(frame: CGRect(x: 0, y: 0, width: 24, height: 24))
        castButton.tintColor = .white
        castButton.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(castButton)
        castLabel.textColor = .white
        castLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        castLabel.textAlignment = .center
        castLabel.numberOfLines = 2
        castLabel.isHidden = true
        castLabel.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(castLabel, belowSubview: controls)
        NSLayoutConstraint.activate([
            castLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            castLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -70),
            castLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -40),
        ])
        GCKCastContext.sharedInstance().sessionManager.add(self)
        let pipButton = symbolButton("pip.enter", size: 20, action: #selector(pipTapped))
        pipButton.isHidden = !AVPictureInPictureController.isPictureInPictureSupported()
        // Instellingen (tandwiel): slaaptimer en ondertitelgrootte
        settingsButton.setImage(UIImage(systemName: "gearshape", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        settingsButton.tintColor = .white
        if #available(iOS 14.0, *) { settingsButton.showsMenuAsPrimaryAction = true }
        buildSettingsMenu()
        // Zenders: naar links/rechts vegen = volgende/vorige zender (handig als je de telefoon liggend houdt)
        if live {
            for dir in [UISwipeGestureRecognizer.Direction.left, .right] {
                let sw = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
                sw.direction = dir
                sw.delegate = self
                view.addGestureRecognizer(sw)
            }
        }
        for v in [close, back, fwd, playButton, title, timeLabel, slider, subsButton, airplay, pipButton, settingsButton] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            controls.addSubview(v)
        }
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)

        for (b, text, light) in [(introButton, "Intro overslaan", false), (nextButton, "Volgende aflevering", true)] {
            b.setTitle(text, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
            b.setTitleColor(light ? .black : .white, for: .normal)
            b.backgroundColor = light ? .white : UIColor(white: 0.12, alpha: 0.8)
            b.layer.cornerRadius = 12
            b.layer.borderWidth = light ? 0 : 1.5
            b.layer.borderColor = UIColor(white: 1, alpha: 0.6).cgColor
            b.contentEdgeInsets = UIEdgeInsets(top: 12, left: 18, bottom: 12, right: 18)
            b.isHidden = true
            b.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(b)
            NSLayoutConstraint.activate([
                b.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
                b.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -64),
            ])
        }
        introButton.addTarget(self, action: #selector(skipIntro), for: .touchUpInside)
        nextButton.addTarget(self, action: #selector(playNext), for: .touchUpInside)

        let g = controls.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            close.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
            title.leadingAnchor.constraint(equalTo: close.trailingAnchor, constant: 12),
            title.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: castButton.leadingAnchor, constant: -16),
            castButton.trailingAnchor.constraint(equalTo: pipButton.leadingAnchor, constant: -8),
            castButton.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            castButton.widthAnchor.constraint(equalToConstant: 44),
            castButton.heightAnchor.constraint(equalToConstant: 44),
            pipButton.trailingAnchor.constraint(equalTo: airplay.leadingAnchor, constant: -8),
            pipButton.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            pipButton.widthAnchor.constraint(equalToConstant: 44),
            pipButton.heightAnchor.constraint(equalToConstant: 44),
            airplay.trailingAnchor.constraint(equalTo: subsButton.leadingAnchor, constant: -8),
            airplay.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            airplay.widthAnchor.constraint(equalToConstant: 44),
            airplay.heightAnchor.constraint(equalToConstant: 44),
            settingsButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            settingsButton.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            settingsButton.widthAnchor.constraint(equalToConstant: 44),
            settingsButton.heightAnchor.constraint(equalToConstant: 44),
            subsButton.trailingAnchor.constraint(equalTo: settingsButton.leadingAnchor, constant: -8),
            subsButton.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            subsButton.widthAnchor.constraint(equalToConstant: 44),
            subsButton.heightAnchor.constraint(equalToConstant: 44),
            playButton.centerXAnchor.constraint(equalTo: controls.centerXAnchor),
            playButton.centerYAnchor.constraint(equalTo: controls.centerYAnchor),
            back.centerYAnchor.constraint(equalTo: playButton.centerYAnchor),
            back.trailingAnchor.constraint(equalTo: playButton.leadingAnchor, constant: -64),
            fwd.centerYAnchor.constraint(equalTo: playButton.centerYAnchor),
            fwd.leadingAnchor.constraint(equalTo: playButton.trailingAnchor, constant: 64),
            slider.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 20),
            slider.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            slider.trailingAnchor.constraint(equalTo: timeLabel.leadingAnchor, constant: -12),
            timeLabel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -20),
            timeLabel.centerYAnchor.constraint(equalTo: slider.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        view.clipsToBounds = true
        hint.textColor = .white
        hint.font = .boldSystemFont(ofSize: 15)
        hint.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        hint.layer.cornerRadius = 10
        hint.clipsToBounds = true
        hint.alpha = 0
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        NSLayoutConstraint.activate([hint.centerXAnchor.constraint(equalTo: view.centerXAnchor), hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 70), hint.heightAnchor.constraint(equalToConstant: 34)])

        // Tik: bediening tonen/verbergen. Dubbeltik of knijpen: heel beeld / beeld vullen (zoals in Apple's eigen speler)
        // Knoppen (kruisje, pauze, schuifbalk) krijgen hun tik altijd zelf: de gebaren hieronder kijken er niet naar
        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        double.numberOfTapsRequired = 2
        double.delegate = self
        view.addGestureRecognizer(double)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        pinch.delegate = self
        view.addGestureRecognizer(pinch)
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap.cancelsTouchesInView = false
        tap.require(toFail: double)
        tap.delegate = self
        videoView.addGestureRecognizer(tap)
        let tap2 = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap2.cancelsTouchesInView = false
        tap2.require(toFail: double)
        tap2.delegate = self
        controls.addGestureRecognizer(tap2)

        let media = VLCMedia(url: url)
        media.addOption(":network-caching=3000")
        // Bij afspeellijsten met meerdere kwaliteiten (o.a. "HQ"-films): altijd de hoogste, het originele beeld
        media.addOption(":adaptive-logic=highest")
        media.addOption(":adaptive-maxwidth=3840")
        if start > 1 { media.addOption(":start-time=\(Int(start))") }
        player.media = media
        player.drawable = videoView
        player.delegate = self
        spinner.startAnimating()
        player.play()
        scheduleHide()
        scheduleBarChecks()
        // Na 10 seconden nog steeds geen beeld? Dan is deze bron kapot: sluiten zodat de app de volgende probeert
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, !self.everPlayed, !self.finished, !self.casting else { return }
            self.finish(ended: false)
        }
    }

    // Het hele beeld in de juiste verhouding (zwarte balken waar nodig), nooit uitgerekt of afgesneden
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fitVideo()
    }

    private func fitVideo() {
        let b = view.bounds
        var size = player.videoSize
        if let track = (player.media?.tracksInformation as? [[String: Any]])?.first(where: { ($0[VLCMediaTracksInformationType] as? String) == VLCMediaTracksInformationTypeVideo }),
           let w = (track[VLCMediaTracksInformationVideoWidth] as? NSNumber)?.doubleValue,
           let h = (track[VLCMediaTracksInformationVideoHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 {
            // Anamorfe films (bijv. DVD's): pixelverhouding meenemen
            let num = (track[VLCMediaTracksInformationSourceAspectRatio] as? NSNumber)?.doubleValue ?? 0
            let den = (track[VLCMediaTracksInformationSourceAspectRatioDenominator] as? NSNumber)?.doubleValue ?? 0
            size = CGSize(width: w * (num > 0 && den > 0 ? num / den : 1), height: h)
        }
        // Zwarte balken die in de film zelf zitten zijn weggeknipt: dan telt alleen het echte beeld
        size = CGSize(width: size.width * (1 - crop.left - crop.right), height: size.height * (1 - crop.top - crop.bottom))
        guard size.width > 0, size.height > 0, b.width > 0, b.height > 0 else { videoView.frame = b; return }
        // "Vullen" (knijpen of dubbeltikken): het beeld vult het hele scherm, randjes vallen weg.
        // Handig bij films met zwarte balken in het beeld zelf.
        let scale = fill ? max(b.width / size.width, b.height / size.height) : min(b.width / size.width, b.height / size.height)
        let w = (size.width * scale).rounded(), h = (size.height * scale).rounded()
        let f = CGRect(x: ((b.width - w) / 2).rounded(), y: ((b.height - h) / 2).rounded(), width: w, height: h)
        guard videoView.frame != f else { return }
        videoView.frame = f
        player.videoAspectRatio = nil
        player.scaleFactor = 0
    }

    // ---- Zwarte balken in het beeld zelf automatisch wegknippen ----
    // Sommige films hebben de zwarte balken "ingebakken" (bijv. een brede film in een 16:9-beeld). Op het bredere
    // iPhone-scherm kwam er dan ook nog zwart links en rechts bij. De speler meet een paar keer (momentopnames)
    // waar het beeld echt zwart is; alleen als twee metingen overeenkomen (een donkere scène telt niet) wordt
    // het weggeknipt, in VLC zelf, zodat de ondertitels gewoon in beeld blijven.
    private var crop: (top: CGFloat, bottom: CGFloat, left: CGFloat, right: CGFloat) = (0, 0, 0, 0)
    private var lastBars: [CGFloat]?
    private var cropped = false

    private func scheduleBarChecks() {
        for t in [12.0, 30.0, 60.0, 120.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.detectBars() }
        }
    }

    private func detectBars() {
        guard !finished, player.isPlaying, !cropped else { return }
        let file = NSTemporaryDirectory() + "tv-snap-\(UUID().uuidString).png"
        player.saveVideoSnapshot(at: file, withWidth: 0, andHeight: 0)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            defer { try? FileManager.default.removeItem(atPath: file) }
            guard let self = self, !self.finished, let img = UIImage(contentsOfFile: file)?.cgImage,
                  let bars = Self.blackBars(in: img) else { return }
            if let prev = self.lastBars, zip(prev, bars).allSatisfy({ abs($0 - $1) < 0.015 }), bars.contains(where: { $0 > 0.03 }) {
                self.applyCrop(bars, width: img.width, height: img.height)
            }
            self.lastBars = bars
        }
    }

    private func applyCrop(_ bars: [CGFloat], width: Int, height: Int) {
        let t = bars[0], l = bars[1]
        let cw = Int((CGFloat(width) * (1 - 2 * l)).rounded()) & ~1, ch = Int((CGFloat(height) * (1 - 2 * t)).rounded()) & ~1
        let cx = Int((CGFloat(width) * l).rounded()), cy = Int((CGFloat(height) * t).rounded())
        guard cw > width / 3, ch > height / 3 else { return }
        player.videoCropGeometry = strdup("\(cw)x\(ch)+\(cx)+\(cy)")
        crop = (t, t, l, l)
        cropped = true
        videoView.frame = .zero // opnieuw passend maken
        UIView.animate(withDuration: 0.3) { self.fitVideo() }
    }

    // Aandeel zwart boven/onder en links/rechts (symmetrisch: de kleinste van de twee kanten, want ondertitels kunnen
    // in de onderste balk staan). nil = te donker beeld om iets over te zeggen.
    private static func blackBars(in img: CGImage) -> [CGFloat]? {
        let w = 192, h = max(2, Int(CGFloat(w) * CGFloat(img.height) / CGFloat(img.width)))
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = px.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        let luma = { (x: Int, y: Int) -> Int in let i = (y * w + x) * 4; return (Int(px[i]) * 3 + Int(px[i + 1]) * 6 + Int(px[i + 2])) / 10 }
        let rowBlack = { (y: Int) -> Bool in (0..<w).allSatisfy { luma($0, y) < 26 } }
        let colBlack = { (x: Int) -> Bool in (0..<h).allSatisfy { luma(x, $0) < 26 } }
        if rowBlack(h / 2) || colBlack(w / 2) { return nil } // middenin zwart: donkere scène, niet meten
        var top = 0; while top < h / 3 && rowBlack(top) { top += 1 }
        var bottom = 0; while bottom < h / 3 && rowBlack(h - 1 - bottom) { bottom += 1 }
        var left = 0; while left < w / 3 && colBlack(left) { left += 1 }
        var right = 0; while right < w / 3 && colBlack(w - 1 - right) { right += 1 }
        // Een randje van 1 rij is geen balk; ietsje marge houden zodat er niets van het echte beeld af gaat
        let tb = max(0, CGFloat(min(top, bottom)) - 1) / CGFloat(h), lr = max(0, CGFloat(min(left, right)) - 1) / CGFloat(w)
        return [tb, lr]
    }

    private static let fillKey = "tvVideoFill"
    private var fill = UserDefaults.standard.bool(forKey: VLCPlayerViewController.fillKey)
    private let hint = UILabel()

    private func setFill(_ on: Bool) {
        guard on != fill else { return }
        fill = on
        UserDefaults.standard.set(on, forKey: Self.fillKey)
        UIView.animate(withDuration: 0.25) { self.fitVideo() }
        hint.text = on ? "  Beeld vullen  " : "  Heel beeld  "
        hint.alpha = 1
        UIView.animate(withDuration: 0.4, delay: 1.0, options: []) { self.hint.alpha = 0 }
    }
    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        if g.state == .ended { setFill(g.scale > 1) }
    }
    @objc private func doubleTapped() { setFill(!fill) }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var v = touch.view
        while let x = v, x !== view { if x is UIControl || x is AVRoutePickerView { return false }; v = x.superview }
        return true
    }

    private func symbolButton(_ name: String, size: CGFloat, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .semibold)), for: .normal)
        b.tintColor = .white
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func setPlayIcon(playing: Bool) {
        playButton.setImage(UIImage(systemName: playing ? "pause.fill" : "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 44, weight: .semibold)), for: .normal)
    }

    private var seconds: Double { Double(player.time.intValue) / 1000 }

    private func format(_ s: Double) -> String {
        let t = max(0, Int(s)), h = t / 3600, m = (t / 60) % 60, x = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, x) : String(format: "%d:%02d", m, x)
    }

    private func scheduleHide() {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { [weak self] _ in
            guard let self = self, self.player.isPlaying, !self.seeking else { return }
            UIView.animate(withDuration: 0.3) { self.controls.alpha = 0 }
        }
    }

    @objc private func toggleControls() {
        let show = controls.alpha < 0.5
        UIView.animate(withDuration: 0.25) { self.controls.alpha = show ? 1 : 0 }
        if show { scheduleHide() }
    }

    @objc private func togglePlay() {
        if player.isPlaying { player.pause(); setPlayIcon(playing: false) } else { player.play(); setPlayIcon(playing: true) }
        scheduleHide()
    }
    @objc private func back10() { player.jumpBackward(10); scheduleHide() }
    @objc private func forward10() { player.jumpForward(10); scheduleHide() }
    @objc private func sliderStart() { seeking = true; hideTimer?.invalidate() }
    @objc private func sliderMoved() {
        let len = Double(player.media?.length.intValue ?? 0) / 1000
        if len > 0 { timeLabel.text = format(Double(slider.value) * len) + " / " + format(len) }
    }
    @objc private func sliderEnd() { player.position = slider.value; seeking = false; scheduleHide() }
    @objc private func closeTapped() { finish(ended: false, user: true) }
    @objc private func pipTapped() {
        guard !finished else { return }
        finished = true
        let t = everPlayed ? seconds : 0
        player.stop()
        closeQuickly { [weak self] in self?.onPip?(t) }
    }

    // Sluiten en meteen terugdraaien, zonder draai-animatie: tijdens die animatie moest de hele app-pagina
    // steeds opnieuw worden opgebouwd, dat gaf haperingen. Nu staat hij in één keer goed.
    private func closeQuickly(_ then: @escaping () -> Void) {
        let back = presentingViewController
        UIView.setAnimationsEnabled(false)
        dismiss(animated: false) {
            MainViewController.backToPortrait(back)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { UIView.setAnimationsEnabled(true) }
            then()
        }
    }
    @objc private func skipIntro() { introSkipped = true; introButton.isHidden = true; player.jumpForward(80) }
    // Meteen door naar de volgende aflevering (de app start die na "afgelopen")
    @objc private func playNext() { nextButton.isHidden = true; finish(ended: true) }

    private func updateSeriesButtons() {
        let len = length, t = seconds
        introButton.isHidden = !(series && !introSkipped && t > 5 && t < 150)
        let left = len - t
        if !nextTitle.isEmpty && !nextCancelled && len > 60 && left <= 15 && left >= 0 {
            nextButton.setTitle("Volgende aflevering · \(nextTitle) (\(Int(left.rounded(.up))))", for: .normal)
            nextButton.isHidden = false
        } else { nextButton.isHidden = true }
    }

    @objc private func routeChanged() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.finished else { return }
            let toTV = AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .airPlay }
            guard toTV else { return }
            self.finished = true
            let t = self.everPlayed ? self.seconds : 0
            self.player.stop()
            self.closeQuickly { [weak self] in self?.onAirPlay?(t) }
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if GCKCastContext.isSharedInstanceInitialized() { GCKCastContext.sharedInstance().sessionManager.remove(self) }
    }

    // ---- Chromecast: tv gekozen → daar verder op dezelfde plek, de telefoon pauzeert ----
    private func castToTV(_ session: GCKCastSession) {
        guard !finished, let client = session.remoteMediaClient else { return }
        let ext = url.pathExtension.lowercased()
        let builder = GCKMediaInformationBuilder(contentURL: url)
        builder.streamType = live ? .live : .buffered
        builder.contentType = ext == "m3u8" ? "application/x-mpegURL" : ext == "mkv" ? "video/x-matroska" : "video/mp4"
        if ext == "m3u8" { builder.hlsSegmentFormat = .TS; builder.hlsVideoSegmentFormat = .MPEG2_TS }
        let md = GCKMediaMetadata(metadataType: .movie)
        md.setString(titleText, forKey: kGCKMetadataKeyTitle)
        builder.metadata = md
        let opts = GCKMediaLoadOptions()
        opts.autoplay = true
        opts.playPosition = live ? 0 : (everPlayed ? seconds : start)
        client.loadMedia(builder.build(), with: opts)
        casting = true
        player.pause()
        setPlayIcon(playing: false)
        castLabel.text = "Speelt af op \(session.device.friendlyName ?? "je tv")"
        castLabel.isHidden = false
    }
    func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) { castToTV(session) }
    func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) { castToTV(session) }
    func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKCastSession, withError error: Error?) {
        guard casting else { return }
        casting = false
        castLabel.isHidden = true
        player.play(); setPlayIcon(playing: true)
    }

    // Stond AirPlay al aan voordat je op afspelen tikte? Dan meteen via Apple's speler naar de tv
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        routeChanged()
        // Al verbonden met een Chromecast? Dan meteen daarheen
        if let s = GCKCastContext.sharedInstance().sessionManager.currentCastSession { castToTV(s) }
        else if castFirst { castFirst = false; GCKCastContext.sharedInstance().presentCastDialog() }
    }

    private func finish(ended: Bool, user: Bool = false) {
        if finished { return }
        finished = true
        hideTimer?.invalidate()
        sleepTimer?.invalidate()
        let t = everPlayed ? seconds : 0
        let len = length
        player.stop()
        closeQuickly { [weak self] in self?.onExit?(t, ended, len, user) }
    }

    func mediaPlayerStateChanged(_ aNotification: Notification) {
        switch player.state {
        case .buffering, .opening: if !player.isPlaying { spinner.startAnimating() }
        case .playing: spinner.stopAnimating(); everPlayed = true; fitVideo()
        case .ended where casting, .error where casting:
            break // speelt op de tv: de (gepauzeerde) telefoon-stream mag wegvallen
        case .ended:
            // Alleen echt "afgelopen" als we bij het einde zijn; valt de stream halverwege weg, dan onthouden waar je was
            finish(ended: length <= 0 || seconds >= length - 120)
        case .error:
            // Geen melding: de app probeert dan meteen vanzelf een andere versie of bron
            finish(ended: false)
        default: break
        }
    }

    // ---- Ondertiteling: alleen Nederlands en Engels, de rest eruit gefilterd ----
    private static let prefKey = "tvSubtitleLanguage" // "nl", "en" of "off" (standaard: nl)

    private func subtitleChoices() -> [(name: String, index: Int32, lang: String)] {
        guard let names = player.videoSubTitlesNames as? [String],
              let indexes = player.videoSubTitlesIndexes as? [NSNumber] else { return [] }
        // Per taal de volledige ondertitel kiezen: niet de "forced"-variant (alleen buitenlandse stukjes)
        // en liefst niet de doven/slechthorenden-versie met [geluiden] ertussen
        var best: [String: (score: Int, index: Int32)] = [:]
        for (n, i) in zip(names, indexes) where i.int32Value >= 0 {
            let l = n.lowercased()
            let isNL = l.contains("dut") || l.contains("nld") || l.contains("dutch") || l.contains("nederlands") || l.contains("vlaams") || l.range(of: "\\bnl\\b", options: .regularExpression) != nil
            let isEN = !isNL && (l.contains("eng") || l.range(of: "\\ben\\b", options: .regularExpression) != nil)
            let lang = isNL ? "nl" : (isEN ? "en" : "")
            if lang.isEmpty { continue }
            var score = 0
            if l.contains("forced") || l.contains("geforceerd") || l.contains("signs") { score -= 10 }
            if l.contains("sdh") || l.contains("hearing") || l.contains("cc") || l.contains("doven") { score -= 2 }
            if l.contains("full") || l.contains("volledig") { score += 1 }
            if let b = best[lang], b.score >= score { continue }
            best[lang] = (score, i.int32Value)
        }
        let out = best.map { (name: $0.key == "nl" ? "Nederlands" : "English", index: $0.value.index, lang: $0.key) }
        return out.sorted { $0.lang == "nl" && $1.lang != "nl" }
    }

    private func applySubtitles() {
        let choices = subtitleChoices()
        let pref = UserDefaults.standard.string(forKey: Self.prefKey) ?? "nl"
        if pref != "off", let pick = choices.first(where: { $0.lang == pref }) ?? choices.first {
            player.currentVideoSubTitleIndex = pick.index
        } else {
            player.currentVideoSubTitleIndex = -1 // geen ondertitel (ook geen andere taal)
        }
        buildSubtitleMenu(choices)
    }

    private func buildSubtitleMenu(_ choices: [(name: String, index: Int32, lang: String)]) {
        guard #available(iOS 14.0, *) else { return }
        subsButton.isHidden = choices.isEmpty
        let current = player.currentVideoSubTitleIndex
        var actions = [UIAction(title: "Uit", state: current < 0 ? .on : .off) { [weak self] _ in
            UserDefaults.standard.set("off", forKey: Self.prefKey)
            self?.player.currentVideoSubTitleIndex = -1
            self?.buildSubtitleMenu(choices)
        }]
        for c in choices {
            actions.append(UIAction(title: c.name, state: current == c.index ? .on : .off) { [weak self] _ in
                UserDefaults.standard.set(c.lang, forKey: Self.prefKey)
                self?.player.currentVideoSubTitleIndex = c.index
                self?.buildSubtitleMenu(choices)
            })
        }
        subsButton.menu = UIMenu(title: "Ondertiteling", children: actions)
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        if !everPlayed || videoView.frame == view.bounds { fitVideo() }
        // Verder kijken: sommige streams negeren de starttijd, dan zelf naar die plek springen
        if !startChecked && seconds > 0.5 {
            startChecked = true
            if start > 30 && seconds < start - 10 { player.time = VLCTime(int: Int32(start * 1000)) }
        }
        everPlayed = true
        spinner.stopAnimating()
        // Zodra de film loopt zijn de ondertitels bekend: Nederlands aan (of je eigen keuze), andere talen nooit
        if !subsApplied && player.time.intValue > 800 { subsApplied = true; applySubtitles() }
        if abs(seconds - lastProgress) >= 10 { lastProgress = seconds; onProgress?(seconds, length) }
        if !live { updateSeriesButtons() }
        if seeking || live { return }
        slider.value = player.position
        let len = Double(player.media?.length.intValue ?? 0) / 1000
        timeLabel.text = len > 0 ? format(seconds) + " / " + format(len) : format(seconds)
    }
}
