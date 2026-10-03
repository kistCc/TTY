// 用 macOS 自带的翻译（Translation 框架）翻一批文本。离线、免费、不限量。
//
// 输入（stdin，JSON）：{"target": "zh-Hans", "texts": ["...", ...], "strategy": "fast" | "best", "warm": true（可选，只叫醒服务）}
// 输出（stdout，JSON）：{"translations": ["...", ...], "missing": ["en", ...], "errors": ["..."]}
//   - translations 和 texts 一一对应；没翻（语言包没装、本来就是目标语言、出错）的是空串，调用方保留原文
//   - missing：需要先在「系统设置 → 通用 → 语言与地区 → 翻译语言」下载的源语言
//
// 源语言按段猜：带假名的是日文、带谚文的是韩文、只有汉字的是中文；
// 拉丁字母的短段（"Search"、"Bun"）单独猜不准，统一用整批拉丁字母文本合起来猜出的那一种。
// 需要 macOS 26.4 起（TranslationSession 可以不借助界面直接创建）。

import Foundation
import NaturalLanguage
import Translation

struct Input: Decodable {
    let target: String
    let texts: [String]
    let strategy: String?
    /// true：只把系统翻译服务叫醒（查到语言包状态就退出），不翻译。按下截屏键时先跑一次，
    /// 服务在识字的那几秒里醒过来，轮到翻译时就不用再等它启动
    let warm: Bool?
}

struct Output: Encodable {
    var translations: [String]
    var missing: [String]
    var errors: [String]
    /// 每种源语言分到几段（排查用）
    var groups: [String: Int] = [:]
}

func emit(_ out: Output) {
    let data = (try? JSONEncoder().encode(out)) ?? Data("{\"translations\":[],\"missing\":[],\"errors\":[\"encode\"]}".utf8)
    FileHandle.standardOutput.write(data)
}

func has(_ s: String, _ range: ClosedRange<UInt32>) -> Bool {
    s.unicodeScalars.contains { range.contains($0.value) }
}

/// 这一段是什么语言（Locale 的语言代码），猜不出返回 nil
func scriptLanguage(_ s: String) -> String? {
    if has(s, 0x3040...0x30FF) { return "ja" }
    if has(s, 0xAC00...0xD7AF) { return "ko" }
    if has(s, 0x4E00...0x9FFF) { return "zh-Hans" }
    if has(s, 0x0400...0x04FF) { return "ru" }
    return nil
}

/// 一句拉丁字母文本是哪种语言：四个词以上、把握八成以上才算，否则 nil
func sentenceLanguage(_ t: String) -> String? {
    if t.split(separator: " ").count < 4 { return nil }
    let r = NLLanguageRecognizer()
    r.processString(t)
    guard let (best, p) = r.languageHypotheses(withMaximum: 1).first, p >= 0.8 else { return nil }
    return best.rawValue
}

/// 整批拉丁字母文本是哪种语言：只让长句投票（导航栏的 Sport、Business、Culture 合起来会被猜成葡萄牙文），
/// 至少 3 票、过六成才算数，否则按英文
func guessLatin(_ texts: [String]) -> String {
    var votes: [String: Int] = [:]
    for t in texts { if let l = sentenceLanguage(t) { votes[l, default: 0] += 1 } }
    let total = votes.values.reduce(0, +)
    guard total >= 3, let (best, n) = votes.max(by: { $0.value < $1.value }), Double(n) >= Double(total) * 0.6 else { return "en" }
    return best
}

let raw = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(Input.self, from: raw) else {
    emit(Output(translations: [], missing: [], errors: ["输入不是合法的 JSON"]))
    exit(1)
}

if #available(macOS 26.4, *) {
    var out = Output(translations: Array(repeating: "", count: input.texts.count), missing: [], errors: [])
    let latin = guessLatin(input.texts.filter { scriptLanguage($0) == nil })
    var groups: [String: [Int]] = [:]
    for (i, t) in input.texts.enumerated() where !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        // 英文页里夹的一句德文、西文页里夹的英文，按它自己的语言翻
        let lang = scriptLanguage(t) ?? sentenceLanguage(t) ?? latin
        groups[lang, default: []].append(i)
    }
    let target = Locale.Language(identifier: input.target)
    let availability = LanguageAvailability()
    // 系统翻译服务（translationd）闲置会自己退出。刚被叫起来时，第一次查询会把已装好的语言包
    // 报成「支持但没装」（.supported），约 0.1 秒后再查才是 .installed。
    // 所以服务还没「醒」时查到 .supported，每 0.1 秒重查，最多 1.5 秒；真没装的会一直是 .supported，等满就算缺。
    // 只要有一次查到 .installed，就说明服务已经醒了，之后的 .supported 都是真没装，不再等。
    // （.supported 时直接建会话去翻没用：一样报 notInstalled。）
    var statusCache: [String: LanguageAvailability.Status] = [:]
    var awake = false
    func status(_ source: Locale.Language) async -> LanguageAvailability.Status {
        let key = source.maximalIdentifier
        if let s = statusCache[key] { return s }
        var s = await availability.status(from: source, to: target)
        var waited = 0
        while s == .supported && !awake && waited < 1500 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            waited += 100
            s = await availability.status(from: source, to: target)
        }
        if s == .installed { awake = true }
        statusCache[key] = s
        return s
    }
    if input.warm == true {
        // 随便查一对常用语言就能把服务叫醒；要一直查到 .installed 才算醒（只问一次，退出后服务还是没醒）
        let probe = Locale.Language(identifier: target.minimalIdentifier.hasPrefix("en") ? "zh-Hans" : "en")
        _ = await status(probe)
        emit(out)
        exit(0)
    }
    // 先查段数最多的那种语言，顺便把服务叫醒，后面按单句猜出的小语种不用每个都等
    if let main = groups.filter({ Locale.Language(identifier: $0.key).minimalIdentifier != target.minimalIdentifier })
        .max(by: { $0.value.count < $1.value.count })?.key {
        _ = await status(Locale.Language(identifier: main))
    }
    // 按单句猜出来的拉丁语种，没装语言包就并回整页的语种（单句也有猜错的时候，宁可按整页翻）
    for lang in Array(groups.keys) where lang != latin && scriptLanguage(input.texts[groups[lang]![0]]) == nil {
        let st = await status(Locale.Language(identifier: lang))
        if st != .installed { groups[latin, default: []] += groups.removeValue(forKey: lang)! }
    }
    out.groups = groups.mapValues { $0.count }
    let strategy: TranslationSession.Strategy = input.strategy == "best" ? .highFidelity : .lowLatency
    for (lang, idxs) in groups.sorted(by: { $0.key < $1.key }) {
        let source = Locale.Language(identifier: lang)
        if source.minimalIdentifier == target.minimalIdentifier { continue }
        if await status(source) != .installed {
            out.missing.append(lang)
            continue
        }
        let session = TranslationSession(installedSource: source, target: target, preferredStrategy: strategy)
        let requests = idxs.map { TranslationSession.Request(sourceText: input.texts[$0], clientIdentifier: String($0)) }
        do {
            for r in try await session.translations(from: requests) {
                if let id = r.clientIdentifier, let i = Int(id) { out.translations[i] = r.targetText }
            }
        } catch {
            out.errors.append("\(lang): \(error)")
        }
    }
    emit(out)
} else {
    emit(Output(translations: Array(repeating: "", count: input.texts.count), missing: [], errors: ["需要 macOS 26.4 或更新版本"]))
}
