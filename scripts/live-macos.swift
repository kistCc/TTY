// 实时翻译用的截图程序：常驻运行，反复截一块屏幕区域，画面变了才把新的一帧交给 TTY。
//
// 和 TTY 之间按行传 JSON。
// 收（stdin）：
//   {"cmd":"start","x":..,"y":..,"w":..,"h":..,"pid":..}  开始截这块区域（全局坐标，点，左上为原点，和 Electron 一样）；
//                                                         pid 是 TTY 自己的进程号，截图时排除它的所有窗口（不会截到自己画的译文）
//   {"cmd":"rect","x":..,"y":..,"w":..,"h":..}             区域挪了、改大小了
//   {"cmd":"want"}                                         TTY 处理完上一帧了，画面一变就交下一帧
//   {"cmd":"reset"}                                        忘掉上一次交出去的画面（下一帧就算没变也交）
//   {"cmd":"pause"} / {"cmd":"resume"}                     暂停 / 继续截图
//   {"cmd":"quit"}
// 发（stdout）：
//   {"type":"ready"}
//   {"type":"frame","path":"/tmp/...png","w":像素宽,"h":像素高,"scale":2,"seq":n,"x":..,"y":..,"rw":..,"rh":..}
//   {"type":"interact","on":true|false}   区域里在滚动、拖动（开始 / 停下 150 毫秒后）
//   {"type":"error","msg":"..."}
//
// 截图节奏：画面在变时每 150 毫秒截一次，连续 3 次没变降到 500 毫秒，再静止 5 秒降到 1 秒；截图出错按 0.5、1、2 秒退避。
// 屏幕上有哪些窗口（用来排除 TTY 自己）2 秒查一次，不是每次截图都查一遍。
// 画面有没有变：逐像素比（缩略图比较会漏掉小字的变化），找出变了的那一块有多宽。两种变化不算：
// 颜色值只差一点点的（同一块没动的画面，两次截图也会差 1～2）；窄于 3 点的（闪烁的光标）。
// 不然框里只要有光标，或者截图本身有一点噪声，就会不停地重新识别。
// TTY 一次只处理一帧：它说 want 之后才交下一帧，中间变过几次都只交最新的那一帧。
// （做法参考 SwiftyCrow 的 LiveCaptureCadence / LiveFrame）
// 需要 macOS 14 起（SCScreenshotManager）。

import AppKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Rect: Equatable { var x, y, w, h: Double }

final class State: @unchecked Sendable {
    let lock = NSLock()
    var rect: Rect?
    var pid: pid_t = 0
    var wanted = false
    var paused = false
    var lastEmitted: Frame?
    var wake = false   // 有事要马上截一次（区域变了、交互停了、TTY 要帧）
    func with<T>(_ f: (State) -> T) -> T { lock.lock(); defer { lock.unlock() }; return f(self) }
}

let state = State()
let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outLock.lock(); defer { outLock.unlock() }
    out.write(data)
    out.write("\n".data(using: .utf8)!)
}

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

// ── 读命令 ─────────────────────────────────────────────────────────────
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        func rectFrom(_ o: [String: Any]) -> Rect? {
            guard let x = num(o["x"]), let y = num(o["y"]), let w = num(o["w"]), let h = num(o["h"]), w >= 8, h >= 8 else { return nil }
            return Rect(x: x, y: y, w: w, h: h)
        }
        switch cmd {
        case "start":
            state.with { s in
                s.rect = rectFrom(obj); s.pid = pid_t(num(obj["pid"]) ?? 0)
                s.lastEmitted = nil; s.wanted = true; s.paused = false; s.wake = true
            }
        case "rect":
            state.with { s in s.rect = rectFrom(obj); s.lastEmitted = nil; s.wake = true }
        case "want":
            state.with { s in s.wanted = true; s.wake = true }
        case "reset":
            state.with { s in s.lastEmitted = nil; s.wake = true }
        case "pause":
            state.with { s in s.paused = true }
        case "resume":
            state.with { s in s.paused = false; s.lastEmitted = nil; s.wake = true }
        case "quit":
            exit(0)
        default: break
        }
    }
    exit(0) // TTY 退出、管道断了
}

// ── 截图 ───────────────────────────────────────────────────────────────

/// 一帧的像素（拷一份，下一帧拿来比）
struct Frame {
    let data: Data
    let width: Int, height: Int, bytesPerRow: Int, rowLen: Int
    init?(_ img: CGImage) {
        guard img.bitsPerPixel == 32, let d = img.dataProvider?.data as Data? else { return nil }
        let rowLen = img.width * 4
        guard rowLen <= img.bytesPerRow, d.count >= img.bytesPerRow * img.height else { return nil }
        data = d; width = img.width; height = img.height; bytesPerRow = img.bytesPerRow; self.rowLen = rowLen
    }
}

/// 一个像素四个通道里差得最多的那个超过这个数，才算这个像素变了。
/// 同一块没动的画面，两次截图之间颜色值也会差 1～2（颜色转换、抖动），不能算变
let pixelTolerance = 12

/// 两帧之间变了的地方横向跨了多少像素（0 = 没变；大小不同算全变）。
/// 逐行先整行比，一模一样的行直接跳过；不一样的行再逐个像素看差得多不多
func changedWidth(_ a: Frame, _ b: Frame) -> Int {
    guard a.width == b.width, a.height == b.height else { return Int.max }
    var minX = Int.max, maxX = -1
    a.data.withUnsafeBytes { pa in
        b.data.withUnsafeBytes { pb in
            for row in 0..<a.height {
                let ra = pa.baseAddress! + row * a.bytesPerRow, rb = pb.baseAddress! + row * b.bytesPerRow
                if memcmp(ra, rb, a.rowLen) == 0 { continue }
                let ba = ra.assumingMemoryBound(to: UInt8.self), bb = rb.assumingMemoryBound(to: UInt8.self)
                for x in 0..<a.width {
                    let i = x * 4
                    let d = max(abs(Int(ba[i]) - Int(bb[i])), abs(Int(ba[i + 1]) - Int(bb[i + 1])),
                                abs(Int(ba[i + 2]) - Int(bb[i + 2])), abs(Int(ba[i + 3]) - Int(bb[i + 3])))
                    if d <= pixelTolerance { continue }
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                }
            }
        }
    }
    return maxX < 0 ? 0 : maxX - minX + 1
}

func writePNG(_ img: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, img, nil)
    return CGImageDestinationFinalize(dest)
}

/// 主屏高度（点）。NSEvent 的坐标原点在左下，要换成左上
func primaryHeight() -> Double {
    Double(NSScreen.screens.first?.frame.height ?? 0)
}

func scaleOf(_ displayID: CGDirectDisplayID) -> Double {
    for s in NSScreen.screens {
        if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == displayID {
            return Double(s.backingScaleFactor)
        }
    }
    return 2
}

enum CaptureError: Error { case noDisplay, empty }

/// 上一次查到的屏幕内容。按 TTY 的进程号排除的是整个 App（之后新开的浮层也一起排除），
/// 所以隔一会儿再查就够；区域挪了、改大小了，或者截图出错时马上重查
final class ContentCache: @unchecked Sendable {
    var content: SCShareableContent?
    var at = Date.distantPast
    var rect: Rect?
}
let contentCache = ContentCache()

@available(macOS 14.0, *)
func capture(_ r: Rect, excluding pid: pid_t) async throws -> (CGImage, Double) {
    let content: SCShareableContent
    if let c = contentCache.content, contentCache.rect == r, Date().timeIntervalSince(contentCache.at) < 2 {
        content = c
    } else {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        contentCache.content = content
        contentCache.at = Date()
        contentCache.rect = r
    }
    // 区域中心在哪块屏上就截哪块（SCDisplay.frame 和 Electron 一样是左上为原点的全局坐标）
    let cx = r.x + r.w / 2, cy = r.y + r.h / 2
    guard let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: cx, y: cy)) }) ?? content.displays.first
    else { throw CaptureError.noDisplay }
    let f = display.frame
    let inter = CGRect(x: r.x, y: r.y, width: r.w, height: r.h).intersection(f)
    guard !inter.isNull, inter.width >= 1, inter.height >= 1 else { throw CaptureError.empty }
    // 每次截图都按进程号重新找一遍要排除的窗口：实时翻译开始以后才建的窗口（译文浮层）也要排除
    let apps = content.applications.filter { $0.processID == pid }
    let filter = apps.isEmpty
        ? SCContentFilter(display: display, excludingWindows: content.windows.filter { $0.owningApplication?.processID == pid })
        : SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
    let scale = scaleOf(display.displayID)
    let cfg = SCStreamConfiguration()
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    cfg.sourceRect = CGRect(x: inter.minX - f.minX, y: inter.minY - f.minY, width: inter.width, height: inter.height)
    cfg.width = max(1, Int((inter.width * scale).rounded(.up)))
    cfg.height = max(1, Int((inter.height * scale).rounded(.up)))
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return (img, scale)
}

// ── 滚动、拖动：区域里一动就告诉 TTY 先藏起译文，停下 150 毫秒后再截 ─────────

var interacting = false
var settleTimer: Timer?

func onUserEvent(_ e: NSEvent) {
    guard let r = state.with({ $0.paused ? nil : $0.rect }) else { return }
    let p = NSEvent.mouseLocation
    let x = Double(p.x), y = primaryHeight() - Double(p.y)
    guard x >= r.x, x <= r.x + r.w, y >= r.y, y <= r.y + r.h else { return }
    if !interacting {
        interacting = true
        emit(["type": "interact", "on": true])
    }
    settleTimer?.invalidate()
    settleTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in
        interacting = false
        // 滚回原处时画面和上一次交出去的一样，也要重新交一帧（译文已经藏起来了）
        state.with { s in s.lastEmitted = nil; s.wake = true }
        emit(["type": "interact", "on": false])
    }
}

// ── 主循环 ─────────────────────────────────────────────────────────────

if #available(macOS 14.0, *) {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    // 只看鼠标事件（滚轮、拖动），不需要辅助功能权限
    _ = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel, .leftMouseDragged]) { e in onUserEvent(e) }

    Task.detached {
        var seq = 0
        var previous: Frame?
        var unchanged = 0
        var failures = 0
        let dir = NSTemporaryDirectory()
        emit(["type": "ready"])
        while true {
            let started = Date()
            let snap = state.with { s -> (Rect?, pid_t, Bool) in s.wake = false; return (s.rect, s.pid, s.paused) }
            var interval = 0.15
            if let r = snap.0, !snap.2 {
                do {
                    let (img, scale) = try await capture(r, excluding: snap.1)
                    failures = 0
                    let frame = Frame(img)
                    // 变了的地方窄于 3 点（闪烁的光标）不算变
                    let caret = Int(3 * scale)
                    let changed = { (old: Frame?) -> Bool in
                        guard let old, let frame else { return true }
                        return changedWidth(old, frame) >= caret
                    }
                    unchanged = changed(previous) ? 0 : min(13, unchanged + 1)
                    previous = frame
                    // 连续 3 次没变降到 0.5 秒；再 10 次（约 5 秒）没变降到 1 秒
                    interval = unchanged >= 13 ? 1.0 : unchanged >= 3 ? 0.5 : 0.15
                    let send = state.with { s -> Bool in
                        guard s.wanted, changed(s.lastEmitted), s.rect == r else { return false }
                        s.wanted = false; s.lastEmitted = frame
                        return true
                    }
                    if send {
                        seq += 1
                        let path = (dir as NSString).appendingPathComponent("tty-live-\(getpid())-\(seq).png")
                        if writePNG(img, to: path) {
                            emit(["type": "frame", "path": path, "w": img.width, "h": img.height, "scale": scale, "seq": seq,
                                  "x": r.x, "y": r.y, "rw": r.w, "rh": r.h])
                        } else {
                            state.with { s in s.wanted = true; s.lastEmitted = nil }
                            emit(["type": "error", "msg": "写不了截图文件"])
                        }
                    }
                } catch {
                    contentCache.content = nil
                    failures = min(3, failures + 1)
                    unchanged = 0
                    interval = 0.5 * Double(1 << (failures - 1))
                    emit(["type": "error", "msg": "截图失败：\(error.localizedDescription)"])
                }
            } else {
                interval = 0.1
            }
            // 间隔按"开始到开始"算：截图、写文件花掉的时间不再额外等
            let deadline = started.addingTimeInterval(interval)
            while Date() < deadline {
                if state.with({ $0.wake }) { break }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
        }
    }
    app.run()
} else {
    emit(["type": "error", "msg": "实时翻译需要 macOS 14 或更新版本"])
    exit(1)
}
