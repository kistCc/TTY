#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSMutableArray *results;
static NSSet *textRoles;

void collectText(AXUIElementRef element, int depth) {
    if (depth > 50) return; // Chrome AX trees can be very deep

    CFTypeRef roleRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &roleRef);
    if (!roleRef) return;

    NSString *role = (__bridge NSString *)roleRef;
    BOOL isTextRole = [textRoles containsObject:role];

    if (isTextRole) {
        NSString *text = nil;

        // Try value first (static text, text fields)
        CFTypeRef valueRef = NULL;
        AXUIElementCopyAttributeValue(element, kAXValueAttribute, &valueRef);
        if (valueRef && CFGetTypeID(valueRef) == CFStringGetTypeID()) {
            text = (__bridge NSString *)valueRef;
            CFRelease(valueRef);
        }

        // Fallback: title (buttons, menu items)
        if (!text || text.length == 0) {
            CFTypeRef titleRef = NULL;
            AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &titleRef);
            if (titleRef && CFGetTypeID(titleRef) == CFStringGetTypeID()) {
                text = (__bridge NSString *)titleRef;
                CFRelease(titleRef);
            }
        }

        // Fallback: description (some elements use this)
        if (!text || text.length == 0) {
            CFTypeRef descRef = NULL;
            AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute, &descRef);
            if (descRef && CFGetTypeID(descRef) == CFStringGetTypeID()) {
                text = (__bridge NSString *)descRef;
                CFRelease(descRef);
            }
        }

        if (text && text.length > 1) {
            CFTypeRef posRef = NULL, sizeRef = NULL;
            AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &posRef);
            AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeRef);

            if (posRef && sizeRef) {
                CGPoint pos; CGSize size;
                AXValueGetValue(posRef, kAXValueCGPointType, &pos);
                AXValueGetValue(sizeRef, kAXValueCGSizeType, &size);

                if (size.width > 8 && size.height > 8 &&
                    size.width < 800 && size.height < 200 &&
                    pos.x >= 0 && pos.y >= 0) {
                    [results addObject:@{
                        @"text": text,
                        @"x": @(pos.x), @"y": @(pos.y),
                        @"width": @(size.width), @"height": @(size.height),
                        @"role": role, @"confidence": @(1.0)
                    }];
                }
            }
            if (posRef) CFRelease(posRef);
            if (sizeRef) CFRelease(sizeRef);
        }
    }

    CFRelease(roleRef);

    // Recurse into children
    CFTypeRef childrenRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenRef);
    if (childrenRef) {
        NSArray *children = (__bridge NSArray *)childrenRef;
        for (id child in children) {
            collectText((__bridge AXUIElementRef)child, depth + 1);
        }
        CFRelease(childrenRef);
    }
}


/// --selection 模式：取当前选中的文本。
///
/// 划词翻译要的是"用户此刻选中了什么"，而不是剪贴板里躺着什么。AXSelectedText
/// 在原生输入框、文本区上直接可读；浏览器和 Electron 应用把它挂在焦点元素下面
/// 一两层，所以焦点元素本身为空时再往下找几层。
static NSString *copySelectedTextFrom(AXUIElementRef element, int depth) {
    if (!element || depth > 3) return nil;

    CFTypeRef selRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selRef);
    if (selRef) {
        if (CFGetTypeID(selRef) == CFStringGetTypeID()) {
            NSString *sel = (__bridge_transfer NSString *)selRef;
            if (sel.length > 0) return sel;
        } else {
            CFRelease(selRef);
        }
    }

    CFTypeRef childrenRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenRef);
    if (childrenRef) {
        NSArray *children = (__bridge_transfer NSArray *)childrenRef;
        // 选区通常在靠前的子元素里，扫太多只会拖慢按键到出窗的这段时间
        NSUInteger limit = MIN(children.count, (NSUInteger)12);
        for (NSUInteger i = 0; i < limit; i++) {
            NSString *found = copySelectedTextFrom((__bridge AXUIElementRef)children[i], depth + 1);
            if (found) return found;
        }
    }
    return nil;
}

static NSString *copyFocusedSelection(AXUIElementRef root) {
    if (!root) return nil;
    AXUIElementRef focused = NULL;
    AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
    if (!focused) return nil;
    NSString *sel = copySelectedTextFrom(focused, 0);
    CFRelease(focused);
    return sel;
}

static int printSelection(void) {
    // 调用方靠这一行分辨「没选中」和「没权限」：辅助功能权限是按可执行文件授的，
    // 这个子进程没签名，系统不认，于是哪怕 TTY 本身已经打过勾，这里仍然是 0。
    fprintf(stderr, "trusted=%d\n", AXIsProcessTrusted() ? 1 : 0);

    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    NSString *sel = copyFocusedSelection(systemWide);
    if (systemWide) CFRelease(systemWide);

    // 系统级焦点查询在部分应用上拿不到东西，再按最前面那个应用问一次
    if (sel.length == 0) {
        NSRunningApplication *frontApp = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (frontApp) {
            AXUIElementRef app = AXUIElementCreateApplication(frontApp.processIdentifier);
            sel = copyFocusedSelection(app);
            if (app) CFRelease(app);
        }
    }

    if (sel.length > 0) {
        printf("%s", sel.UTF8String);
        return 0;
    }
    return 1; // 没有选区：调用方回落到剪贴板
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc >= 2 && strcmp(argv[1], "--selection") == 0) {
            return printSelection();
        }

        // 剪贴板的变更计数。判断「⌘C 有没有真的复制到东西」只能看它：
        // 比较内容会在"选中的词恰好和剪贴板里已有内容相同"时判断失败，
        // 而 changeCount 每写入一次就加一，哪怕写进去的是一模一样的字。
        // 读它不需要任何权限。
        if (argc >= 2 && strcmp(argv[1], "--pbcount") == 0) {
            printf("%ld", (long)[NSPasteboard generalPasteboard].changeCount);
            return 0;
        }

        // --pbwait <旧计数> <超时毫秒>：等剪贴板被写入**有效内容**，然后立刻返回。
        //
        // 两个讲究：
        //   轮询放在这里而不是 Electron 那边——那边每查一次要 fork 一个进程，
        //   几十毫秒一次的节奏光启动开销就把整个取词拖垮了。
        //   光看 changeCount 变了不够：有些应用先 clearContents 再写入，
        //   中间那一下计数已经加了但内容还是空的，读早了就拿到空字符串。
        if (argc >= 4 && strcmp(argv[1], "--pbwait") == 0) {
            long beforeCount = atol(argv[2]);
            long timeoutMs = atol(argv[3]);
            NSPasteboard *pb = [NSPasteboard generalPasteboard];
            for (long waited = 0; waited < timeoutMs; waited += 5) {
                if ((long)pb.changeCount != beforeCount) {
                    NSString *content = [pb stringForType:NSPasteboardTypeString];
                    if (content.length > 0) {
                        printf("%ld", (long)pb.changeCount);
                        return 0;
                    }
                    // 计数变了但还没有文本：可能正在写，也可能是对空选区执行了复制
                    // 把剪贴板清空了。继续等，超时后由调用方按"内容为空"处理。
                }
                usleep(5 * 1000);
            }
            // 没等到有效内容。把当前计数报回去，调用方靠它判断剪贴板是不是被动过
            // （被动过就必须恢复备份，否则用户原来的内容就被这次取词清掉了）。
            printf("%ld", (long)pb.changeCount);
            return 1;
        }

        textRoles = [NSSet setWithArray:@[
            (NSString *)kAXStaticTextRole,
            (NSString *)kAXTextFieldRole,
            (NSString *)kAXTextAreaRole,
            (NSString *)kAXButtonRole,
            (NSString *)kAXMenuItemRole,
            (NSString *)kAXMenuButtonRole,
            @"AXLink", @"AXHeading", @"AXCell",
            @"AXMenuItem", @"AXTab",
        ]];

        pid_t targetPid = 0;
        if (argc >= 2) {
            targetPid = atoi(argv[1]); // PID passed from Electron
        }
        if (targetPid == 0) {
            NSRunningApplication *frontApp = NSWorkspace.sharedWorkspace.frontmostApplication;
            if (!frontApp) { printf("[]\n"); return 0; }
            targetPid = frontApp.processIdentifier;
        }
        fprintf(stderr, "[ax] Target PID: %d\n", targetPid);

        AXUIElementRef app = AXUIElementCreateApplication(targetPid);
        results = [NSMutableArray array];

        // Set a timeout to prevent hanging on complex AX trees
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0), ^{
            collectText(app, 0);
            dispatch_semaphore_signal(sem);
        });
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));

        CFRelease(app);

        NSData *json = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
        return 0;
    }
}
