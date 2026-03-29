import AVFoundation
import ScreenCaptureKit

import AppKit
import Foundation
import CoreMedia

class RecorderCLI: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    static weak var activeRecorder: RecorderCLI?
    static var screenCaptureStream: SCStream?
    static let storedAudioSampleRate: Double = 16_000
    static let storedAudioChannels: AVAudioChannelCount = 1

    var contentEligibleForSharing: SCShareableContent?
    let processingQueue = DispatchQueue(label: "recorder.processing.queue")

    var recordingPath: String?
    var recordingFilename: String?
    var micDeviceID: String?
    var includeMicrophone: Bool = true
    var finalOutputPath: String?
    var systemTempPath: String?
    var micTempPath: String?
    var mixedTempPath: String?
    var temporaryArtifactsDirectoryPath: String?

    var systemAudioFileForRecording: AVAudioFile?
    var micAudioFileForRecording: AVAudioFile?

    var startupTimeout: TimeInterval = 15.0
    var isStopping = false
    var didStartRecording = false
    var didFailStartup = false
    var didRetryStartup = false
    var startupTimeoutToken = UUID().uuidString
    var latestSystemLevel: Float = 0
    var latestMicLevel: Float = 0
    var lastLevelEmitTime: TimeInterval = 0
    let levelEmitInterval: TimeInterval = 0.1
    var systemFramesWritten: AVAudioFramePosition = 0
    var micFramesWritten: AVAudioFramePosition = 0
    var streamRecoveryAttempts = 0
    let maxStreamRecoveryAttempts = 2
    var isRecoveringStream = false
    let microphoneStartupGracePeriod: TimeInterval = 3.0
    var microphoneHealthCheckToken = UUID().uuidString

    // Microphone capture
    var micCaptureSession: AVCaptureSession?
    let microphoneSampleQueue = DispatchQueue(label: "recorder.microphone.sample.queue")

    let targetAudioFormat = AVAudioFormat(
        standardFormatWithSampleRate: RecorderCLI.storedAudioSampleRate,
        channels: RecorderCLI.storedAudioChannels
    )!
    let fileAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: RecorderCLI.storedAudioSampleRate,
        channels: RecorderCLI.storedAudioChannels,
        interleaved: true
    )!
    let fileAudioSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: RecorderCLI.storedAudioSampleRate,
        AVNumberOfChannelsKey: RecorderCLI.storedAudioChannels,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]

    override init() {
        super.init()
        RecorderCLI.activeRecorder = self
        processCommandLineArguments()
    }

    static func ensureMicrophoneAccess(promptIfNeeded: Bool) -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard promptIfNeeded else { return false }
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { isGranted in
                granted = isGranted
                semaphore.signal()
            }
            semaphore.wait()
            return granted
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    static func normalizedMicrophoneName(_ value: String?) -> String {
        guard let value = value?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return ""
        }

        return value
            .replacingOccurrences(of: #"^(?i)(default|standard)\s*[-:]\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s*\((?i)(built-in|default)\)\s*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func processCommandLineArguments() {
        let arguments = CommandLine.arguments
        guard arguments.contains("--record") else {
            if arguments.contains("--check-permissions") {
                PermissionsRequester.requestScreenCaptureAccess { granted in
                    if granted {
                        ResponseHandler.returnResponse(["code": "PERMISSION_GRANTED"])
                    } else {
                        ResponseHandler.returnResponse(["code": "PERMISSION_DENIED"])
                    }
                }
            } else if arguments.contains("--list-input-devices") {
                guard Self.ensureMicrophoneAccess(promptIfNeeded: false) else {
                    ResponseHandler.returnResponse(["code": "MIC_PERMISSION_DENIED", "devices": []])
                    return
                }
                let devices = Self.availableMicrophoneDevices()
                ResponseHandler.returnResponse(["code": "INPUT_DEVICES", "devices": devices])
            } else {
                ResponseHandler.returnResponse(["code": "INVALID_ARGUMENTS"])
            }

            return
        }

        if let recordIndex = arguments.firstIndex(of: "--record"), recordIndex + 1 < arguments.count {
            recordingPath = arguments[recordIndex + 1]
        } else {
            ResponseHandler.returnResponse(["code": "NO_PATH_SPECIFIED"])
        }

        if let filenameIndex = arguments.firstIndex(of: "--filename"), filenameIndex + 1 < arguments.count {
            recordingFilename = arguments[filenameIndex + 1]
        }

        if arguments.contains("--no-mic") {
            includeMicrophone = false
        }

        if let micDeviceIndex = arguments.firstIndex(of: "--mic-device-id"), micDeviceIndex + 1 < arguments.count {
            micDeviceID = arguments[micDeviceIndex + 1]
        }
    }

    func executeRecordingProcess() {
        configureBackgroundActivationPolicy()
        setupSystemDiagnostics()
        setupInterruptSignalHandler()
        setupStartupTimeout()
        DispatchQueue.main.async { [weak self] in
            self?.updateAvailableContent()
        }
        RunLoop.main.run()
    }

    func configureBackgroundActivationPolicy() {
        DispatchQueue.main.async {
            NSApplication.shared.setActivationPolicy(.prohibited)
        }
    }

    func setupSystemDiagnostics() {
        let workspaceCenter = NSWorkspace.shared.notificationCenter

        workspaceCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in
            ResponseHandler.returnResponse([
                "code": "SYSTEM_EVENT",
                "event": "willSleep"
            ], shouldExitProcess: false)
        }

        workspaceCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
            ResponseHandler.returnResponse([
                "code": "SYSTEM_EVENT",
                "event": "didWake"
            ], shouldExitProcess: false)
        }

        workspaceCenter.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: nil) { _ in
            ResponseHandler.returnResponse([
                "code": "SYSTEM_EVENT",
                "event": "screensDidSleep"
            ], shouldExitProcess: false)
        }

        workspaceCenter.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: nil) { _ in
            ResponseHandler.returnResponse([
                "code": "SYSTEM_EVENT",
                "event": "screensDidWake"
            ], shouldExitProcess: false)
        }
    }

    // MARK: Microphone Capture
    func startMicrophoneCapture() -> String? {
        guard includeMicrophone else { return nil }
        guard Self.ensureMicrophoneAccess(promptIfNeeded: true) else {
            return "MIC_PERMISSION_DENIED"
        }

        let selectedDevice: AVCaptureDevice? = {
            guard let micDeviceID = micDeviceID, !micDeviceID.isEmpty else {
                return AVCaptureDevice.default(for: .audio)
            }

            let normalizedRequestedMic = Self.normalizedMicrophoneName(micDeviceID)

            return Self.audioCaptureDevices().first {
                $0.uniqueID == micDeviceID
                || $0.localizedName == micDeviceID
                || $0.localizedName.caseInsensitiveCompare(micDeviceID) == .orderedSame
                || Self.normalizedMicrophoneName($0.localizedName).caseInsensitiveCompare(normalizedRequestedMic) == .orderedSame
            }
        }()

        guard let micDevice = selectedDevice else {
            return "MIC_DEVICE_NOT_FOUND"
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        do {
            let input = try AVCaptureDeviceInput(device: micDevice)
            if session.canAddInput(input) {
                session.addInput(input)
            } else {
                session.commitConfiguration()
                return "MIC_CAPTURE_FAILED"
            }

            let output = AVCaptureAudioDataOutput()
            if session.canAddOutput(output) {
                output.setSampleBufferDelegate(self, queue: microphoneSampleQueue)
                session.addOutput(output)
            } else {
                session.commitConfiguration()
                return "MIC_CAPTURE_FAILED"
            }

            session.commitConfiguration()
            session.startRunning()
            micCaptureSession = session
            return nil
        } catch {
            session.commitConfiguration()
            return "MIC_CAPTURE_FAILED"
        }
    }

    func stopMicrophoneCapture() {
        micCaptureSession?.stopRunning()
        micCaptureSession = nil
    }

    func writeMicAudioBuffer(_ micAudioBuffer: AVAudioPCMBuffer) {
        guard !isStopping else { return }
        guard let convertedBuffer = convertBuffer(micAudioBuffer, to: targetAudioFormat) else { return }
        guard let fileBuffer = convertBuffer(convertedBuffer, to: fileAudioFormat) else { return }
        latestMicLevel = normalizedLevel(for: convertedBuffer)
        emitAudioLevels()

        do {
            try micAudioFileForRecording?.write(from: fileBuffer)
            micFramesWritten += AVAudioFramePosition(convertedBuffer.frameLength)
        } catch {
            ResponseHandler.returnResponse(["code": "MIC_BUFFER_WRITE_FAILED"], shouldExitProcess: false)
        }
    }

    func setupInterruptSignalHandler() {
        let interruptSignalHandler: @convention(c) (Int32) -> Void = { signal in
            if signal == SIGINT {
                RecorderCLI.activeRecorder?.handleStopSignal()
            }
        }

        signal(SIGINT, interruptSignalHandler)
    }

    func handleStopSignal() {
        processingQueue.async { [weak self] in
            self?.stopAndFinalize()
        }
    }

    func setupStartupTimeout() {
        let timeoutToken = UUID().uuidString
        startupTimeoutToken = timeoutToken

        DispatchQueue.global().asyncAfter(deadline: .now() + startupTimeout) { [weak self] in
            guard let self = self else { return }
            self.processingQueue.async {
                if self.startupTimeoutToken != timeoutToken { return }
                if self.didStartRecording || self.didFailStartup || self.isStopping { return }

                if !self.didRetryStartup {
                    self.didRetryStartup = true
                    RecorderCLI.terminateCapture()
                    self.updateAvailableContent()
                    self.setupStartupTimeout()
                    return
                }

                self.didFailStartup = true
                RecorderCLI.terminateCapture()
                ResponseHandler.returnResponse(["code": "CAPTURE_START_TIMEOUT"], shouldExitProcess: true)
            }
        }
    }

    func startRecordingSession() {
        if didStartRecording || didFailStartup || isStopping { return }
        didStartRecording = true
        startupTimeoutToken = UUID().uuidString

        prepareOutputPaths()
        prepareAudioFiles()
        if let microphoneStartupError = startMicrophoneCapture() {
            cleanupTemporaryFiles()
            failStartup(code: microphoneStartupError)
            return
        }
        scheduleMicrophoneHealthCheck()

        let formattedTimestamp = ISO8601DateFormatter().string(from: Date())
        let pathForAudioFile = finalOutputPath ?? ""

        ResponseHandler.returnResponse(["code": "RECORDING_STARTED", "path": pathForAudioFile, "timestamp": formattedTimestamp], shouldExitProcess: false)
        emitAudioLevels(force: true)
    }

    func failStartup(code: String) {
        if didStartRecording || didFailStartup || isStopping { return }
        didFailStartup = true
        startupTimeoutToken = UUID().uuidString
        microphoneHealthCheckToken = UUID().uuidString
        RecorderCLI.terminateCapture()
        ResponseHandler.returnResponse(["code": code], shouldExitProcess: true)
    }

    func scheduleMicrophoneHealthCheck() {
        guard includeMicrophone else { return }

        let healthToken = UUID().uuidString
        microphoneHealthCheckToken = healthToken

        DispatchQueue.global().asyncAfter(deadline: .now() + microphoneStartupGracePeriod) { [weak self] in
            guard let self = self else { return }
            self.processingQueue.async {
                guard self.microphoneHealthCheckToken == healthToken else { return }
                guard self.didStartRecording, !self.didFailStartup, !self.isStopping, self.includeMicrophone else { return }
                guard self.micFramesWritten <= 0 else { return }

                ResponseHandler.returnResponse([
                    "code": "RECORDER_RUNTIME_ERROR",
                    "message": "Microphone capture failed: no microphone audio frames were received."
                ], shouldExitProcess: false)
                self.stopAndFinalize()
            }
        }
    }

    func updateAvailableContent() {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, _ in
            guard let self = self else { return }
            if let content = content, !content.displays.isEmpty {
                self.contentEligibleForSharing = content
                self.setupRecordingEnvironment()
                return
            }

            self.retryAvailableContentLookup()
        }
    }

    func retryAvailableContentLookup() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, _ in
            guard let self = self else { return }
            self.contentEligibleForSharing = content
            self.setupRecordingEnvironment()
        }
    }

    func setupRecordingEnvironment() {
        guard let firstDisplay = contentEligibleForSharing?.displays.first else {
            failStartup(code: "NO_DISPLAY_FOUND")
            return
        }

        let screenContentFilter = SCContentFilter(display: firstDisplay, excludingApplications: [], exceptingWindows: [])

        Task { @MainActor in
            await initiateRecording(with: screenContentFilter)
        }
    }

    func prepareOutputPaths() {
        let timestamp = Date()
        let sanitizedFilename: String = {
            let trimmed = (recordingFilename ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? timestamp.toFormattedFileName() : trimmed
        }()

        let basePath = recordingPath ?? "."
        let pid = ProcessInfo.processInfo.processIdentifier
        let fileManager = FileManager.default
        let preferredTempDirectoryPath = "\(basePath)/.meetlify/derived/recorder-tmp"
        let tempDirectoryPath: String

        do {
            try fileManager.createDirectory(atPath: preferredTempDirectoryPath, withIntermediateDirectories: true)
            tempDirectoryPath = preferredTempDirectoryPath
        } catch {
            tempDirectoryPath = basePath
        }

        finalOutputPath = "\(basePath)/\(sanitizedFilename).flac"
        temporaryArtifactsDirectoryPath = tempDirectoryPath
        systemTempPath = "\(tempDirectoryPath)/\(sanitizedFilename).system.\(pid).caf"
        micTempPath = "\(tempDirectoryPath)/\(sanitizedFilename).mic.\(pid).caf"
        mixedTempPath = "\(tempDirectoryPath)/\(sanitizedFilename).mixed.\(pid).caf"
    }

    func prepareAudioFiles() {
        guard let systemTempPath = systemTempPath, let micTempPath = micTempPath else {
            ResponseHandler.returnResponse(["code": "AUDIO_FILE_CREATION_FAILED"])
            return
        }

        do {
            systemAudioFileForRecording = try AVAudioFile(
                forWriting: URL(fileURLWithPath: systemTempPath),
                settings: fileAudioSettings,
                commonFormat: .pcmFormatFloat32,
                interleaved: true
            )
            micAudioFileForRecording = try AVAudioFile(
                forWriting: URL(fileURLWithPath: micTempPath),
                settings: fileAudioSettings,
                commonFormat: .pcmFormatFloat32,
                interleaved: true
            )
        } catch {
            ResponseHandler.returnResponse(["code": "AUDIO_FILE_CREATION_FAILED"])
        }
    }

    @MainActor
    func initiateRecording(with filter: SCContentFilter) async {
        let streamConfiguration = SCStreamConfiguration()
        configureStream(streamConfiguration)

        do {
            RecorderCLI.screenCaptureStream = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)

            try RecorderCLI.screenCaptureStream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global())
            try await RecorderCLI.screenCaptureStream?.startCapture()
            isRecoveringStream = false
            startRecordingSession()
        } catch {
            if didStartRecording && !isStopping {
                ResponseHandler.returnResponse([
                    "code": "RECORDER_RUNTIME_ERROR",
                    "message": "Capture recovery failed: \(error.localizedDescription)"
                ], shouldExitProcess: false)
                stopAndFinalize()
                return
            }

            failStartup(code: "CAPTURE_FAILED")
        }
    }

    func configureStream(_ configuration: SCStreamConfiguration) {
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale.max)
        configuration.showsCursor = false
        configuration.capturesAudio = true
        configuration.sampleRate = 48000
        configuration.channelCount = 2
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        guard sampleBuffer.isValid else { return }
        guard let systemAudioBuffer = sampleBuffer.copiedPCMBuffer else { return }

        processingQueue.async { [weak self] in
            self?.writeSystemAudioBuffer(systemAudioBuffer)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid else { return }
        guard let micAudioBuffer = sampleBuffer.copiedPCMBuffer else { return }

        processingQueue.async { [weak self] in
            self?.writeMicAudioBuffer(micAudioBuffer)
        }
    }

    func writeSystemAudioBuffer(_ systemAudioBuffer: AVAudioPCMBuffer) {
        guard !isStopping else { return }
        guard let convertedBuffer = convertBuffer(systemAudioBuffer, to: targetAudioFormat) else { return }
        guard let fileBuffer = convertBuffer(convertedBuffer, to: fileAudioFormat) else { return }
        latestSystemLevel = normalizedLevel(for: convertedBuffer)
        emitAudioLevels()

        do {
            try systemAudioFileForRecording?.write(from: fileBuffer)
            if isRecoveringStream {
                ResponseHandler.returnResponse([
                    "code": "STREAM_RECOVERED",
                    "message": "System audio stream recovered successfully."
                ], shouldExitProcess: false)
            }
            systemFramesWritten += AVAudioFramePosition(convertedBuffer.frameLength)
            streamRecoveryAttempts = 0
            isRecoveringStream = false
        } catch {
            ResponseHandler.returnResponse(["code": "AUDIO_BUFFER_WRITE_FAILED"], shouldExitProcess: false)
        }
    }

    func convertBuffer(_ inputBuffer: AVAudioPCMBuffer, to outputFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        let converter = AVAudioConverter(from: inputBuffer.format, to: outputFormat)
        guard let converter = converter else { return nil }

        let ratio = outputFormat.sampleRate / inputBuffer.format.sampleRate
        let estimatedFrameCapacity = max(AVAudioFrameCount((Double(inputBuffer.frameLength) * ratio).rounded(.up)), 1)

        guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: estimatedFrameCapacity) else { return nil }

        var conversionError: NSError?
        var didProvideInput = false
        let status = converter.convert(to: convertedBuffer, error: &conversionError) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .endOfStream
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return inputBuffer
        }

        if status == .error || conversionError != nil || convertedBuffer.frameLength == 0 {
            return nil
        }

        return convertedBuffer
    }

    func normalizedLevel(for buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let frameCount = Int(buffer.frameLength)
        if frameCount == 0 { return 0 }

        let channelCount = Int(buffer.format.channelCount)
        var sumSquares: Float = 0
        var sampleCount = 0

        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for i in 0..<frameCount {
                let sample = samples[i]
                sumSquares += sample * sample
                sampleCount += 1
            }
        }

        if sampleCount == 0 { return 0 }
        let rms = sqrt(sumSquares / Float(sampleCount))
        let boosted = rms * 4.0
        return max(0, min(1, boosted))
    }

    func emitAudioLevels(force: Bool = false) {
        let now = Date().timeIntervalSince1970
        if !force && (now - lastLevelEmitTime) < levelEmitInterval {
            return
        }

        lastLevelEmitTime = now
        let micLevel = includeMicrophone ? latestMicLevel : 0
        ResponseHandler.returnResponse(
            ["code": "AUDIO_LEVELS", "systemLevel": latestSystemLevel, "micLevel": micLevel],
            shouldExitProcess: false
        )
    }

    func convertAudioFileToFlac(inputPath: String, outputPath: String) throws {
        if FileManager.default.fileExists(atPath: outputPath) {
            try? FileManager.default.removeItem(atPath: outputPath)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
        process.arguments = [
            "-f", "flac",
            "-d", "flac",
            inputPath,
            outputPath,
        ]

        let errorPipe = Pipe()
        process.standardError = errorPipe
        process.standardOutput = Pipe()

        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
            let errorText = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            try? FileManager.default.removeItem(atPath: outputPath)
            throw NSError(
                domain: "MeetlifyRecorder",
                code: Int(process.terminationStatus),
                userInfo: [
                    NSLocalizedDescriptionKey: errorText?.isEmpty == false
                        ? errorText!
                        : "afconvert exited with code \(process.terminationStatus)."
                ]
            )
        }

        let outputUrl = URL(fileURLWithPath: outputPath)
        do {
            let decodedAudioFile = try AVAudioFile(forReading: outputUrl)
            if decodedAudioFile.length <= 0 {
                try? FileManager.default.removeItem(atPath: outputPath)
                throw NSError(
                    domain: "MeetlifyRecorder",
                    code: 1001,
                    userInfo: [
                        NSLocalizedDescriptionKey: "afconvert created an empty or invalid FLAC file."
                    ]
                )
            }
        } catch {
            try? FileManager.default.removeItem(atPath: outputPath)
            throw error
        }
    }

    func validateOutputAudioFile(at path: String, minimumSizeBytes: UInt64 = 43) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw NSError(
                domain: "MeetlifyRecorder",
                code: 1002,
                userInfo: [
                    NSLocalizedDescriptionKey: "The finalized audio file is missing."
                ]
            )
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        let fileSize = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        if fileSize < minimumSizeBytes {
            try? FileManager.default.removeItem(atPath: path)
            throw NSError(
                domain: "MeetlifyRecorder",
                code: 1003,
                userInfo: [
                    NSLocalizedDescriptionKey: "The finalized audio file is empty or invalid."
                ]
            )
        }
    }

    func mixSamples(system: Float, microphone: Float) -> Float {
        let systemGain: Float = 0.9
        let microphoneGain: Float = 1.0
        let limiterThreshold: Float = 0.95

        let mixed = (system * systemGain) + (microphone * microphoneGain)
        let magnitude = abs(mixed)

        if magnitude <= limiterThreshold {
            return mixed
        }

        return mixed * (limiterThreshold / magnitude)
    }

    func mixAudioFiles(systemPath: String, micPath: String, outputPath: String) throws {
        let systemFile = try AVAudioFile(forReading: URL(fileURLWithPath: systemPath))
        let micFile = try AVAudioFile(forReading: URL(fileURLWithPath: micPath))

        guard
            let systemFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetAudioFormat.sampleRate,
                channels: targetAudioFormat.channelCount,
                interleaved: false
            ),
            let micFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetAudioFormat.sampleRate,
                channels: targetAudioFormat.channelCount,
                interleaved: false
            )
        else {
            throw NSError(
                domain: "MeetlifyRecorder",
                code: 1101,
                userInfo: [NSLocalizedDescriptionKey: "Could not prepare audio formats for final mixing."]
            )
        }

        let tempMixedPath = mixedTempPath
            ?? (((outputPath as NSString).deletingPathExtension as NSString)
                .appendingPathExtension("mixed.caf") ?? "\(outputPath).mixed.caf")
        if FileManager.default.fileExists(atPath: tempMixedPath) {
            try? FileManager.default.removeItem(atPath: tempMixedPath)
        }

        let chunkSize: AVAudioFrameCount = 4096
        var framesMixed: AVAudioFramePosition = 0

        defer {
            try? FileManager.default.removeItem(atPath: tempMixedPath)
        }

        var mixedFile: AVAudioFile? = try AVAudioFile(
            forWriting: URL(fileURLWithPath: tempMixedPath),
            settings: fileAudioSettings,
            commonFormat: .pcmFormatFloat32,
            interleaved: true
        )

        while systemFile.framePosition < systemFile.length || micFile.framePosition < micFile.length {
            let systemRemaining = max(0, systemFile.length - systemFile.framePosition)
            let micRemaining = max(0, micFile.length - micFile.framePosition)
            let framesThisPass = AVAudioFrameCount(min(max(systemRemaining, micRemaining), AVAudioFramePosition(chunkSize)))
            if framesThisPass == 0 { break }

            guard
                let systemBuffer = AVAudioPCMBuffer(pcmFormat: systemFormat, frameCapacity: framesThisPass),
                let micBuffer = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: framesThisPass),
                let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetAudioFormat, frameCapacity: framesThisPass)
            else {
                throw NSError(
                    domain: "MeetlifyRecorder",
                    code: 1102,
                    userInfo: [NSLocalizedDescriptionKey: "Could not allocate audio buffers for final mixing."]
                )
            }

            let systemFramesToRead = AVAudioFrameCount(min(systemRemaining, AVAudioFramePosition(framesThisPass)))
            let micFramesToRead = AVAudioFrameCount(min(micRemaining, AVAudioFramePosition(framesThisPass)))

            if systemFramesToRead > 0 {
                try systemFile.read(into: systemBuffer, frameCount: systemFramesToRead)
            } else {
                systemBuffer.frameLength = 0
            }

            if micFramesToRead > 0 {
                try micFile.read(into: micBuffer, frameCount: micFramesToRead)
            } else {
                micBuffer.frameLength = 0
            }

            outputBuffer.frameLength = framesThisPass

            guard
                let systemData = systemBuffer.floatChannelData,
                let micData = micBuffer.floatChannelData,
                let outputData = outputBuffer.floatChannelData
            else {
                throw NSError(
                    domain: "MeetlifyRecorder",
                    code: 1103,
                    userInfo: [NSLocalizedDescriptionKey: "Audio sample data was unavailable during final mixing."]
                )
            }

            let channelCount = Int(targetAudioFormat.channelCount)
            let systemFrameCount = Int(systemBuffer.frameLength)
            let micFrameCount = Int(micBuffer.frameLength)
            let outputFrameCount = Int(framesThisPass)

            for channel in 0..<channelCount {
                let systemChannel = systemData[channel]
                let micChannel = micData[channel]
                let outputChannel = outputData[channel]

                for frame in 0..<outputFrameCount {
                    let systemSample: Float = frame < systemFrameCount ? systemChannel[frame] : 0
                    let micSample: Float = frame < micFrameCount ? micChannel[frame] : 0
                    outputChannel[frame] = mixSamples(system: systemSample, microphone: micSample)
                }
            }

            guard let fileBuffer = convertBuffer(outputBuffer, to: fileAudioFormat) else {
                throw NSError(
                    domain: "MeetlifyRecorder",
                    code: 1105,
                    userInfo: [NSLocalizedDescriptionKey: "Could not convert mixed audio into the file output format."]
                )
            }

            try mixedFile?.write(from: fileBuffer)
            framesMixed += AVAudioFramePosition(outputBuffer.frameLength)
        }

        guard framesMixed > 0 else {
            throw NSError(
                domain: "MeetlifyRecorder",
                code: 1104,
                userInfo: [NSLocalizedDescriptionKey: "The final mixed recording did not contain any audio frames."]
            )
        }

        mixedFile = nil
        try validateOutputAudioFile(at: tempMixedPath)
        try convertAudioFileToFlac(inputPath: tempMixedPath, outputPath: outputPath)
        try validateOutputAudioFile(at: outputPath)
    }

    @discardableResult
    func mergeTempFilesIntoFinalOutput() -> Bool {
        guard
            let systemTempPath = systemTempPath,
            let finalOutputPath = finalOutputPath
        else {
            ResponseHandler.returnResponse([
                "code": "RECORDER_RUNTIME_ERROR",
                "message": "Final merge failed because the temporary system recording file is missing."
            ], shouldExitProcess: false)
            return false
        }

        do {
            if includeMicrophone && micFramesWritten <= 0 {
                try? FileManager.default.removeItem(atPath: finalOutputPath)
                ResponseHandler.returnResponse([
                    "code": "RECORDER_RUNTIME_ERROR",
                    "message": "Final merge failed: microphone capture did not produce any audio frames."
                ], shouldExitProcess: false)
                return false
            }

            let shouldMixMicrophone = includeMicrophone
                && (micTempPath?.isEmpty == false)
                && FileManager.default.fileExists(atPath: micTempPath!)
                && micFramesWritten > 0

            if shouldMixMicrophone, let micTempPath = micTempPath {
                try mixAudioFiles(systemPath: systemTempPath, micPath: micTempPath, outputPath: finalOutputPath)
                return true
            }

            try convertAudioFileToFlac(inputPath: systemTempPath, outputPath: finalOutputPath)
            try validateOutputAudioFile(at: finalOutputPath)
            return true
        } catch {
            try? FileManager.default.removeItem(atPath: finalOutputPath)
            ResponseHandler.returnResponse([
                "code": "RECORDER_RUNTIME_ERROR",
                "message": "Final merge failed: \(error.localizedDescription)"
            ], shouldExitProcess: false)
            return false
        }
    }

    func cleanupTemporaryFiles() {
        let fileManager = FileManager.default

        if let systemTempPath = systemTempPath {
            try? fileManager.removeItem(atPath: systemTempPath)
        }
        if let micTempPath = micTempPath {
            try? fileManager.removeItem(atPath: micTempPath)
        }
        if let mixedTempPath = mixedTempPath {
            try? fileManager.removeItem(atPath: mixedTempPath)
        }
    }

    func stopAndFinalize() {
        guard !isStopping else { return }
        isStopping = true
        microphoneHealthCheckToken = UUID().uuidString

        stopMicrophoneCapture()
        RecorderCLI.terminateCapture()

        systemAudioFileForRecording = nil
        micAudioFileForRecording = nil

        let mergeSucceeded = mergeTempFilesIntoFinalOutput()
        cleanupTemporaryFiles()
        latestSystemLevel = 0
        latestMicLevel = 0
        systemFramesWritten = 0
        micFramesWritten = 0
        emitAudioLevels(force: true)

        let timestamp = Date()
        let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
        ResponseHandler.returnResponse([
            "code": "RECORDING_STOPPED",
            "timestamp": formattedTimestamp,
            "path": finalOutputPath ?? "",
            "finalized": mergeSucceeded
        ], shouldExitProcess: true)
    }

    func attemptStreamRecovery(after errorMessage: String) {
        guard didStartRecording, !isStopping else { return }
        guard !isRecoveringStream else { return }

        if streamRecoveryAttempts >= maxStreamRecoveryAttempts {
            ResponseHandler.returnResponse([
                "code": "STREAM_ERROR",
                "message": errorMessage,
                "path": finalOutputPath ?? ""
            ], shouldExitProcess: false)
            stopAndFinalize()
            return
        }

        streamRecoveryAttempts += 1
        isRecoveringStream = true
        RecorderCLI.terminateCapture()

        ResponseHandler.returnResponse([
            "code": "RECORDER_RUNTIME_ERROR",
            "message": "Stream was stopped by the system. Attempting recovery \(streamRecoveryAttempts)/\(maxStreamRecoveryAttempts).",
            "recoveryAttempt": streamRecoveryAttempts,
            "maxRecoveryAttempts": maxStreamRecoveryAttempts
        ], shouldExitProcess: false)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
            self?.updateAvailableContent()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        processingQueue.async { [weak self] in
            guard let self = self else { return }
            let errorMessage = error.localizedDescription
            let nsError = error as NSError
            ResponseHandler.returnResponse([
                "code": "STREAM_DIAGNOSTICS",
                "message": errorMessage,
                "domain": nsError.domain,
                "errorCode": nsError.code,
                "userInfo": nsError.userInfo,
                "streamRecoveryAttempts": self.streamRecoveryAttempts,
                "systemFramesWritten": self.systemFramesWritten,
                "micFramesWritten": self.micFramesWritten
            ], shouldExitProcess: false)
            if !self.didStartRecording {
                self.failStartup(code: "STREAM_ERROR: \(errorMessage)")
                return
            }
            if !self.isStopping {
                self.attemptStreamRecovery(after: errorMessage)
            }
        }
    }

    static func terminateCapture() {
        screenCaptureStream?.stopCapture()
        screenCaptureStream = nil
    }

    static func availableMicrophoneDevices() -> [[String: Any]] {
        let defaultDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID
        return audioCaptureDevices().map { device in
            [
                "id": device.uniqueID,
                "name": device.localizedName,
                "isDefault": device.uniqueID == defaultDeviceID,
            ]
        }
    }

    static func audioCaptureDevices() -> [AVCaptureDevice] {
        let discovery: AVCaptureDevice.DiscoverySession
        if #available(macOS 14.0, *) {
            discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio,
                position: .unspecified
            )
        } else {
            discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.builtInMicrophone, .externalUnknown],
                mediaType: .audio,
                position: .unspecified
            )
        }

        return discovery.devices
    }
}

extension Date {
    func toFormattedFileName() -> String {
        let fileNameFormatter = DateFormatter()
        fileNameFormatter.locale = Locale(identifier: "en_US_POSIX")
        fileNameFormatter.dateFormat = "ddMMyyyy-HHmm"
        return "Meeting_Recording-\(fileNameFormatter.string(from: self))"
    }
}

class PermissionsRequester {
    static func requestScreenCaptureAccess(completion: @escaping (Bool) -> Void) {
        if !CGPreflightScreenCaptureAccess() {
            let result = CGRequestScreenCaptureAccess()
            completion(result)
        } else {
            completion(true)
        }
    }
}

class ResponseHandler {
    static func returnResponse(_ response: [String: Any], shouldExitProcess: Bool = true) {
        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        } else {
            print("{\"code\": \"JSON_SERIALIZATION_FAILED\"}")
            fflush(stdout)
        }

        if shouldExitProcess {
            exit(0)
        }
    }
}

// https://developer.apple.com/documentation/screencapturekit/capturing_screen_content_in_macos
// For Sonoma updated to https://developer.apple.com/forums/thread/727709
extension CMSampleBuffer {
    var copiedPCMBuffer: AVAudioPCMBuffer? {
        try? self.withAudioBufferList { audioBufferList, _ -> AVAudioPCMBuffer? in
            guard let absd = self.formatDescription?.audioStreamBasicDescription else { return nil }
            var streamDescription = absd
            guard let format = AVAudioFormat(streamDescription: &streamDescription) else { return nil }
            let frameLength = AVAudioFrameCount(self.numSamples)
            guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(frameLength, 1)) else { return nil }
            pcmBuffer.frameLength = frameLength

            let sourceBuffers = UnsafeMutableAudioBufferListPointer(
                UnsafeMutablePointer(mutating: audioBufferList.unsafePointer)
            )
            let destinationBuffers = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
            guard sourceBuffers.count == destinationBuffers.count else { return nil }

            for index in 0..<sourceBuffers.count {
                let sourceBuffer = sourceBuffers[index]
                let byteCount = min(Int(sourceBuffer.mDataByteSize), Int(destinationBuffers[index].mDataByteSize))

                guard
                    byteCount > 0,
                    let sourceData = sourceBuffer.mData,
                    let destinationData = destinationBuffers[index].mData
                else {
                    continue
                }

                memcpy(destinationData, sourceData, byteCount)
                destinationBuffers[index].mDataByteSize = UInt32(byteCount)
            }

            return pcmBuffer
        }
    }
}

let app = RecorderCLI()
app.executeRecordingProcess()
