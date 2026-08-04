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
            default: break
            }
        }
        return Args(bundleID: bundleID, outputPath: outputPath, stopAfter: stopAfter,
                    listApps: listApps, listDisplays: listDisplays, listWindows: listWindows,
                    displayID: displayID, windowID: windowID,
                    selfTest: selfTest, video: video, fps: fps,
                    framesDir: framesDir, ocr: ocr, sceneThreshold: sceneThreshold,
                    maxFrames: maxFrames, maxUnsettled: maxUnsettled,
                    volatilityMask: volatilityMask)
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

    if failures.isEmpty {
        print("selftest: PASS (settling, volatility mask, cadence, revisit dedup, unsettled valve, OCR + manifest OK)")
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

RunLoop.main.run()
