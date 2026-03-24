                                                                                                import AVFoundation
import ScreenCaptureKit

import Foundation
import CoreMedia

class RecorderCLI: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    static weak var activeRecorder: RecorderCLI?
    static var screenCaptureStream: SCStream?

    var contentEligibleForSharing: SCShareableContent?
    let semaphoreRecordingStopped = DispatchSemaphore(value: 0)
    let processingQueue = DispatchQueue(label: "recorder.processing.queue")

    var recordingPath: String?
    var recordingFilename: String?
    var micDeviceID: String?
    var includeMicrophone: Bool = true
    var finalOutputPath: String?
    var systemTempPath: String?
    var micTempPath: String?

    var systemAudioFileForRecording: AVAudioFile?
    var micAudioFileForRecording: AVAudioFile?

    var startupTimeout: TimeInterval = 5.0
    var isStopping = false
    var didStartRecording = false
    var didFailStartup = false
    var latestSystemLevel: Float = 0
    var latestMicLevel: Float = 0
    var lastLevelEmitTime: TimeInterval = 0
    let levelEmitInterval: TimeInterval = 0.1

    // Microphone capture
    var micCaptureSession: AVCaptureSession?
    let microphoneSampleQueue = DispatchQueue(label: "recorder.microphone.sample.queue")

    let targetAudioFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!

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
                guard Self.ensureMicrophoneAccess(promptIfNeeded: true) else {
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
        setupInterruptSignalHandler()
        setupStartupTimeout()
        self.updateAvailableContent()
        semaphoreRecordingStopped.wait()
    }

    // MARK: Microphone Capture
    func startMicrophoneCapture() {
        guard includeMicrophone else { return }
        guard Self.ensureMicrophoneAccess(promptIfNeeded: true) else {
            ResponseHandler.returnResponse(["code": "MIC_PERMISSION_DENIED"], shouldExitProcess: false)
            return
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
            ResponseHandler.returnResponse(["code": "MIC_DEVICE_NOT_FOUND"], shouldExitProcess: false)
            return
        }

        let session = AVCaptureSession()
        session.beginConfiguration()

        do {
            let input = try AVCaptureDeviceInput(device: micDevice)
            if session.canAddInput(input) {
                session.addInput(input)
            } else {
                ResponseHandler.returnResponse(["code": "MIC_CAPTURE_FAILED"], shouldExitProcess: false)
                session.commitConfiguration()
                return
            }

            let output = AVCaptureAudioDataOutput()
            if session.canAddOutput(output) {
                output.setSampleBufferDelegate(self, queue: microphoneSampleQueue)
                session.addOutput(output)
            } else {
                ResponseHandler.returnResponse(["code": "MIC_CAPTURE_FAILED"], shouldExitProcess: false)
                session.commitConfiguration()
                return
            }

            session.commitConfiguration()
            session.startRunning()
            micCaptureSession = session
        } catch {
            session.commitConfiguration()
            ResponseHandler.returnResponse(["code": "MIC_CAPTURE_FAILED"], shouldExitProcess: false)
        }
    }

    func stopMicrophoneCapture() {
        micCaptureSession?.stopRunning()
        micCaptureSession = nil
    }

    func writeMicSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard !isStopping else { return }
        guard let micAudioBuffer = sampleBuffer.asPCMBuffer else { return }
        guard let convertedBuffer = convertBuffer(micAudioBuffer, to: targetAudioFormat) else { return }
        latestMicLevel = normalizedLevel(for: convertedBuffer)
        emitAudioLevels()

        do {
            try micAudioFileForRecording?.write(from: convertedBuffer)
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
        DispatchQueue.global().asyncAfter(deadline: .now() + startupTimeout) { [weak self] in
            guard let self = self else { return }
            self.processingQueue.async {
                if self.didStartRecording || self.didFailStartup || self.isStopping { return }
                self.didFailStartup = true
                RecorderCLI.terminateCapture()
                ResponseHandler.returnResponse(["code": "CAPTURE_START_TIMEOUT"], shouldExitProcess: true)
            }
        }
    }

    func startRecordingSession() {
        if didStartRecording || didFailStartup || isStopping { return }
        didStartRecording = true

        prepareOutputPaths()
        prepareAudioFiles()
        startMicrophoneCapture()

        let formattedTimestamp = ISO8601DateFormatter().string(from: Date())
        let pathForAudioFile = finalOutputPath ?? ""

        ResponseHandler.returnResponse(["code": "RECORDING_STARTED", "path": pathForAudioFile, "timestamp": formattedTimestamp], shouldExitProcess: false)
        emitAudioLevels(force: true)
    }

    func failStartup(code: String) {
        if didStartRecording || didFailStartup || isStopping { return }
        didFailStartup = true
        RecorderCLI.terminateCapture()
        ResponseHandler.returnResponse(["code": code], shouldExitProcess: true)
    }

    func updateAvailableContent() {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, _ in
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

        Task { await initiateRecording(with: screenContentFilter) }
    }

    func prepareOutputPaths() {
        let timestamp = Date()
        let sanitizedFilename: String = {
            let trimmed = (recordingFilename ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? timestamp.toFormattedFileName() : trimmed
        }()

        let basePath = recordingPath ?? "."
        let pid = ProcessInfo.processInfo.processIdentifier
        finalOutputPath = "\(basePath)/\(sanitizedFilename).flac"
        systemTempPath = "\(basePath)/.\(sanitizedFilename).system.\(pid).caf"
        micTempPath = "\(basePath)/.\(sanitizedFilename).mic.\(pid).caf"
    }

    func prepareAudioFiles() {
        guard let systemTempPath = systemTempPath, let micTempPath = micTempPath else {
            ResponseHandler.returnResponse(["code": "AUDIO_FILE_CREATION_FAILED"])
            return
        }

        do {
            systemAudioFileForRecording = try AVAudioFile(forWriting: URL(fileURLWithPath: systemTempPath), settings: targetAudioFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            micAudioFileForRecording = try AVAudioFile(forWriting: URL(fileURLWithPath: micTempPath), settings: targetAudioFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            ResponseHandler.returnResponse(["code": "AUDIO_FILE_CREATION_FAILED"])
        }
    }

    func initiateRecording(with filter: SCContentFilter) async {
        let streamConfiguration = SCStreamConfiguration()
        configureStream(streamConfiguration)

        do {
            RecorderCLI.screenCaptureStream = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)

            try RecorderCLI.screenCaptureStream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global())
            try await RecorderCLI.screenCaptureStream?.startCapture()
            startRecordingSession()
        } catch {
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

        processingQueue.async { [weak self] in
            self?.writeSystemSampleBuffer(sampleBuffer)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid else { return }

        processingQueue.async { [weak self] in
            self?.writeMicSampleBuffer(sampleBuffer)
        }
    }

    func writeSystemSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard !isStopping else { return }
        guard let systemAudioBuffer = sampleBuffer.asPCMBuffer else { return }
        guard let convertedBuffer = convertBuffer(systemAudioBuffer, to: targetAudioFormat) else { return }
        latestSystemLevel = normalizedLevel(for: convertedBuffer)
        emitAudioLevels()

        do {
            try systemAudioFileForRecording?.write(from: convertedBuffer)
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

    func mixAudioBuffers(systemBuffer: AVAudioPCMBuffer, micBuffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        let frameLength = max(systemBuffer.frameLength, micBuffer.frameLength)
        let mixedBuffer = AVAudioPCMBuffer(pcmFormat: targetAudioFormat, frameCapacity: frameLength)!
        mixedBuffer.frameLength = frameLength

        let channelCount = Int(targetAudioFormat.channelCount)
        for channel in 0..<channelCount {
            let sys = systemBuffer.floatChannelData![channel]
            let mic = micBuffer.floatChannelData![channel]
            let mix = mixedBuffer.floatChannelData![channel]

            for i in 0..<Int(systemBuffer.frameLength) {
                mix[i] = sys[i]
            }

            for i in 0..<Int(micBuffer.frameLength) {
                let mixedSample = mix[i] + mic[i]
                mix[i] = max(-1.0, min(1.0, mixedSample))
            }
        }

        return mixedBuffer
    }

    func mergeTempFilesIntoFinalOutput() {
        guard
            let systemTempPath = systemTempPath,
            let micTempPath = micTempPath,
            let finalOutputPath = finalOutputPath
        else {
            ResponseHandler.returnResponse(["code": "MERGE_FAILED"], shouldExitProcess: false)
            return
        }

        do {
            let systemAudioFile = try AVAudioFile(forReading: URL(fileURLWithPath: systemTempPath))
            let micAudioFile = try AVAudioFile(forReading: URL(fileURLWithPath: micTempPath))
            let mixedAudioFile = try AVAudioFile(
                forWriting: URL(fileURLWithPath: finalOutputPath),
                settings: [
                    AVSampleRateKey: 48_000,
                    AVNumberOfChannelsKey: 2,
                    AVFormatIDKey: kAudioFormatFLAC,
                ],
                commonFormat: .pcmFormatFloat32,
                interleaved: false
            )

            let frameCount: AVAudioFrameCount = 4096
            while true {
                guard let systemBuffer = AVAudioPCMBuffer(pcmFormat: targetAudioFormat, frameCapacity: frameCount) else { break }
                guard let micBuffer = AVAudioPCMBuffer(pcmFormat: targetAudioFormat, frameCapacity: frameCount) else { break }

                try systemAudioFile.read(into: systemBuffer, frameCount: frameCount)
                try micAudioFile.read(into: micBuffer, frameCount: frameCount)

                if systemBuffer.frameLength == 0 && micBuffer.frameLength == 0 {
                    break
                }

                let mixedBuffer = mixAudioBuffers(systemBuffer: systemBuffer, micBuffer: micBuffer)
                try mixedAudioFile.write(from: mixedBuffer)
            }
        } catch {
            ResponseHandler.returnResponse(["code": "MERGE_FAILED"], shouldExitProcess: false)
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
    }

    func stopAndFinalize() {
        guard !isStopping else { return }
        isStopping = true

        stopMicrophoneCapture()
        RecorderCLI.terminateCapture()

        systemAudioFileForRecording = nil
        micAudioFileForRecording = nil

        mergeTempFilesIntoFinalOutput()
        cleanupTemporaryFiles()
        latestSystemLevel = 0
        latestMicLevel = 0
        emitAudioLevels(force: true)

        let timestamp = Date()
        let formattedTimestamp = ISO8601DateFormatter().string(from: timestamp)
        ResponseHandler.returnResponse(["code": "RECORDING_STOPPED", "timestamp": formattedTimestamp, "path": finalOutputPath ?? ""], shouldExitProcess: false)
        semaphoreRecordingStopped.signal()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        processingQueue.async { [weak self] in
            guard let self = self else { return }
            let errorMessage = error.localizedDescription
            if !self.didStartRecording {
                self.failStartup(code: "STREAM_ERROR: \(errorMessage)")
                return
            }
            if !self.isStopping {
                ResponseHandler.returnResponse(["code": "STREAM_ERROR: \(errorMessage)"], shouldExitProcess: false)
                self.stopAndFinalize()
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
    var asPCMBuffer: AVAudioPCMBuffer? {
        try? self.withAudioBufferList { audioBufferList, _ -> AVAudioPCMBuffer? in
            guard let absd = self.formatDescription?.audioStreamBasicDescription else { return nil }
            guard let format = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate, channels: absd.mChannelsPerFrame) else { return nil }
            return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: audioBufferList.unsafePointer)
        }
    }
}

let app = RecorderCLI()
app.executeRecordingProcess()
