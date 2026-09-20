#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>

/// 笔画粗细：框里墨迹面积 × 2 ÷ 墨迹边界像素数，约等于平均笔画宽度，跟是哪些字母无关；
/// 再除以框高，得到跟字号无关的"字重"。粗体大约是常规体的 1.5 倍。
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
    return (2.0 * area / edge) / (y1 - y0);
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

/// 按词间空白把一个识别结果拆成几段（返回字符范围）。空白超过两倍字高才拆。
/// 框的坐标是归一化的，横竖各按各自的边长归一，比较前先乘回像素（pxW / pxH）。
static NSArray<NSValue *> *splitAtWideGaps(VNRecognizedText *t, CGRect whole, CGFloat pxW, CGFloat pxH) {
    NSString *str = t.string;
    NSMutableArray<NSValue *> *words = [NSMutableArray array];
    [str enumerateSubstringsInRange:NSMakeRange(0, str.length)
                            options:NSStringEnumerationByWords
                         usingBlock:^(NSString *w, NSRange r, NSRange er, BOOL *stop) {
        [words addObject:[NSValue valueWithRange:r]];
    }];
    if (words.count < 2) return @[[NSValue valueWithRange:NSMakeRange(0, str.length)]];

    NSMutableArray<NSValue *> *out = [NSMutableArray array];
    NSUInteger segStart = 0;
    CGFloat prevRight = -1;
    for (NSValue *v in words) {
        NSRange r = v.rangeValue;
        VNRectangleObservation *rb = [t boundingBoxForRange:r error:nil];
        if (!rb) return @[[NSValue valueWithRange:NSMakeRange(0, str.length)]];
        CGRect wb = rb.boundingBox;
        if (prevRight >= 0 && (wb.origin.x - prevRight) * pxW > whole.size.height * pxH * 2) {
            NSUInteger end = r.location;
            while (end > segStart && [[NSCharacterSet whitespaceCharacterSet] characterIsMember:[str characterAtIndex:end - 1]]) end--;
            [out addObject:[NSValue valueWithRange:NSMakeRange(segStart, end - segStart)]];
            segStart = r.location;
        }
        prevRight = wb.origin.x + wb.size.width;
    }
    [out addObject:[NSValue valueWithRange:NSMakeRange(segStart, str.length - segStart)]];
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

                // Vision 会把同一水平线上挨得不远的几样东西认成一个框（两个并排按钮
                // "Later Next"、表格同一行的两格）。正常词距约是字高的三分之一，
                // 词与词之间空出两倍字高以上，就不是同一句话，从那里拆开。
                for (NSValue *seg in splitAtWideGaps(candidate, obs.boundingBox, imgW * roi.size.width, imgH * roi.size.height)) {
                    NSRange r = seg.rangeValue;
                    CGRect b = obs.boundingBox;
                    if (r.length < candidate.string.length) {
                        VNRectangleObservation *rb = [candidate boundingBoxForRange:r error:nil];
                        if (rb) b = rb.boundingBox;
                    }
                    // boundingBox 是相对 regionOfInterest 的，换回整图的归一化坐标
                    CGRect box = CGRectMake(roi.origin.x + b.origin.x * roi.size.width,
                                            roi.origin.y + b.origin.y * roi.size.height,
                                            b.size.width * roi.size.width,
                                            b.size.height * roi.size.height);
                    double x = box.origin.x * imgW / scale;
                    double y = (1.0 - box.origin.y - box.size.height) * imgH / scale;
                    double w = box.size.width * imgW / scale;
                    double h = box.size.height * imgH / scale;

                    [results addObject:@{
                        @"text": [candidate.string substringWithRange:r],
                        @"confidence": @(candidate.confidence),
                        @"x": @(round(x)), @"y": @(round(y)),
                        @"width": @(round(w)), @"height": @(round(h)),
                        @"weight": @(strokeWeight(gray, origW, origH, x, y, w, h))
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
