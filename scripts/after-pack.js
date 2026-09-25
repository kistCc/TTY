// electron-builder 的 afterPack 钩子：设置了 TTY_SIGN_ID 就用这张证书给 app 签名。
//
// 为什么要固定签名：macOS 的「辅助功能」「屏幕录制」权限是按程序签名记的。
// 不签名（ad-hoc）时签名就是这一版的指纹，每出一个新版本指纹都变，
// 用户升级后权限会悄悄失效——设置里开关还亮着，实际已经不认了。
// 每一版都用同一张证书签，系统就认得出"还是那个 TTY"，授权一次一直有效。
//
// 没设置 TTY_SIGN_ID（比如别人自己从源码打包）就什么都不做，照旧 ad-hoc。
// 证书本身（含私钥）绝不进仓库，只在发布者本机。

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const id = process.env.TTY_SIGN_ID;
  if (!id) {
    console.log('  • afterPack：没设置 TTY_SIGN_ID，不签名');
    return;
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • afterPack：用证书 ${id} 签名 ${app}`);
  // --deep 连同 Electron 的 Framework 和各个 Helper 一起签；不加 --options runtime，
  // 因为不走公证，开了强化运行时反而要一堆 entitlements
  execFileSync('codesign', ['--force', '--deep', '--timestamp=none', '--sign', id, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  // 打出指定要求（designated requirement），日志里能看到它认的是证书而不是指纹
  execFileSync('codesign', ['-d', '-r-', app], { stdio: 'inherit' });
};
