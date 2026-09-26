// layout-macos <图片>：用 Vision 的文档识别（macOS 26 起才有）看一张截图里哪些行是同一段，
// 输出 [{"p":段号,"x":,"y":,"w":,"h":,"t":文字}]，坐标是原图像素、左上角为原点。
// 只给拼段当提示用，认字还是 ocr-macos 的事。系统低于 26 时输出 [] 退出码 3。
import AppKit
import Foundation
import Vision

func scaled(_ img: CGImage, _ k: Double) -> CGImage? {
    let w = Int(Double(img.width) * k), h = Int(Double(img.height) * k)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

@main
struct LayoutMain {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            FileHandle.standardError.write("Usage: layout-macos <image-path>\n".data(using: .utf8)!)
            exit(1)
        }
        guard #available(macOS 26.0, *) else {
            print("[]")
            exit(3)
        }
        await run(path: args[1])
    }

    @available(macOS 26.0, *)
    static func run(path: String) async {
        guard let image = NSImage(contentsOfFile: path),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            FileHandle.standardError.write("Failed to load image\n".data(using: .utf8)!)
            exit(1)
        }
        let width = Double(cg.width), height = Double(cg.height)
        // 看段落不需要视网膜分辨率：缩到宽 1400 以内再送，快好几倍。坐标是归一化的，不受影响
        var input = cg
        if cg.width > 1400, let small = scaled(cg, 1400.0 / Double(cg.width)) { input = small }
        var request = RecognizeDocumentsRequest()
        request.textRecognitionOptions.automaticallyDetectLanguage = true
        do {
            let observations = try await request.perform(on: input)
            var out: [[String: Any]] = []
            var paragraph = 0
            for observation in observations {
                for para in observation.document.paragraphs {
                    for line in para.lines {
                        guard let text = line.topCandidates(1).first?.string, !text.isEmpty else { continue }
                        // Vision 的归一化坐标原点在左下
                        let b = line.boundingRegion.boundingBox.cgRect
                        out.append([
                            "p": paragraph,
                            "x": (b.minX * width).rounded(),
                            "y": ((1 - b.maxY) * height).rounded(),
                            "w": (b.width * width).rounded(),
                            "h": (b.height * height).rounded(),
                            "t": text,
                        ])
                    }
                    paragraph += 1
                }
            }
            let data = try JSONSerialization.data(withJSONObject: out)
            print(String(data: data, encoding: .utf8) ?? "[]")
        } catch {
            FileHandle.standardError.write("layout failed: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(2)
        }
    }
}
