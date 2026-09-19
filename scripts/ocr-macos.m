#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>

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

        // Enhance contrast for low-contrast text (terminals, dim UIs)
        CIImage *ciInput = [CIImage imageWithCGImage:scaledImage];
        CIFilter *contrast = [CIFilter filterWithName:@"CIColorControls"];
        [contrast setValue:ciInput forKey:kCIInputImageKey];
        [contrast setValue:@(1.3) forKey:@"inputContrast"]; // 1.0 = no change
        [contrast setValue:@(0.0) forKey:@"inputBrightness"];
        [contrast setValue:@(0.0) forKey:@"inputSaturation"]; // grayscale helps OCR
        CIImage *contrastOut = [contrast outputImage];

        // Sharpen — significantly improves small text recognition
        CIFilter *sharpen = [CIFilter filterWithName:@"CIUnsharpMask"];
        [sharpen setValue:contrastOut forKey:kCIInputImageKey];
        [sharpen setValue:@(2.5) forKey:@"inputRadius"];
        [sharpen setValue:@(0.6) forKey:@"inputIntensity"];
        CIImage *enhanced = [sharpen outputImage];
        if (!enhanced) enhanced = contrastOut;

        CIContext *ciCtx = [CIContext contextWithOptions:nil];
        CGImageRef ocrImage = [ciCtx createCGImage:enhanced fromRect:enhanced.extent];
        if (!ocrImage) ocrImage = scaledImage;
        if (scaledImage != cgImage && scaledImage != ocrImage) CGImageRelease(scaledImage);

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

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:ocrImage options:@{}];
        NSMutableArray *results = [NSMutableArray array];
        for (int i = 0; i < stripes; i++) {
            // Vision 的归一化坐标原点在左下；第 0 片是屏幕最上面那一条
            CGFloat top = MAX(0, i * band - pad);
            CGFloat bottom = MIN(1, (i + 1) * band + pad);
            CGRect roi = CGRectMake(0, 1.0 - bottom, 1, bottom - top);

            NSArray *obsList = nil;
            // 同一片认出 0 个框时再认一次：盲测里见过某一片整条空手而回、其余两片正常。
            // 真的是空白区域的话，第二次也很快。
            for (int attempt = 0; attempt < 2 && obsList.count == 0; attempt++) {
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

                NSError *error = nil;
                [handler performRequests:@[request] error:&error];
                if (error) {
                    if (ocrImage != cgImage) CGImageRelease(ocrImage);
                    fprintf(stderr, "OCR failed: %s\n", error.localizedDescription.UTF8String);
                    return 1;
                }
                obsList = request.results;
                fprintf(stderr, "stripe %d/%d try %d: %lu\n", i + 1, stripes, attempt + 1, (unsigned long)obsList.count);
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

                [results addObject:@{
                    @"text": candidate.string,
                    @"confidence": @(candidate.confidence),
                    @"x": @(round(x)), @"y": @(round(y)),
                    @"width": @(round(w)), @"height": @(round(h)),
                    @"weight": @(strokeWeight(gray, origW, origH, x, y, w, h))
                }];
            }
        }

        if (ocrImage != cgImage) CGImageRelease(ocrImage);

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding].UTF8String);
        return 0;
    }
}
