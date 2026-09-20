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

/// 按像素把一个识别结果在"宽空白"处拆开（两个并排按钮 "Later Next"、表格同一行的两格）。
/// 空白 = 框内上下一样颜色的一列（蓝底、按钮里的白底都算）；连续空白超过一个字高才拆，
/// 正常词距只有字高的三分之一左右，一个字高已经是三个空格那么宽。文字在哪个空格处断，按字符位置比例找最近的空格。
/// Vision 的 boundingBoxForRange 在这里靠不住（常常直接返回整行的框），所以不用它。
/// 返回 @[{range, x0, x1}]，x 是原图像素；不需要拆时返回 nil。
static NSArray<NSDictionary *> *splitAtBlankColumns(NSString *str, const uint8_t *gray, size_t W, size_t H,
                                                    double x, double y, double w, double h) {
    long x0 = MAX(0, (long)x), x1 = MIN((long)W, (long)(x + w));
    long y0 = MAX(0, (long)y), y1 = MIN((long)H, (long)(y + h));
    long bh = y1 - y0;
    if (bh < 4 || x1 - x0 < bh * 3) return nil;
    if ([str rangeOfCharacterFromSet:[NSCharacterSet whitespaceCharacterSet]].location == NSNotFound) return nil;

    // 每一列是不是"空白"。只看中间那一截行：字母都在那里，框的上下边缘常常蹭到
    // 旁边的底色（按钮的白底比文字框矮一点，边上就是蓝的），会让空白列看起来不纯。
    long n = x1 - x0;
    long my0 = y0 + bh / 4, my1 = y1 - bh / 4;
    BOOL *blank = calloc(n, sizeof(BOOL));
    for (long cx = x0; cx < x1; cx++) {
        int lo = 255, hi = 0;
        for (long cy = my0; cy < my1; cy++) { int v = gray[cy * W + cx]; if (v < lo) lo = v; if (v > hi) hi = v; }
        blank[cx - x0] = (hi - lo) < 24;
    }
    // 找内部的宽空白，得到若干段有字的区间
    NSMutableArray<NSArray *> *spans = [NSMutableArray array];   // @[start, end]，列号
    long segStart = -1, runStart = -1;
    for (long i = 0; i <= n; i++) {
        BOOL b = (i == n) || blank[i];
        if (!b) { if (segStart < 0) segStart = i; if (runStart >= 0) runStart = -1; continue; }
        if (runStart < 0) runStart = i;
        BOOL wide = (i == n) || (i - runStart + 1 > bh && i + 1 < n && !blank[i + 1]);
        if (segStart >= 0 && wide) {
            [spans addObject:@[@(segStart), @(runStart)]];
            segStart = -1;
        }
    }
    free(blank);
    if (spans.count < 2) return nil;

    // 词（按空白切）和它们在字符串里的比例位置
    NSMutableArray<NSValue *> *tokens = [NSMutableArray array];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"\\S+" options:0 error:nil];
    for (NSTextCheckingResult *m in [re matchesInString:str options:0 range:NSMakeRange(0, str.length)]) [tokens addObject:[NSValue valueWithRange:m.range]];
    if (tokens.count < spans.count) return nil;

    double total = str.length;
    double first = [spans.firstObject[0] doubleValue], last = [spans.lastObject[1] doubleValue];
    NSMutableArray<NSMutableArray *> *assign = [NSMutableArray array];
    for (NSUInteger k = 0; k < spans.count; k++) [assign addObject:[NSMutableArray array]];
    for (NSValue *tv in tokens) {
        NSRange r = tv.rangeValue;
        double pos = first + (last - first) * (r.location + r.length / 2.0) / total;   // 估计的像素列
        NSUInteger best = 0; double bestD = INFINITY;
        for (NSUInteger k = 0; k < spans.count; k++) {
            double s0 = [spans[k][0] doubleValue], s1 = [spans[k][1] doubleValue];
            double d = pos < s0 ? s0 - pos : (pos > s1 ? pos - s1 : 0);
            if (d < bestD) { bestD = d; best = k; }
        }
        [assign[best] addObject:tv];
    }
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    for (NSUInteger k = 0; k < spans.count; k++) {
        if (![assign[k] count]) return nil;   // 某段分不到词，说明比例估得不对，不拆
        NSRange a0 = [assign[k].firstObject rangeValue], a1 = [assign[k].lastObject rangeValue];
        [out addObject:@{ @"range": [NSValue valueWithRange:NSMakeRange(a0.location, NSMaxRange(a1) - a0.location)],
                          @"x0": @(x0 + [spans[k][0] longValue]), @"x1": @(x0 + [spans[k][1] longValue]) }];
    }
    return out;
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

                NSArray<NSDictionary *> *parts = splitAtBlankColumns(candidate.string, gray, origW, origH, x, y, w, h);
                if (!parts) parts = @[@{ @"range": [NSValue valueWithRange:NSMakeRange(0, candidate.string.length)], @"x0": @(x), @"x1": @(x + w) }];
                for (NSDictionary *part in parts) {
                    double px0 = [part[@"x0"] doubleValue], pw = [part[@"x1"] doubleValue] - px0;
                    [results addObject:@{
                        @"text": [candidate.string substringWithRange:[part[@"range"] rangeValue]],
                        @"confidence": @(candidate.confidence),
                        @"x": @(round(px0)), @"y": @(round(y)),
                        @"width": @(round(pw)), @"height": @(round(h)),
                        @"weight": @(strokeWeight(gray, origW, origH, px0, y, pw, h))
                    }];
                }
            }
        }

        if (ocrImage != cgImage) CGImageRelease(ocrImage);

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding].UTF8String);
        return 0;
    }
}
