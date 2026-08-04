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

import AppKit
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
    let listDisplays: Bool
    let listWindows: Bool
    let displayID: UInt32?
    let windowID: UInt32?
    let selfTest: Bool
    let video: Bool
    let fps: Int
    let framesDir: String?
    let ocr: Bool
    let sceneThreshold: Int
    let maxFrames: Int
    let maxUnsettled: TimeInterval
    let volatilityMask: Bool
    let autoStop: Bool
    let autoStopGrace: TimeInterval
    let stopWhenCallEnds: Bool
    let callEndGrace: TimeInterval
    let menuBar: Bool
    let label: String

    static func parse() -> Args {
        var bundleID = ""
        var outputPath = ""
        var stopAfter: TimeInterval? = nil
        var listApps = false
        var listDisplays = false
        var listWindows = false
        var displayID: UInt32? = nil
        var windowID: UInt32? = nil
        var selfTest = false
        var video = false
        var fps = 1
        var framesDir: String? = nil
        var ocr = true
        var sceneThreshold = 12
        var maxFrames = 200
        var maxUnsettled: TimeInterval = 60
        var volatilityMask = true
        var autoStop = false
        var autoStopGrace: TimeInterval = 30
        var stopWhenCallEnds = false
        var callEndGrace: TimeInterval = 600
        var menuBar = false
        var label = ""
        let args = CommandLine.arguments.dropFirst()
        var it = args.makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--app":             bundleID = it.next() ?? ""
            case "--output":          outputPath = it.next() ?? ""
            case "--stop-after":      stopAfter = TimeInterval(it.next() ?? "")
            case "--list-apps":       listApps = true
            case "--list-displays":   listDisplays = true
            case "--list-windows":    listWindows = true
            case "--display":         displayID = UInt32(it.next() ?? "")
            case "--window":          windowID = UInt32(it.next() ?? "")
            case "--selftest":        selfTest = true
            case "--video":           video = true
            case "--fps":             fps = max(1, Int(it.next() ?? "") ?? 1)
            case "--frames-dir":      framesDir = it.next()
            case "--no-ocr":          ocr = false
            case "--scene-threshold": sceneThreshold = Int(it.next() ?? "") ?? 12
            case "--max-frames":      maxFrames = Int(it.next() ?? "") ?? 200
            case "--max-unsettled":  maxUnsettled = TimeInterval(it.next() ?? "") ?? 60
            case "--no-volatility-mask": volatilityMask = false
            case "--auto-stop":       autoStop = true
            case "--auto-stop-grace": autoStopGrace = TimeInterval(it.next() ?? "") ?? 30
            case "--stop-when-call-ends": stopWhenCallEnds = true
            case "--call-end-grace":  callEndGrace = TimeInterval(it.next() ?? "") ?? 600
            case "--menu-bar":        menuBar = true
            case "--label":           label = it.next() ?? ""
            default: break
            }
        }
        return Args(bundleID: bundleID, outputPath: outputPath, stopAfter: stopAfter,
                    listApps: listApps, listDisplays: listDisplays, listWindows: listWindows,
                    displayID: displayID, windowID: windowID,
                    selfTest: selfTest, video: video, fps: fps,
                    framesDir: framesDir, ocr: ocr, sceneThreshold: sceneThreshold,
                    maxFrames: maxFrames, maxUnsettled: maxUnsettled,
                    volatilityMask: volatilityMask, autoStop: autoStop,
                    autoStopGrace: autoStopGrace, stopWhenCallEnds: stopWhenCallEnds,
                    callEndGrace: callEndGrace, menuBar: menuBar, label: label)
    }
}

// MARK: - WAV writer

final class WAVWriter {
    private let fileHandle: FileHandle
    private var dataByteCount: UInt32 = 0
    private let sampleRate: UInt32 = 16000
    private let channels: UInt16 = 1
    private let bitsPerSample: UInt16 = 16
    /// `dataByteCount` is written on the audio queue and read by the call-end
    /// poll on another thread.
    private let counterLock = NSLock()

    static let headerBytes: UInt32 = 44

    /// How far the recording has got, as a byte offset into the data chunk.
    /// Safe to call from any thread.
    var bytesWritten: UInt32 {
        counterLock.lock()
        defer { counterLock.unlock() }
        return dataByteCount
    }

    /// Seconds of audio in a given number of data bytes.
    func seconds(forDataBytes bytes: UInt32) -> Double {
        Double(bytes) / (Double(sampleRate) * Double(channels) * Double(bitsPerSample) / 8)
    }

    /// Data-chunk offset at which audible sound was last written.
    ///
    /// A second opinion on whether a call has really ended: the microphone being
    /// released says the app thinks it is over, this says nobody is still
    /// talking. Both must agree before a recording is cut back.
    private var lastAudibleByteCount: UInt32 = 0
    var lastAudibleOffset: UInt32 {
        counterLock.lock()
        defer { counterLock.unlock() }
        return lastAudibleByteCount
    }

    /// Deliberately low. Being wrong in the quiet direction means trimming a
    /// live meeting; being wrong in the loud direction just means recording a
    /// little longer, so anything above near-digital-silence counts as speech.
    private let audibleAmplitude: Int16 = 300

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

        var audible = false
        for sample in samples where abs(Int(sample)) > Int(audibleAmplitude) {
            audible = true
            break
        }

        counterLock.lock()
        dataByteCount += UInt32(data.count)
        if audible { lastAudibleByteCount = dataByteCount }
        counterLock.unlock()
    }

    /// Closes the file. `trimmingToDataBytes` cuts the recording back to an
    /// earlier point — used when the call turned out to have ended before we
    /// stopped recording, so the trailing silence never reaches the transcript.
    /// The audio is uncompressed, so this is a truncation and a header rewrite,
    /// not a re-encode.
    @discardableResult
    func finalize(trimmingToDataBytes trim: UInt32? = nil) -> UInt32 {
        func le<T: FixedWidthInteger>(_ v: T) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }

        var finalBytes = bytesWritten
        if var trim, trim < finalBytes {
            // Never cut mid-sample: a 16-bit frame is two bytes and half of one
            // is noise at the end of the file.
            let frameBytes = UInt32(channels * bitsPerSample / 8)
            trim -= trim % frameBytes
            try? fileHandle.truncate(atOffset: UInt64(Self.headerBytes + trim))
            finalBytes = trim
        }

        let riffSize = 36 + finalBytes
        fileHandle.seek(toFileOffset: 4)
        fileHandle.write(le(riffSize))
        fileHandle.seek(toFileOffset: 40)
        fileHandle.write(le(finalBytes))
        fileHandle.closeFile()
        return finalBytes
    }
}

// MARK: - Keyframe writer

struct FrameRecord: Codable {
    let file: String
    let offsetMs: Int
    let fingerprint: String
    let ocrText: String?
    /// Later offsets at which this same screen came back — a deck navigated
    /// backwards, a tab switched away from and returned to. Recorded instead of
    /// writing a second copy of an image already on disk, so the timeline stays
    /// complete while the file count does not grow. Omitted when empty.
    var revisitsMs: [Int]? = nil
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
    private var lastAcceptedGrid: [UInt8]?
    private var lastAcceptedAt: Date?
    private var accepted = 0
    /// Every keyframe's grid, so a screen that comes back is recognised as one we
    /// already hold. 200 frames x 1024 bytes, so retaining all of them is free.
    private var acceptedGrids: [(grid: [UInt8], file: String)] = []

    /// A scene change that has been seen but not yet written. Keyframes are
    /// persisted when the screen *stops* moving rather than when it starts, so a
    /// slide transition or scroll animation collapses to the single frame worth
    /// keeping — and that frame is the settled one, which also OCRs better than
    /// anything caught mid-fade.
    private var pendingGrid: [UInt8]?
    private var pendingBuffer: CVPixelBuffer?
    private var pendingSince: Date?
    private var pendingLastSeen: Date?

    /// Rolling record of which cells moved between *consecutive* samples, used to
    /// mask out regions that are always in motion: a camera tile, a progress bar,
    /// a clock. Without it the standard slide-plus-speaker-tile layout exceeds the
    /// threshold on every sample for the whole meeting, which is what exhausts the
    /// frame budget in the first few minutes.
    private var previousSampleGrid: [UInt8]?
    private var volatilityRing: [[Bool]] = []
    private var volatilityCounts = [Int](repeating: 0, count: gridSide * gridSide)
    private var volatileCells = [Bool](repeating: false, count: gridSide * gridSide)
    /// `volatileCells` grown by one cell — this is what comparisons actually use.
    private var maskedCells = [Bool](repeating: false, count: gridSide * gridSide)

    // Touched only from workQueue.
    private var frames: [FrameRecord] = []
    private var truncated = false

    /// Long edge of the persisted JPEG. Matches Claude's high-resolution image
    /// tier — anything larger costs storage without buying legibility.
    private let maxJPEGEdge: CGFloat = 2576
    /// Floor between two keyframes. Largely redundant now that settling gates the
    /// write, but it still bounds a screen that alternates between two states
    /// faster than anyone could read either.
    private let debounce: TimeInterval = 2.0
    /// How far the screen must have stopped moving to count as settled. Stricter
    /// than `sceneThreshold` on purpose — "has come to rest" is a stronger claim
    /// than "has changed".
    private var settleThreshold: Int { max(1, sceneThreshold / 2) }
    /// Samples in the volatility window, and the fraction of them a cell must move
    /// in to be treated as permanently in motion.
    private let volatilityWindow = 15
    private let volatilityFraction = 0.6
    /// A screen that never comes to rest — a video demo, a continuously scrolling
    /// log — would otherwise emit nothing at all. Force a capture this often.
    private let maxUnsettled: TimeInterval
    private let volatilityMaskEnabled: Bool

    init(framesDir: URL, sessionId: String, sceneThreshold: Int, maxFrames: Int,
         ocrEnabled: Bool, startedAt: Date, maxUnsettled: TimeInterval = 60,
         volatilityMaskEnabled: Bool = true) throws {
        self.framesDir = framesDir
        self.sessionId = sessionId
        self.sceneThreshold = sceneThreshold
        self.maxFrames = maxFrames
        self.ocrEnabled = ocrEnabled
        self.startedAt = startedAt
        self.maxUnsettled = maxUnsettled
        self.volatilityMaskEnabled = volatilityMaskEnabled
        try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
    }

    /// Called on the capture queue. Returns immediately for frames that don't
    /// differ enough from the last keyframe, which is the overwhelming majority.
    func consider(pixelBuffer: CVPixelBuffer, at now: Date) {
        guard let grid = lumaGrid(pixelBuffer) else { return }

        recordVolatility(of: grid)

        if Self.debugEnabled {
            let masked = lastAcceptedGrid.map { changedCells($0, grid) } ?? -1
            let raw = lastAcceptedGrid.map { changedCells($0, grid, masked: false) } ?? -1
            let settle = pendingGrid.map { changedCells($0, grid) } ?? -1
            fputs("  [dbg] t=\(Int(now.timeIntervalSince(startedAt)))s vol=\(volatileCells.filter { $0 }.count) ring=\(volatilityRing.count) dAcc=\(masked) dAccRaw=\(raw) dPend=\(settle) pending=\(pendingGrid != nil) accepted=\(accepted)\n", stderr)
        }

        // The first frame establishes the reference scene, so it is always kept.
        guard let reference = lastAcceptedGrid else {
            accept(pixelBuffer: pixelBuffer, grid: grid, at: now)
            return
        }

        // Indistinguishable from what we already have. Anything that was mid-change
        // has evidently reverted, so drop it.
        if changedCells(reference, grid) < sceneThreshold {
            // ...unless the only reason it looks unchanged is that the mask is
            // ignoring the parts that moved. A full-screen video makes every cell
            // volatile, and silently recording nothing for an hour is worse than
            // recording a frame a minute.
            if let last = lastAcceptedAt,
               now.timeIntervalSince(last) >= maxUnsettled,
               changedCells(reference, grid, masked: false) >= sceneThreshold {
                clearPending()
                accept(pixelBuffer: pixelBuffer, grid: grid, at: now)
                return
            }
            clearPending()
            return
        }

        guard let pending = pendingGrid else {
            setPending(grid: grid, pixelBuffer: pixelBuffer, since: now, at: now)
            return
        }

        // The screen has come to rest since the last sample — this is the frame
        // that was worth waiting for.
        if changedCells(pending, grid) < settleThreshold {
            if let last = lastAcceptedAt, now.timeIntervalSince(last) < debounce { return }
            clearPending()
            accept(pixelBuffer: pixelBuffer, grid: grid, at: now)
            return
        }

        // Still moving. Track the newest state, but don't let a screen that never
        // settles produce nothing at all.
        let since = pendingSince ?? now
        if now.timeIntervalSince(since) >= maxUnsettled {
            clearPending()
            accept(pixelBuffer: pixelBuffer, grid: grid, at: now)
        } else {
            setPending(grid: grid, pixelBuffer: pixelBuffer, since: since, at: now)
        }
    }

    private func setPending(grid: [UInt8], pixelBuffer: CVPixelBuffer, since: Date, at now: Date) {
        pendingGrid = grid
        pendingSince = since
        pendingLastSeen = now
        // Held so a change still in progress when the meeting ends can be flushed
        // by `finalize()` rather than lost.
        pendingBuffer = copyPixelBuffer(pixelBuffer)
    }

    private func clearPending() {
        pendingGrid = nil
        pendingBuffer = nil
        pendingSince = nil
        pendingLastSeen = nil
    }

    /// Commits a frame. Callers have already decided the screen changed and came
    /// to rest; this decides whether that resting state is one we already hold.
    private func accept(pixelBuffer: CVPixelBuffer, grid: [UInt8], at now: Date) {
        let offsetMs = Int(now.timeIntervalSince(startedAt) * 1000)

        // Compared against every keyframe so far, not just the previous one.
        // Otherwise navigating a deck 4 -> 5 -> 4 writes slide 4 twice.
        //
        // The comparison is masked, so the same slide matches itself regardless of
        // what the speaker tile beside it was doing. That only holds while enough
        // of the grid is unmasked to tell two screens apart: on a full-screen video
        // every cell is volatile, and a fully-masked comparison would report every
        // frame as a revisit of the first one.
        let comparable = maskedCells.lazy.filter { !$0 }.count
        if comparable >= maskedCells.count / 4,
           let seen = acceptedGrids.first(where: { changedCells($0.grid, grid) < sceneThreshold }) {
            lastAcceptedGrid = grid
            lastAcceptedAt = now
            workQueue.async { [weak self] in
                self?.recordRevisit(file: seen.file, offsetMs: offsetMs)
            }
            return
        }

        guard accepted < maxFrames else {
            if lastAcceptedGrid != nil { workQueue.async { self.truncated = true } }
            return
        }

        lastAcceptedGrid = grid
        lastAcceptedAt = now
        accepted += 1
        let seq = accepted
        let fingerprint = self.fingerprint(of: grid)
        acceptedGrids.append((grid: grid, file: Self.frameName(seq: seq, offsetMs: offsetMs)))

        // The sample buffer is recycled the moment this returns, so hand the
        // slow stage its own copy.
        guard let copy = copyPixelBuffer(pixelBuffer) else { return }

        workQueue.async { [weak self] in
            self?.persist(pixelBuffer: copy, seq: seq, offsetMs: offsetMs, fingerprint: fingerprint)
        }
    }

    /// The manifest key for a frame. Derived rather than stored so the capture
    /// queue can name a frame before the work queue has written it.
    fileprivate static func frameName(seq: Int, offsetMs: Int) -> String {
        String(format: "%04d-%06d.jpg", seq, offsetMs)
    }

    /// Runs on workQueue, where `frames` lives. The originating `persist` was
    /// dispatched on an earlier sample, so it has already run.
    private func recordRevisit(file: String, offsetMs: Int) {
        guard let index = frames.firstIndex(where: { $0.file == file }) else { return }
        frames[index].revisitsMs = (frames[index].revisitsMs ?? []) + [offsetMs]
    }

    private func persist(pixelBuffer: CVPixelBuffer, seq: Int, offsetMs: Int, fingerprint: String) {
        let name = Self.frameName(seq: seq, offsetMs: offsetMs)
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
    /// Per-sample decision trace, for tuning the thresholds against a real
    /// recording. Resolved once — reading the environment per sample would put a
    /// dictionary build on the capture callback.
    fileprivate static let debugEnabled =
        ProcessInfo.processInfo.environment["MEETEY_DEBUG_KEYFRAMES"] != nil

    fileprivate static let gridSide = 32
    /// Per-cell luma delta (0-255) that counts as "this cell changed".
    fileprivate static let cellDelta: Int = 24
    private var gridSide: Int { Self.gridSide }
    private var cellDelta: Int { Self.cellDelta }

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

    /// Folds this sample into the rolling volatility window. Runs on every sample,
    /// independent of the accept decision — it is measuring how often each region
    /// of the screen is in motion, not whether this particular frame is a keyframe.
    private func recordVolatility(of grid: [UInt8]) {
        guard volatilityMaskEnabled else { return }
        defer { previousSampleGrid = grid }
        guard let previous = previousSampleGrid, previous.count == grid.count else { return }

        var moved = [Bool](repeating: false, count: grid.count)
        for i in 0..<grid.count where abs(Int(previous[i]) - Int(grid[i])) > cellDelta {
            moved[i] = true
            volatilityCounts[i] += 1
        }

        volatilityRing.append(moved)
        if volatilityRing.count > volatilityWindow {
            let evicted = volatilityRing.removeFirst()
            for i in 0..<evicted.count where evicted[i] {
                volatilityCounts[i] -= 1
            }
        }

        // Until the window is full there isn't enough evidence to call anything
        // permanently volatile, and masking early could hide a real scene change.
        guard volatilityRing.count == volatilityWindow else { return }

        // Hysteresis. A cell on the boundary of a moving region averages partial
        // motion, so a single cutoff makes it flicker in and out of the mask and
        // leak a handful of cells through on every sample — which is enough to
        // clear the scene threshold on its own.
        let enter = Int((Double(volatilityWindow) * volatilityFraction).rounded(.up))
        let exit = Int((Double(volatilityWindow) * volatilityFraction / 2).rounded(.up))
        for i in 0..<volatileCells.count {
            volatileCells[i] = volatilityCounts[i] >= enter
                || (volatileCells[i] && volatilityCounts[i] >= exit)
        }

        // Dilate by one cell. The grid averages 40x22 pixels per cell, so the edge
        // of a speaker tile lands mid-cell and moves less than the cells inside it.
        // Growing the mask by its border is what makes it cover the whole region.
        let side = gridSide
        for y in 0..<side {
            for x in 0..<side {
                guard !volatileCells[y * side + x] else { maskedCells[y * side + x] = true; continue }
                var neighbouring = false
                for dy in -1...1 where !neighbouring {
                    for dx in -1...1 {
                        let ny = y + dy, nx = x + dx
                        guard ny >= 0, ny < side, nx >= 0, nx < side else { continue }
                        if volatileCells[ny * side + nx] { neighbouring = true; break }
                    }
                }
                maskedCells[y * side + x] = neighbouring
            }
        }
    }

    /// Counts cells that moved, ignoring those the volatility window has shown to
    /// be in constant motion. A slide headline that changes once is counted; the
    /// speaker tile next to it is not.
    private func changedCells(_ a: [UInt8], _ b: [UInt8], masked: Bool = true) -> Int {
        guard a.count == b.count else { return Int.max }
        let masking = masked && volatilityMaskEnabled && volatilityRing.count == volatilityWindow
        var count = 0
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > cellDelta {
            if masking && maskedCells[i] { continue }
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
        // A meeting that ends mid-change leaves a candidate that never got the
        // chance to settle. It is the last thing that was on screen, so keep it —
        // stamped with when it was last seen, not with the time of the stop.
        if let grid = pendingGrid, let buffer = pendingBuffer, let seen = pendingLastSeen {
            clearPending()
            accept(pixelBuffer: buffer, grid: grid, at: seen)
        }

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

// MARK: - Menu bar indicator

/// A menu bar item showing that a recording is running, with a way to stop it.
///
/// Two jobs, and the second is the more important one. It gives the user a way to
/// stop a recording without switching to Claude Code — but it is also the only
/// continuously visible sign that recording is happening at all. Everything else
/// about Meetey's consent story is a moment in time (a prompt, a command); this is
/// the part that stays true for the whole meeting.
///
/// Works from an unbundled binary: a status item needs `.accessory` activation
/// policy and a running main run loop, not an app bundle. (Notification *action
/// buttons* are the thing that would need bundling.)
@MainActor
final class RecordingIndicator: NSObject {
    private let item: NSStatusItem
    private let startedAt: Date
    private let label: String
    private let onStop: () -> Void
    private var timer: Timer?
    private let elapsedItem: NSMenuItem

    /// Returns nil when there is no GUI session to draw into — an ssh shell, say.
    /// A missing indicator must never take the recording down with it.
    init?(label: String, startedAt: Date, onStop: @escaping () -> Void) {
        guard !NSScreen.screens.isEmpty else { return nil }

        self.startedAt = startedAt
        self.label = label.isEmpty ? "Meeting" : label
        self.onStop = onStop
        self.item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.elapsedItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        super.init()

        item.button?.image = NSImage(systemSymbolName: "record.circle.fill",
                                     accessibilityDescription: "Meetey is recording")
        item.button?.imagePosition = .imageLeading

        let menu = NSMenu()
        let title = NSMenuItem(title: "Recording \(self.label)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        elapsedItem.isEnabled = false
        menu.addItem(elapsedItem)
        menu.addItem(.separator())
        let stop = NSMenuItem(title: "Stop Recording", action: #selector(stopClicked), keyEquivalent: "")
        stop.target = self
        menu.addItem(stop)
        item.menu = menu

        tick()
        // .common so the countdown keeps moving while the menu is open, which is
        // exactly when someone is looking at it.
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        let elapsed = Int(Date().timeIntervalSince(startedAt))
        item.button?.title = " \(Self.clock(elapsed))"
        elapsedItem.title = "\(Self.clock(elapsed)) elapsed"
    }

    private static func clock(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    @objc private func stopClicked() {
        onStop()
    }

    func remove() {
        timer?.invalidate()
        timer = nil
        NSStatusBar.system.removeStatusItem(item)
    }
}

// MARK: - Call-end detection

/// Whether any process currently holds the default input device.
///
/// This is a device *property*, not audio content, so it needs no microphone
/// permission — verified against a build with none granted. Meeting apps take the
/// input device when you join a call and release it when you leave; muting
/// yourself is a software flag and does not release it, which is what makes this
/// a usable proxy for "a call is in progress".
enum Microphone {
    static func inUse() -> Bool? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var deviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &deviceAddress, 0, nil, &size, &device) == noErr else { return nil }

        var running = UInt32(0)
        var runningSize = UInt32(MemoryLayout<UInt32>.size)
        var runningAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(device, &runningAddress, 0, nil,
                                         &runningSize, &running) == noErr else { return nil }
        return running != 0
    }
}

/// Decides that a *call* has ended, as opposed to the app closing.
///
/// The naive version of this — stop as soon as the mic is released — truncates a
/// live meeting whenever the signal is wrong, and the user does not find out
/// until afterwards. So this never stops anything early. It notes where the
/// recording stood when the mic went quiet and keeps recording; if the mic comes
/// back, the note is thrown away and nothing was lost. Only once the signal has
/// held for the full grace period does it commit, and the recording is then cut
/// back to the noted point so the waiting never reaches the transcript.
///
/// Because waiting costs nothing, the grace can be long enough to be sure.
struct MeetingEndMonitor {
    let grace: TimeInterval
    /// Set once the mic has been seen in use. Until then this stays silent: a
    /// recording where no app ever took the mic is not a call whose end we can
    /// detect, and firing on that would kill legitimate recordings that simply
    /// never involved a microphone.
    private var armed = false
    private var candidate: (since: Date, mark: UInt32)?

    init(grace: TimeInterval) { self.grace = grace }

    var isArmed: Bool { armed }
    var hasCandidate: Bool { candidate != nil }

    /// `mark` is how far the recording had got at this poll — the point to cut
    /// back to if the call really did end here. Returns that point once the call
    /// is confirmed over, nil otherwise.
    mutating func update(micInUse: Bool, mark: UInt32, at now: Date) -> UInt32? {
        if micInUse {
            armed = true
            candidate = nil
            return nil
        }
        guard armed else { return nil }

        let current = candidate ?? (since: now, mark: mark)
        candidate = current
        guard now.timeIntervalSince(current.since) >= grace else { return nil }
        return current.mark
    }
}

// MARK: - Auto-stop

/// Decides when a recording should end without being told to.
///
/// Deliberately conservative: it ends a recording only on signals that cannot
/// mean anything else — the app is gone, or the window that was explicitly chosen
/// for capture is gone. It does not try to infer that a *call* ended while the app
/// keeps running, because the cost of being wrong is asymmetric. Stopping late
/// wastes disk; stopping early loses the rest of a meeting that cannot be
/// re-recorded.
///
/// Pure state machine, so `--selftest` can exercise the grace-period behaviour
/// without a live meeting.
struct AutoStopMonitor {
    let grace: TimeInterval
    private var goneSince: Date? = nil

    init(grace: TimeInterval) { self.grace = grace }

    /// `windowPresent` is nil when the recording was not scoped to one window.
    /// Returns a human-readable reason once the condition has held continuously
    /// for the grace period, nil until then.
    mutating func update(appRunning: Bool, windowPresent: Bool?, at now: Date) -> String? {
        let reason: String?
        if !appRunning {
            reason = "the app is no longer running"
        } else if windowPresent == false {
            reason = "the captured window was closed"
        } else {
            reason = nil
        }

        // Recovered. Windows are legitimately destroyed and recreated — Zoom does
        // it entering full screen — so a blip must not end the meeting.
        guard let reason else {
            goneSince = nil
            return nil
        }

        let since = goneSince ?? now
        goneSince = since
        guard now.timeIntervalSince(since) >= grace else { return nil }
        return reason
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
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("meetey-selftest-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? FileManager.default.removeItem(at: root) }
    var failures: [String] = []

    /// Synthesizes a slide. `textShade` fades the headline toward the background
    /// (0 = solid black, 1 = invisible) so a cross-fade can be scripted; `tile`
    /// paints a corner rectangle standing in for a speaker thumbnail; `scramble`
    /// repaints the whole frame so every grid cell moves at once.
    func makeFrame(text: String, background: CGFloat, textShade: CGFloat = 0,
                   tile: CGFloat? = nil, scramble: Int? = nil) -> CVPixelBuffer? {
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

        if let seed = scramble {
            // Deterministic LCG — every 64x64 block gets its own shade, so the
            // whole grid moves between any two seeds.
            var state = UInt64(truncatingIfNeeded: seed &* 6_364_136_223_846_793_005 &+ 1)
            for y in stride(from: 0, to: height, by: 64) {
                for x in stride(from: 0, to: width, by: 64) {
                    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                    let shade = CGFloat((state >> 33) % 256) / 255.0
                    ctx.setFillColor(CGColor(red: shade, green: shade, blue: shade, alpha: 1))
                    ctx.fill(CGRect(x: x, y: y, width: 64, height: 64))
                }
            }
            return pixelBuffer
        }

        let attrs: [NSAttributedString.Key: Any] = [
            .font: CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil),
            .foregroundColor: CGColor(red: textShade, green: textShade, blue: textShade, alpha: 1),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
        ctx.textPosition = CGPoint(x: 80, y: 320)
        CTLineDraw(line, ctx)

        if let tile {
            ctx.setFillColor(CGColor(red: tile, green: tile, blue: tile, alpha: 1))
            ctx.fill(CGRect(x: 940, y: 40, width: 300, height: 200))
        }
        return pixelBuffer
    }

    /// Drives a scripted sequence through a real KeyframeWriter and returns the
    /// manifest it produced.
    func drive(_ name: String, count: Int, sceneThreshold: Int = 12, maxUnsettled: TimeInterval = 60,
               mask: Bool = true, ocr: Bool = false,
               sample: (Int) -> (CVPixelBuffer?, TimeInterval)) throws -> FrameIndex {
        let dir = root.appendingPathComponent(name)
        let writer = try KeyframeWriter(framesDir: dir, sessionId: name, sceneThreshold: sceneThreshold,
                                        maxFrames: 200, ocrEnabled: ocr,
                                        startedAt: Date(timeIntervalSince1970: 0),
                                        maxUnsettled: maxUnsettled, volatilityMaskEnabled: mask)
        for i in 0..<count {
            let (frame, at) = sample(i)
            guard let frame else {
                fputs("selftest: failed to synthesize frame \(i) of \(name)\n", stderr); exit(1)
            }
            writer.consider(pixelBuffer: frame, at: Date(timeIntervalSince1970: at))
        }
        _ = writer.finalize()
        let data = try Data(contentsOf: dir.appendingPathComponent("index.json"))
        return try JSONDecoder().decode(FrameIndex.self, from: data)
    }

    // --- Baseline: duplicate suppression, OCR, manifest shape. -----------------
    // The original regression guard. Spaced 5s apart so the 2s debounce never
    // masks a genuine scene change.
    let basicScript: [(String, CGFloat)] = [
        ("AGENDA", 1.0),   // 1st keyframe — first frame is always kept
        ("AGENDA", 1.0),   // duplicate — suppressed
        ("AGENDA", 1.0),   // duplicate — suppressed
        ("BUDGET", 1.0),   // change begins; held until it settles
        ("BUDGET", 1.0),   // 2nd keyframe — settled
        ("BUDGET", 0.2),   // change begins; flushed by finalize as 3rd keyframe
    ]
    let basic = try drive("basic", count: basicScript.count, ocr: true) { i in
        (makeFrame(text: basicScript[i].0, background: basicScript[i].1), Double(i) * 5)
    }
    if basic.frames.count != 3 { failures.append("basic: expected 3 keyframes, got \(basic.frames.count)") }
    if basic.truncated { failures.append("basic: unexpectedly truncated") }

    let recognized = basic.frames.compactMap { $0.ocrText?.uppercased() }
    if !recognized.contains(where: { $0.contains("AGENDA") }) { failures.append("basic: OCR did not recover 'AGENDA'") }
    if !recognized.contains(where: { $0.contains("BUDGET") }) { failures.append("basic: OCR did not recover 'BUDGET'") }

    for frame in basic.frames {
        let path = root.appendingPathComponent("basic").appendingPathComponent(frame.file)
        let size = (try? FileManager.default.attributesOfItem(atPath: path.path))?[.size] as? Int ?? 0
        if size < 1024 { failures.append("basic: \(frame.file) is \(size) bytes — encode likely failed") }
    }
    if Set(basic.frames.map(\.fingerprint)).count != basic.frames.count {
        failures.append("basic: duplicate fingerprints among accepted keyframes")
    }
    if basic.frames.map(\.offsetMs) != basic.frames.map(\.offsetMs).sorted() {
        failures.append("basic: frames not ordered by offset")
    }
    for frame in basic.frames {
        print("  basic/\(frame.file)  offset=\(frame.offsetMs)ms  ocr=\(frame.ocrText?.replacingOccurrences(of: "\n", with: " ") ?? "-")")
    }

    // --- Settling: a cross-fade must collapse to one keyframe. -----------------
    // Under the old accept-on-change rule this scripted fade produced a file per
    // intermediate. Only the settled frame is worth keeping, and it is the only
    // one that OCRs cleanly.
    // Sampled at 1s, the rate the binary actually runs at, so the transition
    // occupies the one or two samples a real slide change would.
    let fadeScript: [(String, CGFloat)] = [
        ("AGENDA", 0.0),   // 1st keyframe
        ("AGENDA", 0.0),
        ("AGENDA", 0.0),
        ("AGENDA", 0.5),   // caught mid-fade — must not be persisted
        ("BUDGET", 0.25),  // still mid-fade
        ("BUDGET", 0.0),   // arrived, not yet known to have settled
        ("BUDGET", 0.0),   // 2nd keyframe — settled
        ("BUDGET", 0.0),
        ("BUDGET", 0.0),
    ]
    let fade = try drive("fade", count: fadeScript.count, ocr: true) { i in
        (makeFrame(text: fadeScript[i].0, background: 1.0, textShade: fadeScript[i].1), Double(i))
    }
    if fade.frames.count != 2 {
        failures.append("fade: expected 2 keyframes (start + settled), got \(fade.frames.count)")
    }
    if let last = fade.frames.last, !(last.ocrText?.uppercased().contains("BUDGET") ?? false) {
        failures.append("fade: final keyframe is mid-transition, not the settled slide")
    }
    print("  fade: \(fade.frames.count) keyframe(s) from \(fadeScript.count) samples")

    // --- Volatility mask: a moving tile must not emit a keyframe per sample. ---
    // This is the standard slide-plus-speaker-tile layout, and the case that used
    // to exhaust the whole frame budget in the first few minutes of a call.
    let tileCount = 40
    let tiled = try drive("tile", count: tileCount) { i in
        let text = i < tileCount / 2 ? "AGENDA" : "BUDGET"
        // Tile shade changes every sample — a face moving in a thumbnail.
        let tile = CGFloat(i % 7) / 7.0
        return (makeFrame(text: text, background: 1.0, tile: tile), Double(i))
    }
    if tiled.frames.count != 2 {
        failures.append("tile: expected 2 keyframes (one per slide), got \(tiled.frames.count) from \(tileCount) samples")
    }
    print("  tile: \(tiled.frames.count) keyframe(s) from \(tileCount) samples with a tile moving every sample")

    // --- The mask must not suppress genuine slide advances. -------------------
    // Distinct headlines, not "SLIDE 1"/"SLIDE 2" — a single changed digit moves
    // about four cells, which is legitimately below the scene threshold and would
    // be testing the fixture rather than the mask.
    let cadenceSlides = ["AGENDA", "BUDGET", "ROADMAP", "HIRING"]
    let cadenceCount = 60
    let cadence = try drive("cadence", count: cadenceCount) { i in
        (makeFrame(text: cadenceSlides[i / 15], background: 1.0), Double(i))
    }
    if cadence.frames.count != 4 {
        failures.append("cadence: expected 4 keyframes (one per slide), got \(cadence.frames.count)")
    }
    print("  cadence: \(cadence.frames.count) keyframe(s) from \(cadenceCount) samples, slide changing every 15")

    // --- Revisiting a slide must not write a second copy of it. ---------------
    let revisitScript = ["AGENDA", "AGENDA", "AGENDA", "BUDGET", "BUDGET", "BUDGET",
                         "AGENDA", "AGENDA", "AGENDA"]
    let revisit = try drive("revisit", count: revisitScript.count) { i in
        (makeFrame(text: revisitScript[i], background: 1.0), Double(i))
    }
    if revisit.frames.count != 2 {
        failures.append("revisit: expected 2 keyframes for an A-B-A sequence, got \(revisit.frames.count)")
    }
    let revisited = revisit.frames.first?.revisitsMs ?? []
    if revisited.isEmpty {
        failures.append("revisit: returning to the first slide was not recorded as a revisit")
    }
    print("  revisit: \(revisit.frames.count) keyframe(s) from A-B-A, first frame revisited at \(revisited)")

    // --- A screen that never settles must still produce something. ------------
    // Everything is volatile here, so the mask alone would record nothing at all
    // for the entire meeting. The maxUnsettled valve is what prevents that.
    let videoCount = 130
    let video = try drive("video", count: videoCount, maxUnsettled: 60) { i in
        (makeFrame(text: "", background: 1.0, scramble: i), Double(i))
    }
    if video.frames.count < 2 {
        failures.append("video: a continuously-changing screen produced \(video.frames.count) keyframe(s) — the maxUnsettled valve did not fire")
    }
    if video.frames.count > 6 {
        failures.append("video: \(video.frames.count) keyframes from a video-like screen — expected roughly one per maxUnsettled interval")
    }
    print("  video: \(video.frames.count) keyframe(s) from \(videoCount) samples of constant motion")

    // --- Auto-stop: conservative, and never on a blip. ------------------------
    let t0 = Date(timeIntervalSince1970: 0)
    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    var healthy = AutoStopMonitor(grace: 30)
    for s in stride(from: 0.0, through: 300, by: 5) {
        if healthy.update(appRunning: true, windowPresent: true, at: at(s)) != nil {
            failures.append("autostop: ended a healthy recording at \(Int(s))s")
            break
        }
    }

    // No window selected: only the app quitting can end the recording.
    var appOnly = AutoStopMonitor(grace: 30)
    for s in stride(from: 0.0, through: 300, by: 5) {
        if appOnly.update(appRunning: true, windowPresent: nil, at: at(s)) != nil {
            failures.append("autostop: ended an app-scoped recording with the app still running")
            break
        }
    }

    var quit = AutoStopMonitor(grace: 30)
    if quit.update(appRunning: false, windowPresent: nil, at: at(0)) != nil {
        failures.append("autostop: fired immediately instead of waiting out the grace period")
    }
    if quit.update(appRunning: false, windowPresent: nil, at: at(25)) != nil {
        failures.append("autostop: fired at 25s with a 30s grace period")
    }
    if quit.update(appRunning: false, windowPresent: nil, at: at(30)) == nil {
        failures.append("autostop: did not fire once the grace period elapsed")
    }

    // A window destroyed and recreated — Zoom does this entering full screen —
    // must reset the clock rather than accumulate toward a stop.
    var blip = AutoStopMonitor(grace: 30)
    _ = blip.update(appRunning: true, windowPresent: false, at: at(0))
    _ = blip.update(appRunning: true, windowPresent: false, at: at(20))
    if blip.update(appRunning: true, windowPresent: true, at: at(25)) != nil {
        failures.append("autostop: fired on a recovered window")
    }
    if blip.update(appRunning: true, windowPresent: false, at: at(40)) != nil {
        failures.append("autostop: did not reset the grace clock after the window came back")
    }
    if blip.update(appRunning: true, windowPresent: false, at: at(75)) == nil {
        failures.append("autostop: did not fire after the window closed again for a full grace period")
    }

    var closed = AutoStopMonitor(grace: 30)
    _ = closed.update(appRunning: true, windowPresent: false, at: at(0))
    if closed.update(appRunning: true, windowPresent: false, at: at(30)) == nil {
        failures.append("autostop: a closed captured window did not end the recording")
    }
    print("  autostop: grace period, blip recovery, app-quit and window-close all behave")

    // --- Call end: never cut a live meeting, never keep the silence. ----------
    // A recording where no app ever took the microphone is not a call, and must
    // never be ended by this. Otherwise every non-call recording dies.
    var unarmed = MeetingEndMonitor(grace: 600)
    for s in stride(from: 0.0, through: 3600, by: 5) {
        if unarmed.update(micInUse: false, mark: 1000, at: at(s)) != nil {
            failures.append("callend: ended a recording where the mic was never in use")
            break
        }
    }

    // The ordinary case: mic goes quiet, stays quiet, recording cuts back to the
    // moment it went quiet — not to the moment we became confident.
    var ended = MeetingEndMonitor(grace: 600)
    _ = ended.update(micInUse: true, mark: 100, at: at(0))
    if ended.update(micInUse: false, mark: 320_000, at: at(100)) != nil {
        failures.append("callend: committed immediately instead of waiting out the grace period")
    }
    if ended.update(micInUse: false, mark: 640_000, at: at(400)) != nil {
        failures.append("callend: committed before the grace period elapsed")
    }
    let cut = ended.update(micInUse: false, mark: 999_999, at: at(700))
    if cut != 320_000 {
        failures.append("callend: cut back to \(cut.map(String.init) ?? "nil"), expected the mark from when the mic went quiet (320000)")
    }

    // The dangerous case. The mic drops briefly while the meeting is still
    // going; nothing may be lost, and the clock must start over afterwards.
    var blipped = MeetingEndMonitor(grace: 600)
    _ = blipped.update(micInUse: true, mark: 0, at: at(0))
    _ = blipped.update(micInUse: false, mark: 100_000, at: at(60))
    _ = blipped.update(micInUse: false, mark: 200_000, at: at(120))
    if blipped.update(micInUse: true, mark: 300_000, at: at(180)) != nil {
        failures.append("callend: ended a meeting that was still going")
    }
    if blipped.update(micInUse: false, mark: 400_000, at: at(240)) != nil {
        failures.append("callend: did not discard the candidate when the mic came back")
    }
    // 240 + 600 = 840. The new candidate, not the abandoned one at 60s.
    if blipped.update(micInUse: false, mark: 900_000, at: at(830)) != nil {
        failures.append("callend: reused the abandoned candidate's clock")
    }
    let second = blipped.update(micInUse: false, mark: 950_000, at: at(841))
    if second != 400_000 {
        failures.append("callend: cut back to \(second.map(String.init) ?? "nil"), expected the second candidate (400000)")
    }
    print("  callend: unarmed stays silent, grace enforced, blip recovers, cut lands where the mic went quiet")

    // --- Trimming actually truncates the WAV and fixes its header. ------------
    let wavPath = root.appendingPathComponent("trim.wav").path
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let trimWriter = try WAVWriter(path: wavPath)
    // 10s of audio at 16 kHz mono 16-bit.
    trimWriter.append(samples: [Int16](repeating: 0, count: 16000 * 10))
    let keptBytes = trimWriter.finalize(trimmingToDataBytes: 16000 * 2 * 4 + 1) // 4s, odd byte
    let onDisk = (try? FileManager.default.attributesOfItem(atPath: wavPath))?[.size] as? Int ?? 0
    let header = try FileHandle(forReadingFrom: URL(fileURLWithPath: wavPath))
    header.seek(toFileOffset: 40)
    let declared = header.readData(ofLength: 4).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
    try? header.close()

    if keptBytes != 16000 * 2 * 4 {
        failures.append("trim: kept \(keptBytes) bytes, expected 128000 (odd byte should round down to a whole sample)")
    }
    if onDisk != Int(WAVWriter.headerBytes) + 128_000 {
        failures.append("trim: file is \(onDisk) bytes on disk, expected \(Int(WAVWriter.headerBytes) + 128_000)")
    }
    if declared != 128_000 {
        failures.append("trim: header declares \(declared) data bytes, expected 128000 — a reader would run past the end")
    }
    print("  trim: 10s recording cut to 4s, file truncated and header rewritten to match")

    // --- Audible-audio veto: silence and speech must be told apart. ----------
    let vetoPath = root.appendingPathComponent("veto.wav").path
    let vetoWriter = try WAVWriter(path: vetoPath)
    vetoWriter.append(samples: [Int16](repeating: 0, count: 16000))          // 1s silence
    let afterSilence = vetoWriter.lastAudibleOffset
    vetoWriter.append(samples: (0..<16000).map { _ in Int16.random(in: 4000...8000) }) // 1s speech
    let afterSpeech = vetoWriter.lastAudibleOffset
    vetoWriter.append(samples: [Int16](repeating: 0, count: 16000))          // 1s silence
    let afterTrailing = vetoWriter.lastAudibleOffset
    vetoWriter.finalize()

    if afterSilence != 0 {
        failures.append("veto: silence registered as audible (offset \(afterSilence)) — would refuse to ever trim")
    }
    if afterSpeech != 16000 * 2 * 2 {
        failures.append("veto: speech left the audible mark at \(afterSpeech), expected 64000")
    }
    if afterTrailing != afterSpeech {
        failures.append("veto: trailing silence moved the audible mark — trimming would never fire")
    }
    print("  veto: silence and speech distinguished, so a call that is still talking is never cut")

    if failures.isEmpty {
        print("selftest: PASS (settling, volatility mask, cadence, revisit dedup, unsettled valve, auto-stop, call-end trim, OCR + manifest OK)")
        exit(0)
    }
    for failure in failures { fputs("selftest: FAIL — \(failure)\n", stderr) }
    exit(1)
}

// MARK: - Main

let supportedBundleIDs = ["com.google.Chrome", "us.zoom.xos", "com.microsoft.teams"]

func listApps() async throws {
    let content = try await SCShareableContent.current
    let found = content.applications.filter { supportedBundleIDs.contains($0.bundleIdentifier) }
    if found.isEmpty {
        print("[]")
    } else {
        let json = found.map { "{\"bundleID\":\"\($0.bundleIdentifier)\",\"name\":\"\($0.applicationName)\"}" }
            .joined(separator: ",")
        print("[\(json)]")
    }
}

struct DisplayRecord: Codable {
    let displayID: UInt32
    let width: Int          // pixels, not points
    let height: Int
    let isMain: Bool
}

func listDisplays() async throws {
    let content = try await SCShareableContent.current
    let main = CGMainDisplayID()
    let displays = content.displays.map { display -> DisplayRecord in
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        return DisplayRecord(
            displayID: display.displayID,
            width: mode?.pixelWidth ?? display.width * 2,
            height: mode?.pixelHeight ?? display.height * 2,
            isMain: display.displayID == main
        )
    }
    try printJSON(displays)
}

struct WindowRecord: Codable {
    let windowID: UInt32
    let title: String
    let bundleID: String
    let appName: String
    let width: Int
    let height: Int
    let isOnScreen: Bool
    let displayID: UInt32?
}

/// Lists the capturable windows of the supported meeting apps. For Chrome the
/// title is the active tab's, which is what makes a window choosable by a human —
/// ScreenCaptureKit has no concept of a tab, so picking the window holding the
/// meeting is as close as the platform gets.
func listWindows(bundleID: String) async throws {
    let content = try await SCShareableContent.current
    let wanted = bundleID.isEmpty ? supportedBundleIDs : [bundleID]
    let windows = content.windows
        .filter { window in
            guard let app = window.owningApplication, wanted.contains(app.bundleIdentifier) else { return false }
            // Sub-100px windows are toolbars, popups, and off-screen scratch
            // surfaces — never the thing someone means by "the meeting window".
            return window.frame.width >= 100 && window.frame.height >= 100
        }
        // On-screen first, then largest — the meeting is almost always both.
        .sorted { a, b in
            if a.isOnScreen != b.isOnScreen { return a.isOnScreen }
            return a.frame.width * a.frame.height > b.frame.width * b.frame.height
        }
        .map { window in
            WindowRecord(
                windowID: window.windowID,
                title: window.title ?? "",
                bundleID: window.owningApplication?.bundleIdentifier ?? "",
                appName: window.owningApplication?.applicationName ?? "",
                width: Int(window.frame.width),
                height: Int(window.frame.height),
                isOnScreen: window.isOnScreen,
                displayID: displayContaining(window, in: content)?.displayID
            )
        }
    try printJSON(windows)
}

func printJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    print(String(data: try encoder.encode(value), encoding: .utf8) ?? "[]")
}

/// The display holding most of a window, by centre point.
func displayContaining(_ window: SCWindow, in content: SCShareableContent) -> SCDisplay? {
    let centre = CGPoint(x: window.frame.midX, y: window.frame.midY)
    return content.displays.first { $0.frame.contains(centre) }
}

func record(args: Args) async throws {
    let content = try await SCShareableContent.current

    guard let app = content.applications.first(where: { $0.bundleIdentifier == args.bundleID }) else {
        fputs("meetey-capture: app not found: \(args.bundleID)\n", stderr)
        exit(1)
    }

    var window: SCWindow? = nil
    if let requested = args.windowID {
        guard let match = content.windows.first(where: { $0.windowID == requested }) else {
            fputs("meetey-capture: window not found: \(requested). Run --list-windows for current IDs.\n", stderr)
            exit(1)
        }
        guard match.owningApplication?.bundleIdentifier == args.bundleID else {
            fputs("meetey-capture: window \(requested) does not belong to \(args.bundleID)\n", stderr)
            exit(1)
        }
        window = match
    }

    // Pick the display holding the meeting rather than whichever one happens to
    // be first: on a multi-monitor setup those are frequently not the same, and
    // capturing the wrong one yields a session of entirely irrelevant keyframes.
    let display: SCDisplay
    if let requested = args.displayID {
        guard let match = content.displays.first(where: { $0.displayID == requested }) else {
            fputs("meetey-capture: display not found: \(requested). Run --list-displays for current IDs.\n", stderr)
            exit(1)
        }
        display = match
    } else if let window, let holding = displayContaining(window, in: content) {
        display = holding
    } else if let frontmost = content.windows
        .filter({ $0.owningApplication?.bundleIdentifier == args.bundleID && $0.isOnScreen })
        .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }),
        let holding = displayContaining(frontmost, in: content) {
        display = holding
    } else if let first = content.displays.first {
        display = first
    } else {
        fputs("meetey-capture: no display found\n", stderr)
        exit(1)
    }

    // Scoping to a single window keeps the app's other windows and its
    // notification banners out of frame entirely — they are a large source of
    // spurious keyframes as well as the main privacy exposure.
    //
    // Only ever applied when video is on. Audio-only recordings keep the
    // app-scoped filter that the transcript path has always used: a window filter
    // buys nothing without video, and audio is the product — it does not get put
    // at risk for a capture that isn't happening.
    let filter = (args.video ? window : nil).map { SCContentFilter(display: display, including: [$0]) }
        ?? SCContentFilter(display: display, including: [app], exceptingWindows: [])

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
            startedAt: startedAt,
            maxUnsettled: args.maxUnsettled,
            volatilityMaskEnabled: args.volatilityMask
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

    var indicator: RecordingIndicator? = nil
    if args.menuBar {
        let menuLabel = args.label
        indicator = await MainActor.run {
            RecordingIndicator(label: menuLabel, startedAt: startedAt, onStop: fireOnce)
        }
        if indicator == nil {
            fputs("meetey-capture: no GUI session — recording without a menu bar indicator\n", stderr)
        }
    }

    // Where to cut the recording back to, if the call turns out to have ended
    // before we stopped. Written by the poll below, read by finalize.
    let trimLock = NSLock()
    var trimToBytes: UInt32? = nil

    if args.stopWhenCallEnds {
        Task {
            var monitor = MeetingEndMonitor(grace: args.callEndGrace)
            var everArmed = false
            while true {
                try? await Task.sleep(nanoseconds: 5_000_000_000)

                // Unable to read the device is not the same as the mic being
                // free. Treating it as free would end a live meeting.
                guard let inUse = Microphone.inUse() else { continue }

                let mark = writer.bytesWritten
                if let cutTo = monitor.update(micInUse: inUse, mark: mark, at: Date()) {
                    // The mic says the call is over. Before acting on that, check
                    // the audio we have actually been recording — if anyone has
                    // spoken since, the meeting plainly did not end there and the
                    // signal was wrong. Keep recording and start over.
                    if writer.lastAudibleOffset > cutTo {
                        fputs("meetey-capture: microphone released but audio continued — still recording\n", stderr)
                        monitor = MeetingEndMonitor(grace: args.callEndGrace)
                        continue
                    }
                    trimLock.withLock { trimToBytes = cutTo }
                    let trimmed = writer.seconds(forDataBytes: mark - cutTo)
                    fputs(String(format: "meetey-capture: call ended — trimming back %.0fs of silence\n", trimmed), stderr)
                    fireOnce()
                    return
                }
                if monitor.isArmed && !everArmed {
                    everArmed = true
                    fputs("meetey-capture: microphone in use — call-end detection armed\n", stderr)
                }
            }
        }
    }

    if args.autoStop {
        let targetBundleID = args.bundleID
        let targetWindowID = args.windowID
        Task {
            var monitor = AutoStopMonitor(grace: args.autoStopGrace)
            while true {
                try? await Task.sleep(nanoseconds: 5_000_000_000)

                // NSRunningApplication, not SCShareableContent.applications: an
                // app whose windows are all minimised can drop out of shareable
                // content while the meeting is still running and still producing
                // audio. Process liveness is the question being asked here.
                let appRunning = !NSRunningApplication
                    .runningApplications(withBundleIdentifier: targetBundleID).isEmpty

                var windowPresent: Bool? = nil
                if let id = targetWindowID {
                    // A failed query means we don't know, not that the window is
                    // gone. Treating a transient error as "ended" would cut a
                    // live meeting short.
                    guard let content = try? await SCShareableContent.current else { continue }
                    windowPresent = content.windows.contains { $0.windowID == id }
                }

                if let reason = monitor.update(appRunning: appRunning,
                                               windowPresent: windowPresent,
                                               at: Date()) {
                    fputs("meetey-capture: auto-stop — \(reason)\n", stderr)
                    fireOnce()
                    return
                }
            }
        }
    }

    for await _ in stopStream { break }

    try await stream.stopCapture()
    if let indicator {
        await MainActor.run { indicator.remove() }
    }
    let cutTo = trimLock.withLock { trimToBytes }
    let finalBytes = writer.finalize(trimmingToDataBytes: cutTo)
    if cutTo != nil {
        fputs(String(format: "meetey-capture: recording trimmed to %.0fs\n",
                     writer.seconds(forDataBytes: finalBytes)), stderr)
    }
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
        } else if args.listDisplays {
            try await listDisplays()
        } else if args.listWindows {
            try await listWindows(bundleID: args.bundleID)
        } else {
            guard !args.bundleID.isEmpty, !args.outputPath.isEmpty else {
                fputs("""
                Usage: meetey-capture --app <bundle-id> --output <path.wav> [options]
                       meetey-capture --list-apps
                       meetey-capture --list-displays
                       meetey-capture --list-windows [--app <bundle-id>]

                Options:
                  --stop-after <seconds>    Stop automatically after this long
                  --auto-stop               Stop when the app quits, or when the
                                            window given to --window closes
                  --auto-stop-grace <secs>  How long that must hold before
                                            stopping (default 30)
                  --stop-when-call-ends     Also stop when the meeting app releases
                                            the microphone, trimming the recording
                                            back to when that happened
                  --call-end-grace <secs>   How long the mic must stay released
                                            before believing it (default 600)
                  --menu-bar                Show a menu bar indicator with a Stop
                                            Recording item while recording
                  --label <text>            What to call this recording in the menu
                  --display <id>            Display to capture (default: the one
                                            showing the target app)
                  --window <id>             Capture only this window of the app,
                                            excluding its other windows and banners
                  --video                   Also capture screen keyframes (off by default)
                  --fps <n>                 Frames sampled per second (default 1)
                  --frames-dir <path>       Keyframe output directory
                  --no-ocr                  Skip on-device text recognition
                  --scene-threshold <n>     Grid cells (of 1024) that must change (default 12)
                  --max-frames <n>          Cap keyframes per session (default 200)
                  --max-unsettled <secs>    Force a keyframe if the screen never
                                            stops moving for this long (default 60)
                  --no-volatility-mask      Stop ignoring regions that move constantly
                                            (camera tiles, clocks, progress bars)

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

if args.menuBar {
    // A status item needs AppKit's run loop and an activation policy that keeps
    // the process out of the Dock and the app switcher. `.accessory` is what
    // makes an unbundled binary able to own a menu bar item at all.
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.run()
} else {
    RunLoop.main.run()
}
