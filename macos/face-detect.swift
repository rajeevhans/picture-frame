// Face detection helper for the picture frame (macOS only), using Apple's
// Vision framework. Long-running: reads one image path per line on stdin and
// writes one JSON line per path on stdout:
//
//   {"path":"/a.jpg","faces":[[x,y,w,h,confidence], ...]}
//   {"path":"/b.jpg","error":"could not read image"}
//
// Boxes are normalized 0..1 with the origin at the TOP-left of the upright
// image (EXIF orientation applied), i.e. the photo as a browser shows it.
//
// Built on demand by src/services/faceDetection.js:
//   swiftc -O macos/face-detect.swift -o data/bin/face-detect

import Foundation
import ImageIO
import Vision

// Decode at most this many pixels on the long side: much faster than a full
// 4K decode, and faces too small to find at this size don't matter for cropping.
let maxPixelSize = 1600

func detect(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        return ["path": path, "error": "could not open image"]
    }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,   // apply EXIF orientation
        kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        return ["path": path, "error": "could not read image"]
    }
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ["path": path, "error": "vision: \(error.localizedDescription)"]
    }
    // Vision boxes are normalized with the origin at the bottom-left; flip y.
    let faces: [String] = (request.results ?? []).map { face in
        let b = face.boundingBox
        let v = [b.minX, 1 - b.maxY, b.width, b.height, CGFloat(face.confidence)]
        return "[" + v.map { String(format: "%.4f", Double($0)) }.joined(separator: ",") + "]"
    }
    return ["path": path, "faces": faces]
}

func encode(_ result: [String: Any]) -> String {
    // Paths go through JSONSerialization for escaping; face arrays are
    // pre-formatted to 4 decimals (JSONSerialization prints 0.8579999999...).
    let path = (try? JSONSerialization.data(withJSONObject: [result["path"] ?? ""]))
        .flatMap { String(data: $0, encoding: .utf8) }
        .map { String($0.dropFirst().dropLast()) } ?? "\"\""
    if let faces = result["faces"] as? [String] {
        return "{\"path\":\(path),\"faces\":[\(faces.joined(separator: ","))]}"
    }
    let error = (try? JSONSerialization.data(withJSONObject: [result["error"] ?? "unknown"]))
        .flatMap { String(data: $0, encoding: .utf8) }
        .map { String($0.dropFirst().dropLast()) } ?? "\"unknown\""
    return "{\"path\":\(path),\"error\":\(error)}"
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
    let path = line.trimmingCharacters(in: .newlines)
    if path.isEmpty { continue }
    autoreleasepool {
        // JSONSerialization leaves U+2028/U+2029 raw, and Node's readline-style
        // splitting treats them as line breaks: escape them so one answer is one line.
        print(encode(detect(path))
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029"))
    }
}
