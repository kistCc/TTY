#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>

/// 笔画粗细：框里墨迹面积 × 2 ÷ 墨迹边界像素数，约等于平均笔画宽度（像素），跟是哪些字母无关。
/// 粗体大约是同字号常规体的 1.5 倍。不除以框高：框高会被上标、带下行的字母撑高，
/// 除了反而不准；比较字重的地方本来就只比字号相近的两行。
/// 墨迹 = 框内跟背景差得远的像素；背景取框内亮度的中位数（文字只占框的一小部分）。
static double strokeWeight(const uint8_t *gray, size_t W, size_t H, double x, double y, double w, double h) {
    long x0 = MAX(0, (long)x), y0 = MAX(0, (long)y);
    long x1 = MIN((long)W, (long)(x + w)), y1 = MIN((long)H, (long)(y + h));
    if (x1 - x0 < 4 || y1 - y0 < 4) return 0;
    int hist[256] = {0};
    long n = 0;
    for (long yy = y0; yy < y1; yy++) for (long xx = x0; xx < x1; xx++) { hist[gray[yy * W + xx]]++; n++; }
    int bg = 0; long acc = 0;
    for (; bg < 256; bg++) { acc += hist[bg]; if (acc * 2 >= n) break; }
    // 墨迹阈值：背景和最远那一端的中点
    int far = bg;
    for (int v = 0; v < 256; v++) if (hist[v] && abs(v - bg) > abs(far - bg)) far = v;
    int cut = abs(far - bg) / 2;
    if (cut < 24) return 0;  // 框里几乎没有对比，量不出来
    #define INK(xx, yy) (abs((int)gray[(yy) * W + (xx)] - bg) > cut)
    long area = 0, edge = 0;
    for (long yy = y0; yy < y1; yy++) for (long xx = x0; xx < x1; xx++) {
        if (!INK(xx, yy)) continue;
        area++;
        if (xx == x0 || xx == x1 - 1 || yy == y0 || yy == y1 - 1
            || !INK(xx - 1, yy) || !INK(xx + 1, yy) || !INK(xx, yy - 1) || !INK(xx, yy + 1)) edge++;
    }
    #undef INK
    if (!edge) return 0;
    return 2.0 * area / edge;
}

/// 原图的 sRGB 像素（RGBA 各 8 位，第 0 行是最上面一行）。取色和浮层画布用同一套色彩空间，
/// P3 屏幕上取出来的颜色画回去才不会偏。
static uint8_t *loadRGBA(CGImageRef img, size_t W, size_t H) {
    uint8_t *buf = calloc(W * H * 4, 1);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef c = CGBitmapContextCreate(buf, W, H, 8, W * 4, srgb,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    if (c) { CGContextDrawImage(c, CGRectMake(0, 0, W, H), img); CGContextRelease(c); }
    CGColorSpaceRelease(srgb);
    return buf;
}

typedef struct { int r, g, b; } RGB;

static inline double colorDist(RGB a, const uint8_t *p) {
    double dr = a.r - p[0], dg = a.g - p[1], db = a.b - p[2];
    return sqrt(dr * dr + dg * dg + db * db);
}

static inline double rgbDist(RGB a, RGB b) {
    double dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return sqrt(dr * dr + dg * dg + db * db);
}

/// 框边上一圈像素里出现最多的颜色 = 字底下的底色（字形很少碰到自己框的边）。
/// 和浮层擦除用的是同一个办法。
static RGB edgeColor(const uint8_t *rgba, size_t W, size_t H, long x0, long y0, long x1, long y1) {
    x0 = MAX(0, x0); y0 = MAX(0, y0); x1 = MIN((long)W - 1, x1); y1 = MIN((long)H - 1, y1);
    RGB none = { 255, 255, 255 };
    if (x1 <= x0 || y1 <= y0) return none;
    static int cnt[4096]; static long sr[4096], sg[4096], sb[4096];
    memset(cnt, 0, sizeof cnt); memset(sr, 0, sizeof sr); memset(sg, 0, sizeof sg); memset(sb, 0, sizeof sb);
    #define ADD(xx, yy) do { const uint8_t *p = rgba + ((yy) * W + (xx)) * 4; \
        int k = (p[0] >> 4) << 8 | (p[1] >> 4) << 4 | (p[2] >> 4); \
        cnt[k]++; sr[k] += p[0]; sg[k] += p[1]; sb[k] += p[2]; } while (0)
    for (long x = x0; x <= x1; x++) { ADD(x, y0); ADD(x, y1); }
    for (long y = y0 + 1; y < y1; y++) { ADD(x0, y); ADD(x1, y); }
    #undef ADD
    int best = 0;
    for (int k = 1; k < 4096; k++) if (cnt[k] > cnt[best]) best = k;
    if (!cnt[best]) return none;
    RGB out = { (int)(sr[best] / cnt[best]), (int)(sg[best] / cnt[best]), (int)(sb[best] / cnt[best]) };
    return out;
}

/// 一个词的字色：框里跟底色差得开的像素，按颜色分桶，取像素最多的那一桶。
/// 不取"离底色最远"的像素：词框常常带进旁边的标点（蓝色链接后面的白色逗号、中间的白点），
/// 白色离深色底色更远，按远近取就会把蓝色链接量成白色；按数量取，链接自己的像素总是多数。
/// *count 是那一桶的像素数，0 表示量不出来。
/// 一个词框里真正有笔画的左右边界。Vision 给的词框把前后的空格也包进去，
/// 相邻两个词的框几乎贴着（普通词距和一排菜单项之间的大空当量出来都是 2–5 像素），
/// 按框算间距根本分不开。按像素找到第一列和最后一列有笔画的地方，间距才是真的。
static BOOL inkExtent(const uint8_t *rgba, size_t W, size_t H, long x0, long y0, long x1, long y1, RGB bg, long *ix0, long *ix1) {
    x0 = MAX(0, x0); x1 = MIN((long)W - 1, x1);
    long h = y1 - y0;
    long ya = MAX(0, y0 + h / 10), yb = MIN((long)H - 1, y1 - h / 10);
    if (x1 <= x0 || yb <= ya) return NO;
    long first = -1, last = -1;
    for (long x = x0; x <= x1; x++) {
        int hits = 0;
        for (long y = ya; y <= yb && hits < 2; y++) {
            const uint8_t *q = rgba + (y * W + x) * 4;
            RGB c = { q[0], q[1], q[2] };
            if (rgbDist(c, bg) > 80) hits++;
        }
        if (hits >= 2) { if (first < 0) first = x; last = x; }
    }
    if (first < 0 || last - first < 1) return NO;
    *ix0 = first; *ix1 = last;
    return YES;
}

static RGB inkColor(const uint8_t *rgba, size_t W, size_t H, long x0, long y0, long x1, long y1, RGB bg, long *count) {
    x0 = MAX(0, x0); y0 = MAX(0, y0); x1 = MIN((long)W, x1); y1 = MIN((long)H, y1);
    *count = 0;
    if (x1 - x0 < 2 || y1 - y0 < 2) return bg;
    double maxd = 0;
    for (long y = y0; y < y1; y++) for (long x = x0; x < x1; x++) {
        double d = colorDist(bg, rgba + (y * W + x) * 4);
        if (d > maxd) maxd = d;
    }
    if (maxd < 48) return bg;  // 框里没有跟底色差得开的像素
    double thr = MAX(40, maxd * 0.45);
    static int hist[4096];
    memset(hist, 0, sizeof hist);
    #define BUCKET(p) (((p)[0] >> 4) << 8 | ((p)[1] >> 4) << 4 | ((p)[2] >> 4))
    for (long y = y0; y < y1; y++) for (long x = x0; x < x1; x++) {
        const uint8_t *p = rgba + (y * W + x) * 4;
        if (colorDist(bg, p) >= thr) hist[BUCKET(p)]++;
    }
    int best = 0;
    for (int k = 1; k < 4096; k++) if (hist[k] > hist[best]) best = k;
    if (!hist[best]) return bg;
    int br = best >> 8, bgc = (best >> 4) & 15, bb = best & 15;
    // 那一桶和它上下左右相邻的桶一起取平均：真正的字色常常正好落在桶的边上
    long n = 0, r = 0, g = 0, b = 0;
    for (long y = y0; y < y1; y++) for (long x = x0; x < x1; x++) {
        const uint8_t *p = rgba + (y * W + x) * 4;
        if (abs((p[0] >> 4) - br) > 1 || abs((p[1] >> 4) - bgc) > 1 || abs((p[2] >> 4) - bb) > 1) continue;
        if (colorDist(bg, p) < thr) continue;
        n++; r += p[0]; g += p[1]; b += p[2];
    }
    #undef BUCKET
    *count = n;
    RGB out = { (int)(r / MAX(n, 1)), (int)(g / MAX(n, 1)), (int)(b / MAX(n, 1)) };
    return out;
}

/// 一行里字色像素占了多少
static double rowCoverage(const uint8_t *rgba, size_t W, long y, long x0, long x1, RGB ink, double tol) {
    long hit = 0;
    for (long x = x0; x < x1; x++) if (colorDist(ink, rgba + (y * W + x) * 4) < tol) hit++;
    return (double)hit / MAX(1, x1 - x0);
}

/// 词下面有没有下划线：框底附近找一行，横跨这个词大部分宽度都是字色，
/// 而且它和字身之间隔着一条几乎没有字色的空行（只有 g、j、p 这类字母的下伸部分穿过）。
/// 网页的下划线在下伸字母处会断开，所以覆盖率只要 65%；靠那条空行把"字母底边连成一片"
/// （衬线字体的底部衬线）排除掉。找到返回那一行的 y，没有返回 -1。
static long underlineRow(const uint8_t *rgba, size_t W, size_t H, long x0, long x1, long boxTop, long boxBottom, long h, RGB ink, RGB bg, long *thick) {
    *thick = 0;
    x0 = MAX(0, x0); x1 = MIN((long)W, x1);
    if (x1 - x0 < MAX(h, 6)) return -1;
    double tol = MAX(40, rgbDist(ink, bg) * 0.35);
    long from = MAX(boxTop + h / 2, boxBottom - h / 3), to = MIN((long)H - 1, boxBottom + h / 2);
    for (long y = from; y <= to; y++) {
        if (rowCoverage(rgba, W, y, x0, x1, ink, tol) < 0.65) continue;
        BOOL gap = NO;
        for (long k = 1; k <= 4 && y - k > boxTop; k++) {
            if (rowCoverage(rgba, W, y - k, x0, x1, ink, tol) < 0.15) { gap = YES; break; }
        }
        if (!gap) continue;
        long t = 1;
        while (y + t <= to && t < 6 && rowCoverage(rgba, W, y + t, x0, x1, ink, tol) >= 0.65) t++;
        *thick = t;
        return y;
    }
    return -1;
}

/// 一块字里每个词的颜色（和下划线）。词的位置用 Vision 自己给的 boundingBoxForRange，
/// 一行里夹着的蓝色链接就是靠这个认出来的。
/// Vision 有时给不出词级位置（每个词都回整行的框），这时整块不输出词，只剩整块的字色。
/// 坐标换算：Vision 给的是"请求那张图"里 roi 内的归一化坐标（原点左下）；这张图是原图里
/// 以 (ox, oy) 为左上角、fw×fh 大小的一块按比例放大来的，所以换回原图像素只要这几个数。
static NSArray *tokenColors(VNRecognizedText *candidate, CGRect obsBox, CGRect roi, double ox, double oy, double fw, double fh,
                            const uint8_t *rgba, size_t W, size_t H, RGB bg, long *eraseBottom) {
    NSString *s = candidate.string;
    // 按空格切：Vision 自己也是按空格认词的，"Archer-SQ/screen-translator" 这种拆成
    // 几个小词去问位置，每个都会拿到同一个错的小框。中日韩文没有空格，一整串再按词切。
    NSMutableArray<NSValue *> *ranges = [NSMutableArray array];
    NSRegularExpression *chunkRe = [NSRegularExpression regularExpressionWithPattern:@"\\S+" options:0 error:nil];
    NSRegularExpression *cjkRe = [NSRegularExpression regularExpressionWithPattern:@"[\\u3040-\\u30ff\\u4e00-\\u9fff\\uac00-\\ud7af]" options:0 error:nil];
    for (NSTextCheckingResult *m in [chunkRe matchesInString:s options:0 range:NSMakeRange(0, s.length)]) {
        NSRange r = m.range;
        if (r.length > 2 && [cjkRe numberOfMatchesInString:s options:0 range:r] > 0) {
            [s enumerateSubstringsInRange:r options:NSStringEnumerationByWords
                               usingBlock:^(NSString *w, NSRange wr, NSRange er, BOOL *stop) { [ranges addObject:[NSValue valueWithRange:wr]]; }];
        } else {
            [ranges addObject:[NSValue valueWithRange:r]];
        }
        if (ranges.count >= 200) break;
    }

    NSMutableArray *tokens = [NSMutableArray array];
    NSMutableArray<NSValue *> *boxes = [NSMutableArray array];
    long lowest = -1;
    for (NSValue *v in ranges) {
        NSRange range = v.rangeValue;
        NSError *err = nil;
        VNRectangleObservation *r = [candidate boundingBoxForRange:range error:&err];
        if (!r) continue;
        CGRect b = r.boundingBox;
        CGRect box = CGRectMake(roi.origin.x + b.origin.x * roi.size.width,
                                roi.origin.y + b.origin.y * roi.size.height,
                                b.size.width * roi.size.width,
                                b.size.height * roi.size.height);
        // Vision 给不出词级位置时每个词都回整行的框：整块不输出词
        if (range.length < s.length * 0.6 && box.size.width > obsBox.size.width * 0.9) return @[];
        long x = lround(ox + box.origin.x * fw), w = lround(box.size.width * fw);
        long y = lround(oy + (1.0 - box.origin.y - box.size.height) * fh), h = lround(box.size.height * fh);
        [boxes addObject:[NSValue valueWithRect:NSMakeRect(x, y, w, h)]];
        long n = 0;
        // 词框左右各收 1 像素，别把隔壁词的笔画算进来
        RGB tbg = edgeColor(rgba, W, H, x, y, x + w, y + h);
        // 横向位置收到真正有笔画的范围（见 inkExtent），输出的 x、w 才能量出真实的词距
        { long ix0, ix1; if (inkExtent(rgba, W, H, x, y, x + w, y + h, tbg, &ix0, &ix1)) { x = ix0; w = ix1 - ix0 + 1; } }
        RGB ink = inkColor(rgba, W, H, x, y, x + w, y + h, bg, &n);
        // 这个词底下的底色跟整块的不一样（徽章、按钮拼在一起的块），量出来的颜色没意义
        if (rgbDist(tbg, bg) > 60) n = 0;
        // x、w 是这个词在原图上的横向位置：一行里词和词隔得特别开（一排菜单被认成一行）时，调用方按它拆开
        NSMutableDictionary *t = [@{ @"s": @(range.location), @"e": @(range.location + range.length), @"x": @(x), @"w": @(w),
                                     @"c": @[@(ink.r), @(ink.g), @(ink.b)], @"n": @(n) } mutableCopy];
        if (n > 0) {
            long thick = 0;
            long uy = underlineRow(rgba, W, H, x, x + w, y, y + h, h, ink, bg, &thick);
            if (uy >= 0) { t[@"u"] = @1; if (uy + thick > lowest) lowest = uy + thick; }
        }
        [tokens addObject:t];
    }
    // 不同的词拿到一模一样的框，说明这几个位置都是 Vision 瞎给的：这几个词当作量不出来
    for (NSUInteger i = 0; i < boxes.count; i++) for (NSUInteger j = i + 1; j < boxes.count; j++) {
        if (NSEqualRects(boxes[i].rectValue, boxes[j].rectValue)) { tokens[i][@"n"] = @0; tokens[j][@"n"] = @0; }
    }
    *eraseBottom = lowest;
    return tokens;
}

/// `ocr-macos --windows <自己的pid>`：屏幕上可见的窗口（含浮动面板），从前到后，全局坐标（点）。
/// 只要位置，不要标题，所以不需要额外权限。
static int listWindows(pid_t selfPid) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *win in (__bridge NSArray *)list) {
        // 普通窗口是 0 层，浮动面板在它上面；Dock、菜单栏及以上不是装内容的窗口
        int layer = [win[(id)kCGWindowLayer] intValue];
        if (layer < 0 || layer >= kCGDockWindowLevel) continue;
        if ([win[(id)kCGWindowOwnerPID] intValue] == selfPid) continue;
        if ([win[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
        CGRect r;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)win[(id)kCGWindowBounds], &r)) continue;
        if (r.size.width < 40 || r.size.height < 40) continue;
        [out addObject:@{ @"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height) }];
    }
    if (list) CFRelease(list);
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
}

/// 两个框之间（同一行）的空白有多宽：取中间那一截行，找最长的一段"上下同色"的列。
static long longestBlankRun(const uint8_t *gray, size_t W, size_t H, long x0, long x1, long y0, long y1) {
    x0 = MAX(0, x0); x1 = MIN((long)W, x1); y0 = MAX(0, y0); y1 = MIN((long)H, y1);
    long bh = y1 - y0, my0 = y0 + bh / 4, my1 = y1 - bh / 4;
    long best = 0, run = 0;
    for (long cx = x0; cx < x1; cx++) {
        int lo = 255, hi = 0;
        for (long cy = my0; cy < my1; cy++) { int v = gray[cy * W + cx]; if (v < lo) lo = v; if (v > hi) hi = v; }
        run = (hi - lo) < 24 ? run + 1 : 0;
        if (run > best) best = run;
    }
    return best;
}

static NSArray<NSString *> *kLanguages;

/// 在一张图的某个区域（归一化坐标，原点左下）里认字。每次都新建 request 和 handler，可以并发调用。
/// code=YES 时是代码、命令、JSON：关掉语言纠错（不然 is_tor 会被"纠正"成单词）、只按英文认。
static NSArray *recognize(CGImageRef img, CGRect roi, BOOL code, NSArray<NSString *> *langs, NSError **error) {
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    if (@available(macOS 13, *)) {
        request.revision = VNRecognizeTextRequestRevision3;
        request.automaticallyDetectsLanguage = !code;
    }
    request.recognitionLanguages = code ? @[@"en-US"] : (langs ?: kLanguages);
    request.usesLanguageCorrection = !code;
    request.minimumTextHeight = 0.0;
    request.regionOfInterest = roi;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:img options:@{}];
    [handler performRequests:@[request] error:error];
    return request.results ?: @[];
}

/// 原图里的一块（像素，左上角为原点）按 k 倍放大成一张新图
static CGImageRef scaledCrop(CGImageRef src, CGRect crop, double k) {
    CGImageRef part = CGImageCreateWithImageInRect(src, crop);
    if (!part) return NULL;
    size_t w = (size_t)lround(crop.size.width * k), h = (size_t)lround(crop.size.height * k);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, srgb, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(srgb);
    if (!ctx) { CGImageRelease(part); return NULL; }
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), part);
    CGImageRef out = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    CGImageRelease(part);
    return out;
}

/// 一条识别结果：Vision 的候选文字 + 它在原图上的位置 + 坐标换算要用的几个数（见 tokenColors）
@interface Hit : NSObject
@property (strong) VNRecognizedText *cand;
@property CGRect box;      // 请求图里的归一化坐标（已换算出 roi）
@property CGRect roi;
@property double ox, oy, fw, fh;
@property CGRect px;       // 原图像素，左上角为原点
@end
@implementation Hit
@end

static NSArray<Hit *> *hitsFrom(NSArray *obsList, CGRect roi, double ox, double oy, double fw, double fh) {
    NSMutableArray *out = [NSMutableArray array];
    for (VNRecognizedTextObservation *obs in obsList) {
        VNRecognizedText *cand = [[obs topCandidates:1] firstObject];
        if (!cand || cand.confidence < 0.2) continue;
        CGRect b = obs.boundingBox;
        Hit *h = [Hit new];
        h.cand = cand; h.roi = roi; h.ox = ox; h.oy = oy; h.fw = fw; h.fh = fh;
        h.box = CGRectMake(roi.origin.x + b.origin.x * roi.size.width, roi.origin.y + b.origin.y * roi.size.height,
                           b.size.width * roi.size.width, b.size.height * roi.size.height);
        h.px = CGRectMake(ox + h.box.origin.x * fw, oy + (1.0 - h.box.origin.y - h.box.size.height) * fh,
                          h.box.size.width * fw, h.box.size.height * fh);
        [out addObject:h];
    }
    return out;
}

static double medianOf(NSMutableArray<NSNumber *> *xs) {
    if (!xs.count) return 0;
    [xs sortUsingSelector:@selector(compare:)];
    return xs[xs.count / 2].doubleValue;
}

/// 看起来像代码、命令、JSON 的一行
static BOOL looksLikeCode(NSString *s) {
    static NSRegularExpression *re;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        re = [NSRegularExpression regularExpressionWithPattern:
              @"^\\s*([\"'“”][\\w .$-]+[\"'“”]\\s*:|[A-Za-z_][\\w.]*\\s*:\\s*[\\[{]|[{}\\[\\]]\\s*,?\\s*$|[$%>❯]\\s|(git|npm|npx|curl|brew|pip3?|python3?|cd|sudo|docker)\\s)"
                                                    options:0 error:nil];
    });
    return [re numberOfMatchesInString:s options:0 range:NSMakeRange(0, s.length)] > 0;
}

/// 这一片里的字全都已经是目标语言（中文界面上的一片中文），或者根本没有字母
static BOOL skipAsTarget(NSArray<Hit *> *members, NSString *target) {
    // 目标语言自己的文字；外文 = 其余的字母（拉丁、假名、谚文）。中文目标下日文的假名算外文
    NSString *own = [target hasPrefix:@"zh"] ? @"[\\u4e00-\\u9fff]"
        : [target hasPrefix:@"ja"] ? @"[\\u3040-\\u30ff\\u4e00-\\u9fff]"
        : [target hasPrefix:@"ko"] ? @"[\\uac00-\\ud7af]" : nil;
    NSString *foreign = [target hasPrefix:@"zh"] ? @"[A-Za-z\\u3040-\\u30ff\\uac00-\\ud7af]"
        : [target hasPrefix:@"ja"] ? @"[A-Za-z\\uac00-\\ud7af]"
        : [target hasPrefix:@"ko"] ? @"[A-Za-z\\u3040-\\u30ff\\u4e00-\\u9fff]" : nil;
    if (!own) return NO;
    NSRegularExpression *ownRe = [NSRegularExpression regularExpressionWithPattern:own options:0 error:nil];
    NSRegularExpression *forRe = [NSRegularExpression regularExpressionWithPattern:foreign options:0 error:nil];
    for (Hit *h in members) {
        NSString *t = h.cand.string;
        NSUInteger o = [ownRe numberOfMatchesInString:t options:0 range:NSMakeRange(0, t.length)];
        NSUInteger f = [forRe numberOfMatchesInString:t options:0 range:NSMakeRange(0, t.length)];
        if (f >= 2 && o * 10 < (o + f) * 4) return NO;  // 有一块以外文为主，要重认
        // 中文目标下，带假名、谚文的就是日文、韩文，不管汉字占多少
        if ([target hasPrefix:@"zh"]) {
            NSRegularExpression *kanaRe = [NSRegularExpression regularExpressionWithPattern:@"[\\u3040-\\u30ff\\uac00-\\ud7af]" options:0 error:nil];
            if ([kanaRe numberOfMatchesInString:t options:0 range:NSMakeRange(0, t.length)] >= 2) return NO;
        }
    }
    return YES;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) { fprintf(stderr, "Usage: ocr-macos <image-path>\n"); return 1; }
        if (strcmp(argv[1], "--windows") == 0) return listWindows(argc > 2 ? atoi(argv[2]) : 0);
        kLanguages = @[@"zh-Hans", @"zh-Hant", @"ja", @"ko", @"en", @"fr", @"de", @"es", @"pt", @"it"];

        NSString *imagePath = [NSString stringWithUTF8String:argv[1]];
        // 可选的第二个参数：目标语言（zh / ja / ko）。第二遍重认时跳过已经是这种文字的片——反正不翻
        NSString *target = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"";
        NSImage *image = [[NSImage alloc] initWithContentsOfFile:imagePath];
        if (!image) { fprintf(stderr, "Failed to load image\n"); return 1; }
        CGImageRef cgImage = [image CGImageForProposedRect:nil context:nil hints:nil];
        if (!cgImage) { fprintf(stderr, "Failed to get CGImage\n"); return 1; }

        size_t origW = CGImageGetWidth(cgImage);
        size_t origH = CGImageGetHeight(cgImage);
        NSDate *t0 = [NSDate date];
        // 原图的灰度，给 strokeWeight 量笔画用
        uint8_t *gray = calloc(origW * origH, 1);
        CGColorSpaceRef graySpace = CGColorSpaceCreateDeviceGray();
        CGContextRef grayCtx = CGBitmapContextCreate(gray, origW, origH, 8, origW, graySpace, (CGBitmapInfo)kCGImageAlphaNone);
        if (grayCtx) { CGContextDrawImage(grayCtx, CGRectMake(0, 0, origW, origH), cgImage); CGContextRelease(grayCtx); }
        CGColorSpaceRelease(graySpace);
        uint8_t *rgba = loadRGBA(cgImage, origW, origH);

        // ── 第一遍：找字在哪 ─────────────────────────────────────────────
        // 切成几块互相重叠的格子分别认。Vision 会把送进去的图缩到固定尺寸再找字，
        // 整屏一次送进去，小字被缩得太小就漏了；格子越小，字在它眼里越大。
        // 这一遍只管找到字的位置，认准交给第二遍，所以不放大原图（放大一倍要多花一倍时间）。
        // 小图（区域翻译框的一小块）不切、不做第二遍，放大 2 倍认一次就好。
        const BOOL doRefine = origW * origH >= 1500000;
        CGImageRef big = doRefine ? NULL : scaledCrop(cgImage, CGRectMake(0, 0, origW, origH), 2.0);
        CGImageRef pass1Image = big ?: cgImage;
        // 格子大小：一台 14 寸屏（3000×2000 左右）切成 2×2
        const int cols = doRefine ? MAX(1, (int)ceil(origW / 1800.0)) : 1;
        const int rows = doRefine ? MAX(1, (int)ceil(origH / 1100.0)) : 1;
        const CGFloat ovx = cols > 1 ? 0.06 : 0, ovy = rows > 1 ? 0.08 : 0;
        const int tiles = cols * rows;
        NSMutableArray *tileHits = [NSMutableArray array];
        for (int i = 0; i < tiles; i++) [tileHits addObject:@[]];
        __block NSError *fatal = nil;
        dispatch_apply(tiles, DISPATCH_APPLY_AUTO, ^(size_t i) {
            int r = (int)i / cols, c = (int)i % cols;
            CGFloat left = MAX(0, (CGFloat)c / cols - ovx), right = MIN(1, (CGFloat)(c + 1) / cols + ovx);
            CGFloat top = MAX(0, (CGFloat)r / rows - ovy), bottom = MIN(1, (CGFloat)(r + 1) / rows + ovy);
            CGRect roi = CGRectMake(left, 1.0 - bottom, right - left, bottom - top);
            NSError *err = nil;
            NSArray *obs = recognize(pass1Image, roi, NO, nil, &err);
            // 偶尔一整块返回 0 个框（原因不明），换没放大的原图再认一次
            if (!err && obs.count == 0 && pass1Image != cgImage) obs = recognize(cgImage, roi, NO, nil, &err);
            @synchronized (tileHits) {
                if (err) fatal = err;
                tileHits[i] = hitsFrom(obs, roi, 0, 0, origW, origH);
            }
        });
        if (big) CGImageRelease(big);
        if (fatal) {
            free(gray); free(rgba);
            fprintf(stderr, "OCR failed: %s\n", fatal.localizedDescription.UTF8String);
            return 1;
        }
        NSMutableArray<Hit *> *pass1 = [NSMutableArray array];
        for (NSArray *a in tileHits) [pass1 addObjectsFromArray:a];
        double t1 = -[t0 timeIntervalSinceNow];

        // ── 第二遍：按区域放大重认 ───────────────────────────────────────
        // 第一遍找到的字按远近聚成一片一片（一段正文、一个按钮、一排菜单），每片连同一点边距
        // 从原图里裁出来、放大后单独再认一遍——和区域翻译框一小块是同样的效果。
        // 小图（区域翻译）本来就是这个效果，不用再来一遍。
        NSMutableArray<Hit *> *finalHits = [NSMutableArray array];
        int regionCount = 0, refined = 0;
        if (!doRefine) {
            [finalHits addObjectsFromArray:pass1];
        } else {
            NSUInteger n = pass1.count;
            NSMutableArray<NSNumber *> *parent = [NSMutableArray arrayWithCapacity:n];
            for (NSUInteger i = 0; i < n; i++) [parent addObject:@(i)];
            NSUInteger (^find)(NSUInteger) = ^NSUInteger(NSUInteger i) {
                while (parent[i].unsignedIntegerValue != i) i = parent[i].unsignedIntegerValue;
                return i;
            };
            for (NSUInteger i = 0; i < n; i++) {
                CGRect a = pass1[i].px;
                // 挨得近的并成一片一起裁：片数少，第二遍就快（每片都是一次 Vision 调用）
                CGRect da = CGRectInset(a, -a.size.height * 1.5, -a.size.height * 1.2);
                for (NSUInteger j = i + 1; j < n; j++) {
                    CGRect b = pass1[j].px;
                    // 两块字高差太多（标题和正文）也接得上：区域只是裁图的范围，不决定分段
                    if (CGRectIntersectsRect(da, CGRectInset(b, -b.size.height * 0.2, -b.size.height * 0.2))) {
                        NSUInteger ra = find(i), rb = find(j);
                        if (ra != rb) parent[ra] = @(rb);
                    }
                }
            }
            NSMutableDictionary<NSNumber *, NSMutableArray<Hit *> *> *clusters = [NSMutableDictionary dictionary];
            for (NSUInteger i = 0; i < n; i++) {
                NSNumber *k = @(find(i));
                if (!clusters[k]) clusters[k] = [NSMutableArray array];
                [clusters[k] addObject:pass1[i]];
            }
            // 太高的一片（一整栏正文）按行与行之间的空当切成几段，每段不超过约 800 像素高
            NSMutableArray<NSArray<Hit *> *> *regions = [NSMutableArray array];
            for (NSMutableArray<Hit *> *members in clusters.allValues) {
                [members sortUsingComparator:^NSComparisonResult(Hit *a, Hit *b) {
                    return a.px.origin.y < b.px.origin.y ? NSOrderedAscending : a.px.origin.y > b.px.origin.y ? NSOrderedDescending : NSOrderedSame;
                }];
                NSMutableArray *chunk = [NSMutableArray array];
                double chunkTop = 0, chunkBottom = 0;
                for (Hit *h in members) {
                    double top = CGRectGetMinY(h.px), bottom = CGRectGetMaxY(h.px);
                    if (chunk.count && top >= chunkBottom && bottom - chunkTop > 800) {
                        [regions addObject:chunk];
                        chunk = [NSMutableArray array];
                    }
                    if (!chunk.count) { chunkTop = top; chunkBottom = bottom; }
                    chunkBottom = MAX(chunkBottom, bottom);
                    [chunk addObject:h];
                }
                if (chunk.count) [regions addObject:chunk];
            }
            regionCount = (int)regions.count;
            NSMutableArray *regionHits = [NSMutableArray array];
            for (NSUInteger i = 0; i < regions.count; i++) [regionHits addObject:[NSNull null]];
            dispatch_apply(regions.count, DISPATCH_APPLY_AUTO, ^(size_t ri) {
                NSArray<Hit *> *members = regions[ri];
                CGRect core = CGRectNull;
                NSMutableArray<NSNumber *> *hs = [NSMutableArray array];
                NSUInteger codeLines = 0, chars = 0;
                for (Hit *h in members) {
                    core = CGRectUnion(core, h.px);
                    [hs addObject:@(h.px.size.height)];
                    if (looksLikeCode(h.cand.string)) codeLines++;
                    chars += h.cand.string.length;
                }
                double medH = medianOf(hs);
                // 不值得重认的片直接用第一遍的结果：整片都是目标语言的字（不翻）、
                // 整片都没把握（照片、图标里的"字"）。大字也要重认：第一遍在格子重叠处会认出半截乱码
                if (skipAsTarget(members, target)) return;
                BOOL anySure = NO;
                for (Hit *h in members) if (h.cand.confidence >= 0.4) { anySure = YES; break; }
                if (!anySure) return;
                double pad = MAX(8, medH * 0.6);
                CGRect crop = CGRectIntegral(CGRectIntersection(CGRectInset(core, -pad, -pad), CGRectMake(0, 0, origW, origH)));
                // 一片占了大半张图，裁出来也没比整张小多少，就用第一遍的结果
                if (crop.size.width * crop.size.height > origW * origH * 0.6 || crop.size.width < 4 || crop.size.height < 4) return;
                double k = medH < 28 ? 3.0 : 2.0;
                if (crop.size.width * k > 6000) k = MAX(1.0, 6000 / crop.size.width);
                if (crop.size.height * k > 6000) k = MAX(1.0, MIN(k, 6000 / crop.size.height));
                BOOL code = codeLines * 10 >= members.count * 6;
                CGImageRef img = scaledCrop(cgImage, crop, k);
                if (!img) return;
                NSError *err = nil;
                // 第一遍认出假名/谚文的片，按日文/韩文优先再认：语言表里中文排第一，
                // 日文汉字会被认成中文字形（読売→讀煮），断行也乱
                NSUInteger kana = 0, hangul = 0;
                for (Hit *h in members) {
                    NSString *s = h.cand.string;
                    for (NSUInteger ci = 0; ci < s.length; ci++) {
                        unichar c = [s characterAtIndex:ci];
                        if (c >= 0x3040 && c <= 0x30ff) kana++;
                        else if (c >= 0xac00 && c <= 0xd7af) hangul++;
                    }
                }
                NSArray<NSString *> *langs = kana >= 2 ? @[@"ja", @"en"] : hangul >= 2 ? @[@"ko", @"en"] : nil;
                NSArray *obs = recognize(img, CGRectMake(0, 0, 1, 1), code, langs, &err);
                CGImageRelease(img);
                if (err || !obs.count) return;
                // 只要中心落在这一片自己范围里的结果：边距里露出半截的邻居归邻居那一片
                CGRect keep = CGRectInset(core, -medH * 0.3, -medH * 0.3);
                NSMutableArray<Hit *> *kept = [NSMutableArray array];
                NSUInteger keptChars = 0;
                for (Hit *h in hitsFrom(obs, CGRectMake(0, 0, 1, 1), crop.origin.x, crop.origin.y, crop.size.width, crop.size.height)) {
                    if (!CGRectContainsPoint(keep, CGPointMake(CGRectGetMidX(h.px), CGRectGetMidY(h.px)))) continue;
                    [kept addObject:h];
                    keptChars += h.cand.string.length;
                }
                // 重认的结果明显比第一遍少，多半是裁得不对，不采用。第一遍在格子重叠处会把同一行认两次，
                // 字数本来就偏多，所以门槛放在三分之一
                if (keptChars * 3 < chars) return;
                @synchronized (regionHits) { regionHits[ri] = kept; }
            });
            for (NSUInteger i = 0; i < regions.count; i++) {
                if (regionHits[i] != [NSNull null]) { [finalHits addObjectsFromArray:regionHits[i]]; refined++; }
                else [finalHits addObjectsFromArray:regions[i]];
            }
        }
        double t2 = -[t0 timeIntervalSinceNow];
        fprintf(stderr, "格子 %dx%d 第一遍 %lu 块 %.2fs；区域 %d 片，重认 %d 片，%lu 块 %.2fs\n",
                cols, rows, (unsigned long)pass1.count, t1, regionCount, refined, (unsigned long)finalHits.count, t2 - t1);

        NSMutableArray *results = [NSMutableArray array];
        for (Hit *hit in finalHits) {
            double x = hit.px.origin.x, y = hit.px.origin.y, w = hit.px.size.width, h = hit.px.size.height;
            RGB bg = edgeColor(rgba, origW, origH, lround(x), lround(y), lround(x + w), lround(y + h));
            long eraseBottom = -1;
            NSArray *tokens = tokenColors(hit.cand, hit.box, hit.roi, hit.ox, hit.oy, hit.fw, hit.fh, rgba, origW, origH, bg, &eraseBottom);
            NSMutableDictionary *item = [@{
                @"text": hit.cand.string,
                @"confidence": @(hit.cand.confidence),
                @"x": @(round(x)), @"y": @(round(y)),
                @"width": @(round(w)), @"height": @(round(h)),
                @"weight": @(strokeWeight(gray, origW, origH, x, y, w, h)),
                @"bg": @[@(bg.r), @(bg.g), @(bg.b)],
                @"tokens": tokens
            } mutableCopy];
            // 下划线在框下面时，擦原文要擦到下划线为止，不然译文下面留着一条旧线
            if (eraseBottom > y + h) item[@"eraseBottom"] = @(eraseBottom);
            [results addObject:item];
        }

        // 同一行上相邻的两个框之间如果是一大段空白（超过一个字高），就标记右边那个：
        // 这是两样东西（并排的按钮、表格的两格），不是漏认了中间的词——漏认的地方是有字的。
        // 后面聚行时的"空当不超过 4 倍字高就接上"不会跨过这个标记。
        for (NSUInteger i = 0; i < results.count; i++) {
            NSMutableDictionary *b = results[i];
            double bx = [b[@"x"] doubleValue], by = [b[@"y"] doubleValue], bh = [b[@"height"] doubleValue];
            double bestRight = -1;
            for (NSDictionary *a in results) {
                double ax = [a[@"x"] doubleValue], ay = [a[@"y"] doubleValue], ah = [a[@"height"] doubleValue];
                double ar = ax + [a[@"width"] doubleValue];
                if (ar > bx || ar <= bestRight) continue;
                double ov = MIN(ay + ah, by + bh) - MAX(ay, by);
                if (ov < MIN(ah, bh) * 0.5) continue;
                bestRight = ar;
            }
            if (bestRight >= 0 && bx - bestRight > bh
                && longestBlankRun(gray, origW, origH, (long)bestRight, (long)bx, (long)by, (long)(by + bh)) > bh) {
                b[@"gapBefore"] = @YES;
            }
        }
        free(gray);
        free(rgba);

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding].UTF8String);
        return 0;
    }
}
