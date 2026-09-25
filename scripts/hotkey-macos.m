#import <Foundation/Foundation.h>
#import <Carbon/Carbon.h>
#import <AppKit/AppKit.h>

typedef struct {
    CGEventFlags modifier;
    CGKeyCode key1;
    CGKeyCode key2;
    BOOL dualKey;
} HotkeyDef;

static HotkeyDef triggerHK, dismissHK, cacheHK, regionHK;
static BOOL tKey1Down = NO, tKey2Down = NO;
static BOOL rKey1Down = NO, rKey2Down = NO;
// Two states: translating (loading%) and overlay (result shown)
static BOOL translatingMode = NO;
static BOOL overlayMode = NO;
static CFAbsoluteTime lastActionTime = 0;
static const CFTimeInterval COOLDOWN = 1.0;
// Watchdog for translatingMode.
// This process flips translatingMode = YES the moment it emits TRIGGERED, but only the
// Electron side knows whether a translation actually happened. If Electron drops the
// trigger (debounced, no text found, provider error), expire the state instead of
// leaving it YES forever and reading every later press as CANCEL.
static CFAbsoluteTime translatingSince = 0;
static const CFTimeInterval TRANSLATING_TIMEOUT = 30.0;

/// "alt,cmd" 这种逗号分隔的修饰键列表，合成一个掩码
static CGEventFlags parseModifier(NSString *mods) {
    CGEventFlags out = 0;
    for (NSString *mod in [mods componentsSeparatedByString:@","]) {
        if ([mod isEqualToString:@"shift"]) out |= kCGEventFlagMaskShift;
        if ([mod isEqualToString:@"cmd"])   out |= kCGEventFlagMaskCommand;
        if ([mod isEqualToString:@"alt"])   out |= kCGEventFlagMaskAlternate;
        if ([mod isEqualToString:@"ctrl"])  out |= kCGEventFlagMaskControl;
    }
    return out;
}

static const CGEventFlags ALL_MODS = kCGEventFlagMaskShift | kCGEventFlagMaskCommand
                                   | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl;

/// 修饰键必须和设置的完全一致：设了 ⌥⎋，单按 ⎋、按 ⌘⌥⎋ 都不算
static inline BOOL modsMatch(CGEventFlags flags, HotkeyDef hk) {
    return (flags & ALL_MODS) == hk.modifier;
}

static HotkeyDef parseHotkey(NSString *str) {
    HotkeyDef hk = {0, 0, 0, NO};
    NSArray *parts = [str componentsSeparatedByString:@":"];
    if (parts.count == 1) {
        hk.key1 = (CGKeyCode)[parts[0] intValue];
    } else if (parts.count == 2) {
        hk.modifier = parseModifier(parts[0]);
        hk.key1 = (CGKeyCode)[parts[1] intValue];
    } else if (parts.count >= 3) {
        hk.modifier = parseModifier(parts[0]);
        hk.key1 = (CGKeyCode)[parts[1] intValue];
        hk.key2 = (CGKeyCode)[parts[2] intValue];
        hk.dualKey = YES;
    }
    return hk;
}

CGEventRef eventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        CGEventTapEnable(*(CFMachPortRef *)refcon, true);
        return event;
    }

    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();

    if (translatingMode && (now - translatingSince) > TRANSLATING_TIMEOUT) {
        fprintf(stderr, "translatingMode watchdog expired after %.0fs, resetting\n", TRANSLATING_TIMEOUT);
        translatingMode = NO;
    }

    if (type != kCGEventKeyDown && type != kCGEventKeyUp) return event;

    CGKeyCode keycode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);

    if (type == kCGEventKeyDown) {
        if (keycode == triggerHK.key1) tKey1Down = YES;
        if (triggerHK.dualKey && keycode == triggerHK.key2) tKey2Down = YES;
        if (keycode == regionHK.key1) rKey1Down = YES;
        if (regionHK.dualKey && keycode == regionHK.key2) rKey2Down = YES;

        BOOL modOK = modsMatch(flags, triggerHK);
        BOOL triggered = triggerHK.dualKey ? (modOK && tKey1Down && tKey2Down) : (modOK && keycode == triggerHK.key1);

        BOOL regionModOK = modsMatch(flags, regionHK);
        BOOL regionTriggered = regionHK.dualKey ? (regionModOK && rKey1Down && rKey2Down) : (regionModOK && keycode == regionHK.key1);

        if (regionTriggered && !translatingMode && !overlayMode) {
            rKey1Down = NO; rKey2Down = NO;
            tKey1Down = NO; tKey2Down = NO;
            if (now - lastActionTime < COOLDOWN) return event;
            printf("REGION\n"); fflush(stdout);
            lastActionTime = now;
            return event;
        }

        // 全屏翻译键只在空闲时开始翻译；浮层开着、正在翻译时都不响应——关闭、取消只认关闭键
        if (triggered) {
            tKey1Down = NO; tKey2Down = NO;
            if (overlayMode || translatingMode) return event;
            if (now - lastActionTime < COOLDOWN) return event;
            printf("TRIGGERED\n"); fflush(stdout);
            translatingMode = YES;
            translatingSince = now;
            lastActionTime = now;
            return event;
        }

        // 正在翻译时按关闭键 = 取消
        if (translatingMode && !overlayMode && modsMatch(flags, dismissHK) && keycode == dismissHK.key1) {
            printf("CANCEL\n"); fflush(stdout);
            translatingMode = NO; lastActionTime = now;
            tKey1Down = NO; tKey2Down = NO;
            return event;
        }

        if (overlayMode) {
            // Save cache
            if (modsMatch(flags, cacheHK) && keycode == cacheHK.key1) {
                printf("SAVE_CACHE\n"); fflush(stdout);
                // Keep overlayMode = YES — overlay stays visible after caching
                lastActionTime = now;
                tKey1Down = NO; tKey2Down = NO;
                return event;
            }

            // Dismiss overlay (configurable key)
            if (modsMatch(flags, dismissHK) && keycode == dismissHK.key1) {
                printf("DISMISS\n"); fflush(stdout);
                overlayMode = NO; lastActionTime = now;
                tKey1Down = NO; tKey2Down = NO;
            }
        }
    } else if (type == kCGEventKeyUp) {
        if (keycode == triggerHK.key1) tKey1Down = NO;
        if (triggerHK.dualKey && keycode == triggerHK.key2) tKey2Down = NO;
        if (keycode == regionHK.key1) rKey1Down = NO;
        if (regionHK.dualKey && keycode == regionHK.key2) rKey2Down = NO;
    }

    return event;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        triggerHK = (HotkeyDef){kCGEventFlagMaskShift, 6, 7, YES};
        dismissHK = (HotkeyDef){0, 53, 0, NO};
        cacheHK   = (HotkeyDef){kCGEventFlagMaskShift, 1, 0, NO};
        regionHK  = (HotkeyDef){kCGEventFlagMaskShift, 6, 8, YES}; // Shift+Z+C

        for (int i = 1; i < argc; i++) {
            NSString *arg = [NSString stringWithUTF8String:argv[i]];
            if ([arg isEqualToString:@"-t"] && i + 1 < argc)
                triggerHK = parseHotkey([NSString stringWithUTF8String:argv[++i]]);
            else if ([arg isEqualToString:@"-d"] && i + 1 < argc)
                dismissHK = parseHotkey([NSString stringWithUTF8String:argv[++i]]);
            else if ([arg isEqualToString:@"-c"] && i + 1 < argc)
                cacheHK = parseHotkey([NSString stringWithUTF8String:argv[++i]]);
            else if ([arg isEqualToString:@"-r"] && i + 1 < argc)
                regionHK = parseHotkey([NSString stringWithUTF8String:argv[++i]]);
        }

        fprintf(stderr, "Hotkeys: trigger k1=%d k2=%d, dismiss k=%d, cache k=%d, region k1=%d k2=%d\n",
                triggerHK.key1, triggerHK.key2, dismissHK.key1, cacheHK.key1,
                regionHK.key1, regionHK.key2);

        // Also need OVERLAY_SHOWN from stdin to switch translatingMode → overlayMode
        // Use a simpler approach: main process sends "SHOWN" when overlay is displayed
        // For now, use a timeout — after TRIGGERED, switch to overlayMode after receiving no CANCEL

        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);

        CFMachPortRef tap = CGEventTapCreate(
            kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
            mask, eventCallback, &tap);

        if (!tap) {
            // A keyboard event tap needs Input Monitoring permission (System Settings ->
            // Privacy & Security -> Input Monitoring). Report it on stdout so Electron can
            // tell the user, instead of exiting silently and being relaunched forever.
            fprintf(stderr, "Failed to create event tap - missing Input Monitoring permission.\n");
            printf("NO_PERMISSION\n"); fflush(stdout);
            return 1;
        }

        CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);

        // Read stdin for state sync from Electron
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            char buf[64];
            while (fgets(buf, sizeof(buf), stdin)) {
                NSString *cmd = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if ([cmd isEqualToString:@"SHOWN"]) {
                    translatingMode = NO;
                    overlayMode = YES;
                } else if ([cmd isEqualToString:@"HIDDEN"]) {
                    translatingMode = NO;
                    overlayMode = NO;
                } else if ([cmd isEqualToString:@"TRANSLATING"]) {
                    // Electron is the source of truth: a translation really is running.
                    overlayMode = NO;
                    translatingMode = YES;
                    translatingSince = CFAbsoluteTimeGetCurrent();
                }
            }
        });

        CFRunLoopRun();
        CFRelease(source); CFRelease(tap);
    }
    return 0;
}
