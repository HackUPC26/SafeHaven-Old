import AVFoundation
import ExpoModulesCore
import SoundAnalysis
import Vision

private let audioLabelEvent = "onAudioLabel"
private let audioClassificationDebugEvent = "onAudioClassificationDebug"
private let videoAnnotationEvent = "onVideoAnnotation"
private let confidenceThreshold = 0.60
private let duplicateSuppressionSeconds = 2.0
private let extendedSilenceSeconds = 5.0
private let videoSampleInterval = 30
private let rapidMotionThreshold = 0.065

public final class SafeHavenAIModule: Module {
  private let analysisQueue = DispatchQueue(label: "safehaven.ai.sound-analysis")
  private let videoQueue = DispatchQueue(label: "safehaven.ai.video-analysis")
  private var audioEngine: AVAudioEngine?
  private var analyzer: SNAudioStreamAnalyzer?
  private var classifyRequest: SNClassifySoundRequest?
  private var observer: SafeHavenSoundObserver?
  private var isRunning = false
  private var silenceStartedAt: Date?
  private var lastEmittedAtByLabel: [String: Date] = [:]
  private var videoSession: AVCaptureSession?
  private var videoOutput: AVCaptureVideoDataOutput?
  private var videoObserver: SafeHavenVideoObserver?
  private var isVideoRunning = false
  private var videoFrameIndex = 0
  private var lastPosePoints: [String: CGPoint] = [:]
  private var consecutiveRapidMotionFrames = 0

  public func definition() -> ModuleDefinition {
    Name("SafeHavenAI")

    Events(audioLabelEvent, audioClassificationDebugEvent, videoAnnotationEvent)

    AsyncFunction("isSoundClassificationAvailable") { () -> Bool in
      return Self.soundClassificationAvailable
    }

    AsyncFunction("startSoundClassification") { (promise: Promise) in
      self.startSoundClassification(promise: promise)
    }

    AsyncFunction("stopSoundClassification") { () -> Bool in
      self.stopSoundClassification()
      return true
    }

    AsyncFunction("isVideoAnnotationAvailable") { () -> Bool in
      return Self.videoAnnotationAvailable
    }

    AsyncFunction("startVideoAnnotation") { (promise: Promise) in
      self.startVideoAnnotation(promise: promise)
    }

    AsyncFunction("stopVideoAnnotation") { () -> Bool in
      self.stopVideoAnnotation()
      return true
    }

    OnDestroy {
      self.stopSoundClassification()
      self.stopVideoAnnotation()
    }
  }

  private static var soundClassificationAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    if #available(iOS 15.0, *) {
      return true
    }
    return false
    #endif
  }

  private static var videoAnnotationAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    if #available(iOS 15.0, *) {
      return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil ||
        AVCaptureDevice.default(for: .video) != nil
    }
    return false
    #endif
  }

  private func startSoundClassification(promise: Promise) {
    if isRunning {
      promise.resolve(true)
      return
    }

    guard Self.soundClassificationAvailable else {
      print("[SafeHavenAI] SoundAnalysis is unavailable on this device")
      promise.resolve(false)
      return
    }

    AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
      guard let self else {
        promise.resolve(false)
        return
      }

      self.analysisQueue.async {
        guard granted else {
          print("[SafeHavenAI] Microphone permission denied")
          promise.resolve(false)
          return
        }

        do {
          try self.startEngine()
          promise.resolve(true)
        } catch {
          print("[SafeHavenAI] Failed to start sound classification: \(error.localizedDescription)")
          self.stopSoundClassificationOnQueue()
          promise.resolve(false)
        }
      }
    }
  }

  private func startEngine() throws {
    if isRunning {
      return
    }

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .allowBluetoothHFP])
    try session.setActive(true)

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)

    guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
      throw SafeHavenAIError.invalidAudioInput
    }

    let analyzer = SNAudioStreamAnalyzer(format: inputFormat)
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    let observer = SafeHavenSoundObserver(owner: self)
    request.overlapFactor = 0.5

    try analyzer.add(request, withObserver: observer)

    self.audioEngine = engine
    self.analyzer = analyzer
    self.classifyRequest = request
    self.observer = observer
    self.silenceStartedAt = nil
    self.lastEmittedAtByLabel = [:]

    inputNode.installTap(onBus: 0, bufferSize: 8192, format: inputFormat) { [weak self] buffer, time in
      guard let self else {
        return
      }
      self.analysisQueue.async {
        self.analyzer?.analyze(buffer, atAudioFramePosition: time.sampleTime)
      }
    }

    engine.prepare()
    try engine.start()

    self.isRunning = true
  }

  @discardableResult
  private func stopSoundClassification() -> Bool {
    analysisQueue.async { [weak self] in
      self?.stopSoundClassificationOnQueue()
    }

    return true
  }

  private func stopSoundClassificationOnQueue() {
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    analyzer?.removeAllRequests()
    analyzer = nil
    classifyRequest = nil
    observer = nil
    audioEngine = nil
    silenceStartedAt = nil
    lastEmittedAtByLabel = [:]
    isRunning = false
  }

  fileprivate func handleClassifications(_ classifications: [SNClassification]) {
    guard let topClassification = classifications.first else {
      return
    }

    emitClassificationDebug(classifications)

    let topIdentifier = normalizeIdentifier(topClassification.identifier)
    if topIdentifier == "silence" {
      handleSilence(rawIdentifier: topClassification.identifier, confidence: topClassification.confidence)
      return
    }

    silenceStartedAt = nil

    for classification in classifications {
      let normalizedIdentifier = normalizeIdentifier(classification.identifier)
      guard classification.confidence >= confidenceThreshold,
            let label = safeHavenLabel(for: normalizedIdentifier) else {
        continue
      }

      emitLabel(label, confidence: classification.confidence, rawIdentifier: classification.identifier)
      return
    }
  }

  fileprivate func handleSoundAnalysisFailure(_ error: Error) {
    print("[SafeHavenAI] SoundAnalysis request failed: \(error.localizedDescription)")
    stopSoundClassification()
  }

  fileprivate func handleSoundAnalysisCompletion() {
    stopSoundClassification()
  }

  private func handleSilence(rawIdentifier: String, confidence: Double) {
    guard confidence >= confidenceThreshold else {
      silenceStartedAt = nil
      return
    }

    let now = Date()
    if silenceStartedAt == nil {
      silenceStartedAt = now
      return
    }

    guard let startedAt = silenceStartedAt,
          now.timeIntervalSince(startedAt) >= extendedSilenceSeconds else {
      return
    }

    emitLabel("EXTENDED_SILENCE", confidence: confidence, rawIdentifier: rawIdentifier)
  }

  private func emitLabel(_ label: String, confidence: Double, rawIdentifier: String) {
    let now = Date()
    if let lastEmittedAt = lastEmittedAtByLabel[label],
       now.timeIntervalSince(lastEmittedAt) < duplicateSuppressionSeconds {
      return
    }

    lastEmittedAtByLabel[label] = now

    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(audioLabelEvent, [
        "label": label,
        "confidence": confidence,
        "ts": Int(now.timeIntervalSince1970 * 1000),
        "source": "SoundAnalysis",
        "rawIdentifier": rawIdentifier
      ])
    }
  }

  private func emitClassificationDebug(_ classifications: [SNClassification]) {
    #if DEBUG
    let topClassifications: [[String: Any]] = classifications.prefix(5).map { classification in
      let normalizedIdentifier = normalizeIdentifier(classification.identifier)
      return [
        "identifier": classification.identifier,
        "normalizedIdentifier": normalizedIdentifier,
        "confidence": classification.confidence,
        "mappedLabel": safeHavenLabel(for: normalizedIdentifier) ?? NSNull()
      ]
    }

    guard let topClassification = topClassifications.first else {
      return
    }

    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(audioClassificationDebugEvent, [
        "topIdentifier": topClassification["identifier"] ?? "",
        "topConfidence": topClassification["confidence"] ?? 0,
        "threshold": confidenceThreshold,
        "classifications": Array(topClassifications),
        "ts": Int(Date().timeIntervalSince1970 * 1000)
      ])
    }
    #endif
  }

  private func normalizeIdentifier(_ identifier: String) -> String {
    return identifier
      .lowercased()
      .replacingOccurrences(of: " ", with: "_")
      .replacingOccurrences(of: "-", with: "_")
  }

  private func safeHavenLabel(for identifier: String) -> String? {
    if identifier == "shout" ||
      identifier == "yell" ||
      identifier == "children_shouting" ||
      identifier.contains("shout") ||
      identifier.contains("yell") {
      return "SHOUTING"
    }

    if identifier == "screaming" ||
      identifier == "battle_cry" ||
      identifier.contains("scream") {
      return "SCREAMING"
    }

    if identifier == "crying_sobbing" ||
      identifier == "baby_crying" ||
      identifier.contains("crying") ||
      identifier.contains("sobbing") {
      return "CRYING"
    }

    if identifier == "thump_thud" ||
      identifier == "crushing" ||
      identifier == "boom" ||
      identifier == "hammer" ||
      identifier == "knock" ||
      identifier == "tap" ||
      identifier == "wood_cracking" ||
      identifier == "chopping_wood" {
      return "IMPACT"
    }

    if identifier == "gunshot_gunfire" {
      return "GUNSHOT"
    }

    if identifier == "slap_smack" {
      return "SLAP"
    }

    if identifier == "door_slam" {
      return "DOOR_SLAM"
    }

    if identifier == "glass_breaking" ||
      identifier == "glass_clink" {
      return "GLASS_BREAKING"
    }

    return nil
  }

  private func startVideoAnnotation(promise: Promise) {
    if isVideoRunning {
      promise.resolve(true)
      return
    }

    guard Self.videoAnnotationAvailable else {
      print("[SafeHavenAI] Vision video annotation is unavailable on this device")
      promise.resolve(false)
      return
    }

    AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
      guard let self else {
        promise.resolve(false)
        return
      }

      self.videoQueue.async {
        guard granted else {
          print("[SafeHavenAI] Camera permission denied for video annotation")
          promise.resolve(false)
          return
        }

        do {
          try self.startVideoCaptureOnQueue()
          promise.resolve(true)
        } catch {
          print("[SafeHavenAI] Failed to start video annotation: \(error.localizedDescription)")
          self.stopVideoAnnotationOnQueue()
          promise.resolve(false)
        }
      }
    }
  }

  @discardableResult
  private func stopVideoAnnotation() -> Bool {
    videoQueue.async { [weak self] in
      self?.stopVideoAnnotationOnQueue()
    }

    return true
  }

  private func startVideoCaptureOnQueue() throws {
    if isVideoRunning {
      return
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    session.sessionPreset = .vga640x480

    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) ??
      AVCaptureDevice.default(for: .video) else {
      throw SafeHavenAIError.invalidVideoInput
    }

    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else {
      throw SafeHavenAIError.invalidVideoInput
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    let observer = SafeHavenVideoObserver(owner: self)
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
    output.setSampleBufferDelegate(observer, queue: videoQueue)

    guard session.canAddOutput(output) else {
      throw SafeHavenAIError.invalidVideoInput
    }
    session.addOutput(output)

    if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
      connection.isVideoMirrored = true
    }

    session.commitConfiguration()
    session.startRunning()

    videoSession = session
    videoOutput = output
    videoObserver = observer
    videoFrameIndex = 0
    lastPosePoints = [:]
    consecutiveRapidMotionFrames = 0
    isVideoRunning = true
  }

  private func stopVideoAnnotationOnQueue() {
    videoOutput?.setSampleBufferDelegate(nil, queue: nil)
    videoSession?.stopRunning()
    videoObserver = nil
    videoOutput = nil
    videoSession = nil
    videoFrameIndex = 0
    lastPosePoints = [:]
    consecutiveRapidMotionFrames = 0
    isVideoRunning = false
  }

  fileprivate func handleVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
    videoFrameIndex += 1
    guard videoFrameIndex % videoSampleInterval == 0 else {
      return
    }

    let request = VNDetectHumanBodyPoseRequest()
    let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: .leftMirrored, options: [:])

    do {
      try handler.perform([request])
      let observations = request.results ?? []
      let bestPose = bestPosePoints(from: observations)
      let rapidMotion = updateRapidMotion(with: bestPose.points)
      emitVideoAnnotation(
        personCount: observations.count,
        rapidMotion: rapidMotion,
        confidence: bestPose.confidence
      )
    } catch {
      print("[SafeHavenAI] Vision body pose failed: \(error.localizedDescription)")
    }
  }

  private func bestPosePoints(from observations: [VNHumanBodyPoseObservation]) -> (points: [String: CGPoint], confidence: Double) {
    var bestPoints: [String: CGPoint] = [:]
    var bestConfidence = 0.0

    for observation in observations {
      guard let recognizedPoints = try? observation.recognizedPoints(.all) else {
        continue
      }

      var points: [String: CGPoint] = [:]
      var confidenceTotal = 0.0

      for (jointName, point) in recognizedPoints where point.confidence >= 0.30 {
        points[String(describing: jointName.rawValue)] = point.location
        confidenceTotal += Double(point.confidence)
      }

      guard !points.isEmpty else {
        continue
      }

      let averageConfidence = confidenceTotal / Double(points.count)
      if points.count > bestPoints.count || (points.count == bestPoints.count && averageConfidence > bestConfidence) {
        bestPoints = points
        bestConfidence = averageConfidence
      }
    }

    return (bestPoints, bestConfidence)
  }

  private func updateRapidMotion(with points: [String: CGPoint]) -> Bool {
    guard !points.isEmpty else {
      lastPosePoints = [:]
      consecutiveRapidMotionFrames = 0
      return false
    }

    var displacementTotal = 0.0
    var sharedPointCount = 0

    for (jointName, point) in points {
      guard let previousPoint = lastPosePoints[jointName] else {
        continue
      }

      displacementTotal += hypot(Double(point.x - previousPoint.x), Double(point.y - previousPoint.y))
      sharedPointCount += 1
    }

    lastPosePoints = points

    guard sharedPointCount > 0 else {
      consecutiveRapidMotionFrames = 0
      return false
    }

    let averageDisplacement = displacementTotal / Double(sharedPointCount)
    if averageDisplacement >= rapidMotionThreshold {
      consecutiveRapidMotionFrames += 1
    } else {
      consecutiveRapidMotionFrames = 0
    }

    return consecutiveRapidMotionFrames >= 1
  }

  private func emitVideoAnnotation(personCount: Int, rapidMotion: Bool, confidence: Double) {
    let now = Date()
    let poseFlags: [String] = rapidMotion ? ["rapid_motion"] : []

    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(videoAnnotationEvent, [
        "personCount": personCount,
        "rapidMotion": rapidMotion,
        "sceneContext": "camera",
        "poseFlags": poseFlags,
        "confidence": confidence,
        "source": "Vision",
        "ts": Int(now.timeIntervalSince1970 * 1000)
      ])
    }
  }
}

private final class SafeHavenSoundObserver: NSObject, SNResultsObserving {
  private weak var owner: SafeHavenAIModule?

  init(owner: SafeHavenAIModule) {
    self.owner = owner
  }

  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult,
          !result.classifications.isEmpty else {
      return
    }

    owner?.handleClassifications(result.classifications)
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    owner?.handleSoundAnalysisFailure(error)
  }

  func requestDidComplete(_ request: SNRequest) {
    owner?.handleSoundAnalysisCompletion()
  }
}

private final class SafeHavenVideoObserver: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private weak var owner: SafeHavenAIModule?

  init(owner: SafeHavenAIModule) {
    self.owner = owner
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    owner?.handleVideoSampleBuffer(sampleBuffer)
  }
}

private enum SafeHavenAIError: LocalizedError {
  case invalidAudioInput
  case invalidVideoInput

  var errorDescription: String? {
    switch self {
    case .invalidAudioInput:
      return "Microphone input format is invalid"
    case .invalidVideoInput:
      return "Camera input format is invalid"
    }
  }
}
