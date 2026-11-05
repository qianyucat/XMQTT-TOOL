#!/usr/bin/env node
/**
 * Windows 打包统一入口（跨平台）。
 *
 *   Windows   → electron-builder 原生出包（rcedit 直接可跑）
 *   macOS/Linux → 绕开 wine 的三段式：
 *                 ① --dir 出 win-unpacked（跳过 rcedit）
 *                 ② tools/patch-win-exe.cjs 用 resedit 改图标 + 版本信息
 *                 ③ --prepackaged 复用上面的目录，打 zip 与 nsis
 *
 * 为什么不直接 electron-builder --win：
 *   electron-builder 改 exe 图标/版本要跑 winCodeSign 里的 rcedit.exe，
 *   在非 Windows 平台会先自动下载 wine（github，实测 16 KB/s，17 分钟都下不完）。
 *   --signAndEditExecutable=false 可跳过这一步，代价是 exe 保留 Electron 默认图标，
 *   所以由 ② 用纯 JS 把图标与版本信息补回去。
 *
 * 依赖：resedit + png-to-ico（仅供 ② 使用）
 *   npm i --no-save resedit png-to-ico
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeHolders, whoLocks } from './lib/lock-holder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;
const isWindows = process.platform === 'win32';

function run(step, cmd, args) {
  console.log(`\n▸ ${step}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`\n✗ ${step} 失败（exit ${r.status ?? r.signal}）`);
    process.exit(r.status ?? 1);
  }
}

const node = process.execPath;
const eb = path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

/**
 * 显式指定输出目录：npm run dist:win -- --out release-build
 * ------------------------------------------------------------------
 * 自动兜底只能猜三个名字。真撞上「三个目录的旧 app.asar 同时被占」
 * （杀软 / 索引服务持有句柄，重启才放），猜名字就无路可走了，
 * 这时由人指一个干净目录最省事。
 */
const outFlag = (() => {
  const i = process.argv.indexOf('--out');
  const v = i > 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('-') ? v : null;
})();

/** 清空目录，返回删不掉的路径（空数组 = 清干净）。 */
function wipe(dir) {
  const stuck = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      stuck.push(d);
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        try {
          fs.rmdirSync(p);
        } catch {
          stuck.push(p);
        }
      } else {
        try {
          fs.unlinkSync(p);
        } catch {
          stuck.push(p);
        }
      }
    }
  };
  walk(dir);
  try {
    fs.rmdirSync(dir);
  } catch {
    stuck.push(dir);
  }
  return stuck;
}

/**
 * 选输出目录：优先 release/，被占用时依次退到 release-win/、release-tmp/、
 * release-b2/ … release-b10/，全被占才报错。
 * ------------------------------------------------------------------
 * electron-builder 打包前会清空 <output>/win-unpacked。撞上删不掉的旧文件时，
 * 它只甩一段 Go stack trace（EnsureEmptyDir → app-builder.exe failed），
 * 看不出是哪个文件、被谁占着，而且已经白等了整个 asar/NSIS 前的流程。
 * 那个句柄通常不是应用自己：索引 / 编辑器 / 同步盘这类宿主进程会一直攥着
 * app.asar，删不掉也改名不动（连父目录都 rename 失败），此时唯一出路是换个
 * 没用过的输出目录 —— 再由人手动挑一个实在没有道理，所以这里自动往下找。
 * 占用者由 Restart Manager 查（tools/lib/lock-holder.mjs），查不到时如实说查不到。
 */
function pickOutputDir() {
  const auto = Array.from({ length: 9 }, (_, i) => `release-b${i + 2}`);
  const names = outFlag ? [outFlag] : ['release', 'release-win', 'release-tmp', ...auto];
  const blocked = [];

  for (const name of names) {
    const unpacked = path.join(ROOT, name, 'win-unpacked');
    if (fs.existsSync(unpacked)) {
      const stuck = wipe(unpacked);
      if (stuck.length) {
        blocked.push({ name, stuck });
        if (outFlag) break;
        console.warn(`\n! ${name}/ 清不掉（剩 ${stuck.length} 项删不动），换下一个输出目录`);
        continue;
      }
    }
    return useOutputDir(name, blocked);
  }

  console.error(`\n✗ ${blocked.map((b) => `${b.name}/`).join('、')} 都清不掉，无法打包。`);
  for (const b of blocked) {
    const first = path.relative(ROOT, b.stuck[0]);
    console.error(`  ${b.name}/ 首例剩 ${first} —— 占用者：${describeHolders(whoLocks(b.stuck.slice(0, 8)))}`);
  }
  console.error('  这些句柄常来自索引 / 编辑器 / 同步盘（不是 XMQTT 自己），关掉它或重启可释放；');
  console.error('  也可以直接指一个没用过的目录出包：');
  console.error('    npm run dist:win -- --out release-b2');
  process.exit(1);
}

function useOutputDir(name, blocked) {
  if (blocked.length) {
    console.warn(`\n! 本次产物输出到 ${name}/ —— ${blocked.map((b) => `${b.name}/`).join('、')} 被外部句柄占着，默认路径不可用。`);
    for (const b of blocked) {
      const first = path.relative(ROOT, b.stuck[0]);
      console.warn(`  ${first} —— 占用者：${describeHolders(whoLocks(b.stuck.slice(0, 8)))}`);
    }
    console.warn('  残留不影响本次打包，占用进程退出后整目录删掉即可恢复。');
  }
  return { name, args: name === 'release' ? [] : [`-c.directories.output=${name}`] };
}

// 1. 渲染层 + 主进程产物（跟 npm run build 等价）
run('编译主进程', node, [path.join('tools', 'build-main.mjs')]);
run('编译渲染层', node, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build']);

// 图标：build/ 不入库，跟 dist:mac 一样在打包前现生成，否则 electron-builder
// 会静默退回 Electron 默认图标（不报错，只是成品图标不对）。
run('生成图标', node, [path.join('tools', 'make-icon.mjs')]);

// 清场放在编译之后：编译要几十秒，先做这一步才能尽早发现目录被占
const out = pickOutputDir();
const outDir = path.join(ROOT, out.name);
const unpacked = path.join(outDir, 'win-unpacked');

if (isWindows) {
  // Windows 上 rcedit 可直接运行，走原生流程
  run('electron-builder --win --x64', node, [eb, '--win', '--x64', ...out.args]);
} else {
  const noEdit = ['-c.win.signAndEditExecutable=false'];

  run('打包 win-unpacked（跳过 rcedit / wine）', node, [eb, '--win', '--x64', '--dir', ...noEdit, ...out.args]);
  run('写入图标与版本信息', node, [
    path.join('tools', 'patch-win-exe.cjs'),
    path.join(unpacked, `${productName}.exe`),
  ]);

  run('生成 zip', node, [eb, '--win', 'zip', '--x64', '--prepackaged', unpacked, ...noEdit]);
  run('生成 NSIS 安装包', node, [eb, '--win', 'nsis', '--x64', '--prepackaged', unpacked, ...noEdit]);
}

console.log('\n产物：');
for (const f of fs.readdirSync(outDir)) {
  if (!/\.(exe|zip)$/i.test(f) || !/win|Setup/i.test(f)) continue;
  const size = fs.statSync(path.join(outDir, f)).size;
  console.log(`  ${out.name}/${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`  解包目录 ${out.name}/win-unpacked（可免安装直接运行 ${productName}.exe）`);
