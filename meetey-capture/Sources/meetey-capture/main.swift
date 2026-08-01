//
// Copyright 2026 John Joseph
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio
import CoreImage
import Vision

// MARK: - Argument parsing

struct Args {
    let bundleID: String
    let outputPath: String
    let stopAfter: TimeInterval?
    let listApps: Bool
    let selfTest: Bool
    let video: Bool
    let fps: Int
    let framesDir: String?
    let ocr: Bool
    let sceneThreshold: Int
    let maxFrames: Int

    static func parse() -> Args {
        var bundleID = ""
        var outputPath = ""
        var stopAfter: TimeInterval? = nil
        var listApps = false
        var selfTest = false
        var video = false
        var fps = 1
        var framesDir: String? = nil
        var ocr = true
        var sceneThreshold = 12
        var maxFrames = 200
        let args = CommandLine.arguments.dropFirst()
        var it = args.makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--app":             bundleID = it.next() ?? ""
            case "--output":          outputPath = it.next() ?? ""
            case "--stop-after":      stopAfter = TimeInterval(it.next() ?? "")
            case "--list-apps":       listApps = true
            case "--selftest":        selfTest = true
            case "--video":           video = true
            case "--fps":             fps = max(1, Int(it.next() ?? "") ?? 1)
            case "--frames-dir":      framesDir = it.next()
            case "--no-ocr":          ocr = false
            case "--scene-threshold": sceneThreshold = Int(it.next() ?? "") ?? 12
            case "--max-frames":      maxFrames = Int(it.next() ?? "") ?? 200
            default: break
            }
        }
        return Args(bundleID: bundleID, outputPath: outputPath, stopAfter: stopAfter,
                    listApps: listApps, selfTest: selfTest, video: video, fps: fps,
                    framesDir: framesDir, ocr: ocr, sceneThreshold: sceneThreshold,
                    maxFrames: maxFrames)
    }
}

// MARK: - WAV writer

final class WAVWriter {
    private let fileHandle: FileHandle
    private var dataByteCount: UInt32 = 0
    private let sampleRate: UInt32 = 16000
    private let channels: UInt16 = 1
    private let bitsPerSample: UInt16 = 16

    init(path: String) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        fileHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        writePlaceholderHeader()
    }

    private func writePlaceholderHeader() {
        var header = Data(count: 44)
        header.replaceSubrange(0..<4,   with: "RIFF".utf8)
        header.replaceSubrange(8..<12,  with: "WAVE".utf8)
        header.replaceSubrange(12..<16, with: "fmt ".utf8)
        let fmtSize: UInt32  = 16
        let pcm: UInt16      = 1
        let byteRate: UInt32 = UInt32(sampleRate) * UInt32(channels) * UInt32(bitsPerSample) / 8
        let blockAlign: UInt16 = channels * bitsPerSample / 8
        func le<T: FixedWidthInteger>(_ v: T) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        header.replaceSubrange(16..<20, with: le(fmtSize))
        header.replaceSubrange(20..<22, with: le(pcm))
        header.replaceSubrange(22..<24, with: le(channels))
        header.replaceSubrange(24..<28, with: le(sampleRate))
        header.replaceSubrange(28..<32, with: le(byteRate))
        header.replaceSubrange(32..<34, with: le(blockAlign))
        header.replaceSubrange(34..<36, with: le(bitsPerSample))
        header.replaceSubrange(36..<40, with: "data".utf8)
        fileHandle.write(header)
    }

    func append(samples: [Int16]) {
        var data = Data(capacity: samples.count * 2)
        for s in samples {
            let le = s.littleEndian
            data.append(contentsOf: withUnsafeBytes(of: le) { Data($0) })
        }
        fileHandle.write(data)
        dataByteCount += UInt32(data.count)
    }

    func finalize() {
        func le<T: FixedWidthInteger>(_ v: T) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        let riffSize = 36 + dataByteCount
        fileHandle.seek(toFileOffset: 4)
        fileHandle.write(le(riffSize))
        fileHandle.seek(toFileOffset: 40)
        fileHandle.write(le(dataByteCount))
        fileHandle.closeFile()
    }
}

// MARK: - Keyframe writer

struct FrameRecord: Codable {
    let file: String
    let offsetMs: Int
    let fingerprint: String
    let ocrText: String?
}

struct FrameIndex: Codable {
    let sessionId: String
    let startedAt: String
    let frameCount: Int
    let truncated: Bool
    let frames: [FrameRecord]
}

/// Persists a JPEG only when the screen changes materially, so an hour of
/// mostly-static meeting produces tens of frames rather than thousands.
///
/// Two stages, deliberately split across queues: perceptual hashing is cheap
/// enough to run on the capture callback, while JPEG encoding and OCR are not —
/// blocking the callback makes ScreenCaptureKit drop frames.
final class KeyframeWriter {
    private let framesDir: URL
    private let sessionId: String
    private let sceneThreshold: Int
    private let maxFrames: Int
    private let ocrEnabled: Bool
    private let startedAt: Date

    private let workQueue = DispatchQueue(label: "com.meetey.keyframes", qos: .utility)
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()

    // Touched only from the capture queue.
    private var lastGrid: [UInt8]?
    private var lastAcceptedAt: Date?
    private var accepted = 0

    // Touched only from workQueue.
    private var frames: [FrameRecord] = []
    private var truncated = false

    /// Long edge of the persisted JPEG. Matches Claude's high-resolution image
    /// tier — anything larger costs storage without buying legibility.
    private let maxJPEGEdge: CGFloat = 2576
    /// Slide transitions and scroll animations otherwise emit a burst of
    /// near-identical frames.
    private let debounce: TimeInterval = 2.0

    init(framesDir: URL, sessionId: String, sceneThreshold: Int, maxFrames: Int,
         ocrEnabled: Bool, startedAt: Date) throws {
        self.framesDir = framesDir
        self.sessionId = sessionId
        self.sceneThreshold = sceneThreshold
        self.maxFrames = maxFrames
        self.ocrEnabled = ocrEnabled
        self.startedAt = startedAt
        try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
    }

    /// Called on the capture queue. Returns immediately for frames that don't
    /// differ enough from the last keyframe, which is the overwhelming majority.
    func consider(pixelBuffer: CVPixelBuffer, at now: Date) {
        guard let grid = lumaGrid(pixelBuffer) else { return }

        if let previous = lastGrid {
            if changedCells(previous, grid) < sceneThreshold { return }
            if let last = lastAcceptedAt, now.timeIntervalSince(last) < debounce { return }
        }

        guard accepted < maxFrames else {
            if lastGrid != nil { workQueue.async { self.truncated = true } }
            return
        }

        lastGrid = grid
        lastAcceptedAt = now
        accepted += 1
        let seq = accepted
        let offsetMs = Int(now.timeIntervalSince(startedAt) * 1000)
        let fingerprint = self.fingerprint(of: grid)

        // The sample buffer is recycled the moment this returns, so hand the
        // slow stage its own copy.
        guard let copy = copyPixelBuffer(pixelBuffer) else { return }

        workQueue.async { [weak self] in
            self?.persist(pixelBuffer: copy, seq: seq, offsetMs: offsetMs, fingerprint: fingerprint)
        }
    }

    private func persist(pixelBuffer: CVPixelBuffer, seq: Int, offsetMs: Int, fingerprint: String) {
        let name = String(format: "%04d-%06d.jpg", seq, offsetMs)
        let image = CIImage(cvPixelBuffer: pixelBuffer)

        // OCR runs on the native-resolution buffer — downscaling first is the
        // difference between legible text and noise on a Retina display.
        var ocrText: String? = nil
        if ocrEnabled {
            ocrText = recognizeText(in: pixelBuffer)
        }

        let scale = min(1.0, maxJPEGEdge / max(image.extent.width, image.extent.height))
        let scaled = scale < 1.0
            ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : image

        let options: [CIImageRepresentationOption: Any] =
            [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7]
        guard let jpeg = ciContext.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: options) else {
            fputs("meetey-capture: failed to encode keyframe \(name)\n", stderr)
            return
        }

        do {
            try jpeg.write(to: framesDir.appendingPathComponent(name))
        } catch {
            fputs("meetey-capture: failed to write keyframe \(name): \(error.localizedDescription)\n", stderr)
            return
        }

        frames.append(FrameRecord(
            file: name,
            offsetMs: offsetMs,
            fingerprint: fingerprint,
            ocrText: (ocrText?.isEmpty ?? true) ? nil : ocrText
        ))
    }

    private func recognizeText(in pixelBuffer: CVPixelBuffer) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            fputs("meetey-capture: OCR failed: \(error.localizedDescription)\n", stderr)
            return nil
        }
        let lines = request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// Side of the square luma grid used for scene detection.
    ///
    /// A perceptual hash (dHash) was the obvious choice here and is wrong for
    /// this content: downsampling a slide to 8x8 averages a headline change into
    /// nothing, so "Agenda" -> "Budget" reads as an unchanged screen. Screen
    /// content changes in *localized regions* rather than globally, so we keep a
    /// coarse luma grid and count how many cells moved.
    private let gridSide = 32
    /// Per-cell luma delta (0-255) that counts as "this cell changed".
    private let cellDelta: Int = 24

    private func lumaGrid(_ pixelBuffer: CVPixelBuffer) -> [UInt8]? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard image.extent.width > 0, image.extent.height > 0 else { return nil }

        let scaled = image.transformed(by: CGAffineTransform(
            scaleX: CGFloat(gridSide) / image.extent.width,
            y: CGFloat(gridSide) / image.extent.height
        ))

        var bytes = [UInt8](repeating: 0, count: gridSide * gridSide * 4)
        bytes.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            ciContext.render(scaled,
                             toBitmap: base,
                             rowBytes: gridSide * 4,
                             bounds: CGRect(x: 0, y: 0, width: gridSide, height: gridSide),
                             format: .RGBA8,
                             colorSpace: colorSpace)
        }

        var grid = [UInt8](repeating: 0, count: gridSide * gridSide)
        for i in 0..<(gridSide * gridSide) {
            let p = i * 4
            let luma = 0.299 * Double(bytes[p]) + 0.587 * Double(bytes[p + 1]) + 0.114 * Double(bytes[p + 2])
            grid[i] = UInt8(max(0, min(255, luma)))
        }
        return grid
    }

    private func changedCells(_ a: [UInt8], _ b: [UInt8]) -> Int {
        guard a.count == b.count else { return Int.max }
        var count = 0
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > cellDelta {
            count += 1
        }
        return count
    }

    /// Identity fingerprint for the manifest — useful when tuning the threshold
    /// against a real recording. Not a perceptual hash; equal fingerprints mean
    /// identical grids, nothing more.
    private func fingerprint(of grid: [UInt8]) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in grid {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return String(format: "%016llx", hash)
    }

    private func copyPixelBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        let format = CVPixelBufferGetPixelFormatType(source)
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]

        var destination: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, format,
                                  attributes as CFDictionary, &destination) == kCVReturnSuccess,
              let output = destination else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(output, [])
        defer {
            CVPixelBufferUnlockBaseAddress(output, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }

        guard let src = CVPixelBufferGetBaseAddress(source),
              let dst = CVPixelBufferGetBaseAddress(output) else { return nil }

        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(output)
        if srcStride == dstStride {
            memcpy(dst, src, srcStride * height)
        } else {
            let row = min(srcStride, dstStride)
            for y in 0..<height {
                memcpy(dst + y * dstStride, src + y * srcStride, row)
            }
        }
        return output
    }

    /// Drains the work queue and writes the manifest. Blocks until done.
    func finalize() -> (count: Int, truncated: Bool) {
        var result = (count: 0, truncated: false)
        workQueue.sync {
            let sorted = frames.sorted { $0.offsetMs < $1.offsetMs }
            let formatter = ISO8601DateFormatter()
            let index = FrameIndex(
                sessionId: sessionId,
                startedAt: formatter.string(from: startedAt),
                frameCount: sorted.count,
                truncated: truncated,
                frames: sorted
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            do {
                let data = try encoder.encode(index)
                try data.write(to: framesDir.appendingPathComponent("index.json"))
            } catch {
                fputs("meetey-capture: failed to write frame index: \(error.localizedDescription)\n", stderr)
            }
            result = (count: sorted.count, truncated: truncated)
        }
        return result
    }
}

// MARK: - Stream delegate

// SCKit is configured to output Float32 at 16 kHz mono — convert directly to Int16, no resampling needed.
final class CaptureDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: WAVWriter
    private let keyframes: KeyframeWriter?

    init(writer: WAVWriter, keyframes: KeyframeWriter?) {
        self.writer = writer
        self.keyframes = keyframes
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .audio:  handleAudio(sampleBuffer)
        case .screen: handleScreen(sampleBuffer)
        // Meetey never requests microphone capture — it records app output only.
        case .microphone: return
        @unknown default: return
        }
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        var audioBufferList = AudioBufferList()
        var blockBufferRef: CMBlockBuffer?
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBufferRef
        )

        let ablPtr = UnsafeMutableAudioBufferListPointer(&audioBufferList)
        guard let audioBuffer = ablPtr.first, let dataPtr = audioBuffer.mData else { return }

        let floatCount = Int(audioBuffer.mDataByteSize) / MemoryLayout<Float32>.size
        let floats = UnsafeBufferPointer(
            start: dataPtr.bindMemory(to: Float32.self, capacity: floatCount),
            count: floatCount
        )
        let samples = floats.map { Int16(max(-32768.0, min(32767.0, $0 * 32767.0))) }
        writer.append(samples: samples)
    }

    private func handleScreen(_ sampleBuffer: CMSampleBuffer) {
        guard let keyframes else { return }

        // ScreenCaptureKit delivers idle/blank/suspended frames alongside real
        // ones. Hashing those produces spurious keyframes on an unchanged screen.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        keyframes.consider(pixelBuffer: pixelBuffer, at: Date())
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("meetey-capture: stream stopped: \(error.localizedDescription)\n", stderr)
    }
}

// MARK: - Self test

/// Drives the real KeyframeWriter with synthetic frames so the dedup, encode,
/// OCR, and manifest paths can be verified without Screen Recording permission
/// or a live meeting. Exits non-zero on failure.
func selfTest() throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("meetey-selftest-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? FileManager.default.removeItem(at: dir) }

    func makeFrame(text: String, background: CGFloat) -> CVPixelBuffer? {
        let width = 1280, height = 720
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                  attributes as CFDictionary, &buffer) == kCVReturnSuccess,
              let pixelBuffer = buffer else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer),
              let ctx = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                      | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }

        ctx.setFillColor(CGColor(red: background, green: background, blue: background, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

        let attrs: [NSAttributedString.Key: Any] = [
            .font: CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil),
            .foregroundColor: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
        ctx.textPosition = CGPoint(x: 80, y: 320)
        CTLineDraw(line, ctx)
        return pixelBuffer
    }

    let writer = try KeyframeWriter(framesDir: dir, sessionId: "selftest", sceneThreshold: 10,
                                    maxFrames: 200, ocrEnabled: true, startedAt: Date(timeIntervalSince1970: 0))

    // Spaced 5s apart so the 2s debounce never masks a genuine scene change.
    let script: [(String, CGFloat)] = [
        ("AGENDA", 1.0),   // 1st keyframe
        ("AGENDA", 1.0),   // duplicate — suppressed
        ("AGENDA", 1.0),   // duplicate — suppressed
        ("BUDGET", 1.0),   // 2nd keyframe
        ("BUDGET", 1.0),   // duplicate — suppressed
        ("BUDGET", 0.2),   // 3rd keyframe (same text, inverted background)
    ]
    for (i, step) in script.enumerated() {
        guard let frame = makeFrame(text: step.0, background: step.1) else {
            fputs("selftest: failed to synthesize frame\n", stderr); exit(1)
        }
        writer.consider(pixelBuffer: frame, at: Date(timeIntervalSince1970: Double(i) * 5))
    }

    let result = writer.finalize()
    let data = try Data(contentsOf: dir.appendingPathComponent("index.json"))
    let index = try JSONDecoder().decode(FrameIndex.self, from: data)

    var failures: [String] = []
    if result.count != 3 { failures.append("expected 3 keyframes, got \(result.count)") }
    if result.truncated { failures.append("unexpectedly truncated") }
    if index.frames.count != 3 { failures.append("index lists \(index.frames.count) frames, expected 3") }

    let recognized = index.frames.compactMap { $0.ocrText?.uppercased() }
    if !recognized.contains(where: { $0.contains("AGENDA") }) { failures.append("OCR did not recover 'AGENDA'") }
    if !recognized.contains(where: { $0.contains("BUDGET") }) { failures.append("OCR did not recover 'BUDGET'") }

    for frame in index.frames {
        let path = dir.appendingPathComponent(frame.file)
        let attrs = try? FileManager.default.attributesOfItem(atPath: path.path)
        let size = (attrs?[.size] as? Int) ?? 0
        if size < 1024 { failures.append("\(frame.file) is \(size) bytes — encode likely failed") }
    }
    if Set(index.frames.map(\.fingerprint)).count != index.frames.count {
        failures.append("duplicate fingerprints among accepted keyframes")
    }
    if index.frames.map(\.offsetMs) != index.frames.map(\.offsetMs).sorted() {
        failures.append("frames not ordered by offset")
    }

    for frame in index.frames {
        print("  \(frame.file)  offset=\(frame.offsetMs)ms  fingerprint=\(frame.fingerprint)  ocr=\(frame.ocrText?.replacingOccurrences(of: "\n", with: " ") ?? "-")")
    }

    if failures.isEmpty {
        print("selftest: PASS (3 keyframes from 6 frames, duplicates suppressed, OCR + manifest OK)")
        exit(0)
    }
    for failure in failures { fputs("selftest: FAIL — \(failure)\n", stderr) }
    exit(1)
}

// MARK: - Main

func listApps() async throws {
    let content = try await SCShareableContent.current
    let known = ["com.google.Chrome", "us.zoom.xos", "com.microsoft.teams"]
    let found = content.applications.filter { known.contains($0.bundleIdentifier) }
    if found.isEmpty {
        print("[]")
    } else {
        let json = found.map { "{\"bundleID\":\"\($0.bundleIdentifier)\",\"name\":\"\($0.applicationName)\"}" }
            .joined(separator: ",")
        print("[\(json)]")
    }
}

func record(args: Args) async throws {
    let content = try await SCShareableContent.current

    guard let app = content.applications.first(where: { $0.bundleIdentifier == args.bundleID }) else {
        fputs("meetey-capture: app not found: \(args.bundleID)\n", stderr)
        exit(1)
    }
    guard let display = content.displays.first else {
        fputs("meetey-capture: no display found\n", stderr)
        exit(1)
    }

    let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 16000
    config.channelCount = 1

    let startedAt = Date()
    var keyframes: KeyframeWriter? = nil

    if args.video {
        // SCDisplay reports points; CGDisplayMode reports pixels. Capturing at
        // point dimensions on a Retina display halves the resolution and makes
        // OCR unusable.
        if let mode = CGDisplayCopyDisplayMode(display.displayID) {
            config.width = mode.pixelWidth
            config.height = mode.pixelHeight
        } else {
            config.width = display.width * 2
            config.height = display.height * 2
        }
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(args.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 5
        // A moving cursor changes the frame hash and would emit keyframes on an
        // otherwise-static screen.
        config.showsCursor = false

        let sessionId = URL(fileURLWithPath: args.outputPath)
            .deletingPathExtension().lastPathComponent
        let dir = args.framesDir.map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: args.outputPath)
                .deletingLastPathComponent()
                .appendingPathComponent("\(sessionId)-frames")

        keyframes = try KeyframeWriter(
            framesDir: dir,
            sessionId: sessionId,
            sceneThreshold: args.sceneThreshold,
            maxFrames: args.maxFrames,
            ocrEnabled: args.ocr,
            startedAt: startedAt
        )
        fputs("meetey-capture: video capture enabled (\(config.width)x\(config.height) @ \(args.fps)fps) -> \(dir.path)\n", stderr)
    } else {
        // SCStream requires video dimensions even for audio-only capture.
        config.width = 2
        config.height = 2
    }

    let writer = try WAVWriter(path: args.outputPath)
    let delegate = CaptureDelegate(writer: writer, keyframes: keyframes)
    let stream = SCStream(filter: filter, configuration: config, delegate: delegate)

    try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
    if args.video {
        try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
    }
    try await stream.startCapture()
    fputs("meetey-capture: recording started\n", stderr)

    // Use AsyncStream to bridge DispatchSource signal handlers into async context
    let (stopStream, stopContinuation) = AsyncStream<Void>.makeStream()

    let box = NSLock()
    var fired = false
    let fireOnce = {
        box.lock()
        defer { box.unlock() }
        guard !fired else { return }
        fired = true
        stopContinuation.yield(())
        stopContinuation.finish()
    }

    // DispatchSource signal handlers can capture context, unlike raw signal()
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT,  SIG_IGN)
    let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    let sigintSrc  = DispatchSource.makeSignalSource(signal: SIGINT,  queue: .global())
    sigtermSrc.setEventHandler { fireOnce() }
    sigintSrc.setEventHandler  { fireOnce() }
    sigtermSrc.resume()
    sigintSrc.resume()

    if let timeout = args.stopAfter {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            fireOnce()
        }
    }

    for await _ in stopStream { break }

    try await stream.stopCapture()
    writer.finalize()
    if let keyframes {
        let result = keyframes.finalize()
        fputs("meetey-capture: wrote \(result.count) keyframe(s)\(result.truncated ? " (truncated at limit)" : "")\n", stderr)
    }
    fputs("meetey-capture: recording saved to \(args.outputPath)\n", stderr)
}

// Entry point
let args = Args.parse()

Task {
    do {
        if args.selfTest {
            try selfTest()
        } else if args.listApps {
            try await listApps()
        } else {
            guard !args.bundleID.isEmpty, !args.outputPath.isEmpty else {
                fputs("""
                Usage: meetey-capture --app <bundle-id> --output <path.wav> [options]
                       meetey-capture --list-apps

                Options:
                  --stop-after <seconds>    Stop automatically after this long
                  --video                   Also capture screen keyframes (off by default)
                  --fps <n>                 Frames sampled per second (default 1)
                  --frames-dir <path>       Keyframe output directory
                  --no-ocr                  Skip on-device text recognition
                  --scene-threshold <n>     Grid cells (of 1024) that must change (default 12)
                  --max-frames <n>          Cap keyframes per session (default 200)

                """, stderr)
                exit(1)
            }
            try await record(args: args)
        }
        exit(0)
    } catch {
        fputs("meetey-capture: error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
