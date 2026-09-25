/// 贴图、小窗、框选窗口里的按键，一律按设置里的快捷键匹配。
///
/// 设置里存的是 'alt+escape'、'shift+cmd+c' 这种串。修饰键必须完全一致：
/// 设了 ⌥⎋，单按 ⎋、按 ⌘⌥⎋ 都不算。这里只认"修饰键 + 一个键"，
/// 和弦（两个普通键一起按）只有全局热键那边支持。
(function () {
  const CODE_TO_NAME = {
    KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f', KeyG: 'g', KeyH: 'h',
    KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n', KeyO: 'o', KeyP: 'p',
    KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't', KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x',
    KeyY: 'y', KeyZ: 'z',
    Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
    F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
    F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
    Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'delete',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']',
    Quote: '\'',
  };
  const MODS = ['ctrl', 'alt', 'shift', 'cmd'];

  function parse(str) {
    const parts = String(str || '').toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
    return { mods: parts.filter(p => MODS.includes(p)), keys: parts.filter(p => !MODS.includes(p)) };
  }

  function keyOf(e) {
    return CODE_TO_NAME[e.code] || '';
  }

  window.ttyKeys = {
    /// 当前设置（每次都从主进程读，设置页改完立刻生效）
    get() {
      try { return (window.ttyConfig && window.ttyConfig.keys()) || {}; } catch { return {}; }
    },
    /// 这次按下的是不是设置里的那个快捷键
    match(e, str) {
      const hk = parse(str);
      if (hk.keys.length !== 1) return false;
      if (e.ctrlKey !== hk.mods.includes('ctrl')) return false;
      if (e.altKey !== hk.mods.includes('alt')) return false;
      if (e.shiftKey !== hk.mods.includes('shift')) return false;
      if (e.metaKey !== hk.mods.includes('cmd')) return false;
      return keyOf(e) === hk.keys[0];
    },
    /// 按 macOS 习惯显示：'alt+escape' → ⌥⎋
    pretty(str) {
      const SYM = { ctrl: '\u2303', alt: '\u2325', shift: '\u21e7', cmd: '\u2318' };
      const KEY = { escape: '\u238b', enter: '\u21a9', tab: '\u21e5', delete: '\u232b', space: '\u2423' };
      const hk = parse(str);
      return ['ctrl', 'alt', 'shift', 'cmd'].filter(m => hk.mods.includes(m)).map(m => SYM[m]).join('')
        + hk.keys.map(k => KEY[k] || k.toUpperCase()).join(' ');
    },
    /// 松开的是不是那个快捷键里的普通键（修饰键可能先松开，所以不看修饰键）
    isKeyOf(e, str) {
      const hk = parse(str);
      return hk.keys.length === 1 && keyOf(e) === hk.keys[0];
    },
  };
})();
