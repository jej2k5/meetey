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

// MARK: - Argument parsing

struct Args {
    let bundleID: String
    let outputPath: String
    let stopAfter: TimeInterval?
    let listApps: Bool

    static func parse() -> Args {
        var bundleID = ""
        var outputPath = ""
        var stopAfter: TimeInterval? = nil
        var listApps = false
        let args = CommandLine.arguments.dropFirst()
        var it = args.makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--app":        bundleID = it.next() ?? ""
            case "--output":     outputPath = it.next() ?? ""
            case "--stop-after": stopAfter = TimeInterval(it.next() ?? "")
            case "--list-apps":  listApps = true
            default: break
            }
        }
        return Args(bundleID: bundleID, outputPath: outputPath, stopAfter: stopAfter, listApps: listApps)
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

// MARK: - Stream delegate

// SCKit is configured to output Float32 at 16 kHz mono — convert directly to Int16, no resampling needed.
final class CaptureDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: WAVWriter

    init(writer: WAVWriter) {
        self.writer = writer
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

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

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("meetey-capture: stream stopped: \(error.localizedDescription)\n", stderr)
    }
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

func record(bundleID: String, outputPath: String, stopAfter: TimeInterval?) async throws {
    let content = try await SCShareableContent.current

    guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleID }) else {
        fputs("meetey-capture: app not found: \(bundleID)\n", stderr)
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
    config.width = 2
    config.height = 2

    let writer = try WAVWriter(path: outputPath)
    let delegate = CaptureDelegate(writer: writer)
    let stream = SCStream(filter: filter, configuration: config, delegate: delegate)

    try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
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

    if let timeout = stopAfter {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            fireOnce()
        }
    }

    for await _ in stopStream { break }

    try await stream.stopCapture()
    writer.finalize()
    fputs("meetey-capture: recording saved to \(outputPath)\n", stderr)
}

// Entry point
let args = Args.parse()

Task {
    do {
        if args.listApps {
            try await listApps()
        } else {
            guard !args.bundleID.isEmpty, !args.outputPath.isEmpty else {
                fputs("Usage: meetey-capture --app <bundle-id> --output <path.wav> [--stop-after <seconds>]\n       meetey-capture --list-apps\n", stderr)
                exit(1)
            }
            try await record(bundleID: args.bundleID, outputPath: args.outputPath, stopAfter: args.stopAfter)
        }
        exit(0)
    } catch {
        fputs("meetey-capture: error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
