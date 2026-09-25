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
static NSArray *tokenColors(VNRecognizedText *candidate, CGRect obsBox, CGRect roi, double imgW, double imgH, double scale,
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
        long x = lround(box.origin.x * imgW / scale), w = lround(box.size.width * imgW / scale);
        long y = lround((1.0 - box.origin.y - box.size.height) * imgH / scale), h = lround(box.size.height * imgH / scale);
        [boxes addObject:[NSValue valueWithRect:NSMakeRect(x, y, w, h)]];
        long n = 0;
        // 词框左右各收 1 像素，别把隔壁词的笔画算进来
        RGB tbg = edgeColor(rgba, W, H, x, y, x + w, y + h);
        RGB ink = inkColor(rgba, W, H, x + 1, y, x + w - 1, y + h, bg, &n);
        // 这个词底下的底色跟整块的不一样（徽章、按钮拼在一起的块），量出来的颜色没意义
        if (rgbDist(tbg, bg) > 60) n = 0;
        NSMutableDictionary *t = [@{ @"s": @(range.location), @"e": @(range.location + range.length),
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

/// 在图的某个区域（归一化坐标，原点左下）里认字。每次都新建 handler。
static NSArray *recognize(CGImageRef img, CGRect roi, NSError **error) {
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    if (@available(macOS 13, *)) {
        request.revision = VNRecognizeTextRequestRevision3;
        request.automaticallyDetectsLanguage = YES;
    }
    request.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"ja", @"ko",
                                      @"en", @"fr", @"de", @"es", @"pt", @"it"];
    request.usesLanguageCorrection = YES;
    request.minimumTextHeight = 0.0;
    request.regionOfInterest = roi;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:img options:@{}];
    [handler performRequests:@[request] error:error];
    return request.results ?: @[];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) { fprintf(stderr, "Usage: ocr-macos <image-path>\n"); return 1; }
        if (strcmp(argv[1], "--windows") == 0) return listWindows(argc > 2 ? atoi(argv[2]) : 0);

        NSString *imagePath = [NSString stringWithUTF8String:argv[1]];
        NSImage *image = [[NSImage alloc] initWithContentsOfFile:imagePath];
        if (!image) { fprintf(stderr, "Failed to load image\n"); return 1; }

        CGImageRef cgImage = [image CGImageForProposedRect:nil context:nil hints:nil];
        if (!cgImage) { fprintf(stderr, "Failed to get CGImage\n"); return 1; }

        size_t origW = CGImageGetWidth(cgImage);
        size_t origH = CGImageGetHeight(cgImage);
        // 原图的灰度，给 strokeWeight 量笔画用（不用增强过的那张：锐化会把笔画描粗）
        uint8_t *gray = calloc(origW * origH, 1);
        CGColorSpaceRef graySpace = CGColorSpaceCreateDeviceGray();
        CGContextRef grayCtx = CGBitmapContextCreate(gray, origW, origH, 8, origW, graySpace, (CGBitmapInfo)kCGImageAlphaNone);
        if (grayCtx) { CGContextDrawImage(grayCtx, CGRectMake(0, 0, origW, origH), cgImage); CGContextRelease(grayCtx); }
        CGColorSpaceRelease(graySpace);
        uint8_t *rgba = loadRGBA(cgImage, origW, origH);

        // 2x upscale for better small text detection
        CGFloat scale = 2.0;
        size_t newW = (size_t)(origW * scale);
        size_t newH = (size_t)(origH * scale);
        CGColorSpaceRef cs = CGImageGetColorSpace(cgImage);
        CGContextRef ctx = CGBitmapContextCreate(NULL, newW, newH, 8, 0, cs,
            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);

        CGImageRef scaledImage = cgImage;
        if (ctx) {
            CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
            CGContextDrawImage(ctx, CGRectMake(0, 0, newW, newH), cgImage);
            CGImageRef scaled = CGBitmapContextCreateImage(ctx);
            CGContextRelease(ctx);
            if (scaled) scaledImage = scaled; else scale = 1.0;
        } else { scale = 1.0; }

        // 以前这里还有"对比度 1.3 + 去色 + 锐化"一步（给暗色终端用的）。实测深色背景的页面上，
        // 这一步会让 Vision 在某一整片区域里一个字都认不出（每次都一样，不是偶发），
        // 浅色背景上又几乎没有收益（字数差 0.5%），所以删掉，只保留放大。
        CGImageRef ocrImage = scaledImage;

        CGFloat imgW = CGImageGetWidth(ocrImage);
        CGFloat imgH = CGImageGetHeight(ocrImage);

        // 高屏按横条分片识别：Vision 会把整张图缩到固定输入尺寸再找字，图越高，
        // 每行字被缩得越小，密排长页面会整片漏字。横着切只切在行与行之间，
        // 不会把一行撕成两半；片间留一点重叠，骑缝的行两片都能认到，调用方按内容去重。
        // 用 regionOfInterest 而不是先裁成小图：Vision 自己按像素裁，不经过别的图像库，
        // 也不用落临时文件。
        const int stripes = origH >= 1200 ? 3 : 1;
        const CGFloat overlap = 0.06;
        CGFloat band = 1.0 / stripes;
        CGFloat pad = stripes > 1 ? band * overlap : 0;

        NSMutableArray *results = [NSMutableArray array];
        for (int i = 0; i < stripes; i++) {
            // Vision 的归一化坐标原点在左下；第 0 片是屏幕最上面那一条
            CGFloat top = MAX(0, i * band - pad);
            CGFloat bottom = MIN(1, (i + 1) * band + pad);
            CGRect roi = CGRectMake(0, 1.0 - bottom, 1, bottom - top);

            NSError *error = nil;
            NSArray *obsList = recognize(ocrImage, roi, &error);
            // 偶尔会有一整片返回 0 个框（只在 App 里见过，单独跑复现不出来，原因不明）。
            // 同一张图原样重认没用，换成没放大的原图、新 handler 再认一次；
            // 真是空白区域的话这次也很快。
            if (!error && obsList.count == 0 && ocrImage != cgImage) {
                obsList = recognize(cgImage, roi, &error);
                fprintf(stderr, "stripe %d/%d: 0, 原图重认 %lu\n", i + 1, stripes, (unsigned long)obsList.count);
            } else {
                fprintf(stderr, "stripe %d/%d: %lu\n", i + 1, stripes, (unsigned long)obsList.count);
            }
            if (error) {
                free(gray); free(rgba);
                if (ocrImage != cgImage) CGImageRelease(ocrImage);
                fprintf(stderr, "OCR failed: %s\n", error.localizedDescription.UTF8String);
                return 1;
            }

            for (VNRecognizedTextObservation *obs in obsList) {
                VNRecognizedText *candidate = [[obs topCandidates:1] firstObject];
                if (!candidate || candidate.confidence < 0.2) continue;

                // boundingBox 是相对 regionOfInterest 的，换回整图的归一化坐标
                CGRect b = obs.boundingBox;
                CGRect box = CGRectMake(roi.origin.x + b.origin.x * roi.size.width,
                                        roi.origin.y + b.origin.y * roi.size.height,
                                        b.size.width * roi.size.width,
                                        b.size.height * roi.size.height);
                double x = box.origin.x * imgW / scale;
                double y = (1.0 - box.origin.y - box.size.height) * imgH / scale;
                double w = box.size.width * imgW / scale;
                double h = box.size.height * imgH / scale;

                RGB bg = edgeColor(rgba, origW, origH, lround(x), lround(y), lround(x + w), lround(y + h));
                long eraseBottom = -1;
                NSArray *tokens = tokenColors(candidate, box, roi, imgW, imgH, scale, rgba, origW, origH, bg, &eraseBottom);
                NSMutableDictionary *item = [@{
                    @"text": candidate.string,
                    @"confidence": @(candidate.confidence),
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
        if (ocrImage != cgImage) CGImageRelease(ocrImage);

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding].UTF8String);
        return 0;
    }
}
