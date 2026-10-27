import UIKit
import AVFoundation
import Capacitor
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
    ]

    @objc func play(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { call.reject("Geen geldig adres"); return }
        let title = call.getString("title") ?? ""
        let start = call.getDouble("start") ?? 0
        DispatchQueue.main.async {
            let vc = VLCPlayerViewController(url: url, title: title, start: start)
            vc.onExit = { [weak self] seconds, ended in
                self?.notifyListeners(ended ? "ended" : "exit", data: ["currentTime": seconds])
            }
            vc.modalPresentationStyle = .fullScreen
            self.bridge?.viewController?.present(vc, animated: true)
            call.resolve()
        }
    }
}

final class VLCPlayerViewController: UIViewController, VLCMediaPlayerDelegate {
    var onExit: ((Double, Bool) -> Void)?

    private let url: URL
    private let titleText: String
    private let start: Double
    private let player = VLCMediaPlayer()
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

    init(url: URL, title: String, start: Double) {
        self.url = url
        self.titleText = title
        self.start = start
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

        let title = UILabel()
        title.text = titleText
        title.textColor = .white
        title.font = .boldSystemFont(ofSize: 17)

        timeLabel.textColor = .white
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        timeLabel.text = "0:00"

        slider.minimumTrackTintColor = .white
        slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.3)
        slider.addTarget(self, action: #selector(sliderStart), for: .touchDown)
        slider.addTarget(self, action: #selector(sliderMoved), for: .valueChanged)
        slider.addTarget(self, action: #selector(sliderEnd), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        spinner.color = .white
        spinner.hidesWhenStopped = true

        for v in [close, back, fwd, playButton, title, timeLabel, slider] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            controls.addSubview(v)
        }
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)

        let g = controls.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            close.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
            title.leadingAnchor.constraint(equalTo: close.trailingAnchor, constant: 12),
            title.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -16),
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

        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap.cancelsTouchesInView = false
        videoView.addGestureRecognizer(tap)
        let tap2 = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap2.cancelsTouchesInView = false
        controls.addGestureRecognizer(tap2)

        let media = VLCMedia(url: url)
        media.addOption(":network-caching=2000")
        if start > 1 { media.addOption(":start-time=\(Int(start))") }
        player.media = media
        player.drawable = videoView
        player.delegate = self
        spinner.startAnimating()
        player.play()
        scheduleHide()
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
    @objc private func closeTapped() { finish(ended: false) }

    private func finish(ended: Bool) {
        if finished { return }
        finished = true
        hideTimer?.invalidate()
        let t = everPlayed ? seconds : 0
        player.stop()
        dismiss(animated: true) { [weak self] in self?.onExit?(t, ended) }
    }

    func mediaPlayerStateChanged(_ aNotification: Notification) {
        switch player.state {
        case .buffering, .opening: if !player.isPlaying { spinner.startAnimating() }
        case .playing: spinner.stopAnimating(); everPlayed = true
        case .ended: finish(ended: true)
        case .error:
            spinner.stopAnimating()
            let a = UIAlertController(title: "Afspelen lukt niet", message: "Deze stream reageert niet.", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Sluiten", style: .default) { [weak self] _ in self?.finish(ended: false) })
            present(a, animated: true)
        default: break
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        everPlayed = true
        spinner.stopAnimating()
        if seeking { return }
        slider.value = player.position
        let len = Double(player.media?.length.intValue ?? 0) / 1000
        timeLabel.text = len > 0 ? format(seconds) + " / " + format(len) : format(seconds)
    }
}
