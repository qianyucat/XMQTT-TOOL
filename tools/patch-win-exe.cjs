#!/usr/bin/env node
/**
 * 给 Windows 版 exe 写图标与版本信息 —— 纯 JS 改 PE 资源，不依赖 wine / rcedit。
 *
 * 用途：在 macOS / Linux 上交叉打 Windows 包时，electron-builder 的
 * 图标与版本信息这一环走的是 rcedit.exe（Windows 程序，非 Windows 平台需要 wine）。
 * 本脚本用 resedit 直接改 PE 资源，等价于 rcedit 的那部分工作。
 *
 * 用法：
 *   node tools/patch-win-exe.cjs                       # 默认 release/win-unpacked/<productName>.exe + build/icon.png
 *   node tools/patch-win-exe.cjs <exe> [png] [outExe]
 *
 * 依赖（不进 package.json，避免 Windows 离线机装配时多出无关包）：
 *   npm i --no-save resedit png-to-ico
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');

function loadDep(name, hint) {
  const roots = [ROOT, process.cwd(), process.env.PE_TOOLS_DIR].filter(Boolean);
  for (const r of roots) {
    try {
      return createRequire(path.join(r, 'noop.js'))(name);
    } catch {
      /* try next */
    }
  }
  try {
    return require(name);
  } catch {
    console.error(`[patch-win-exe] 缺少依赖 ${name}：先执行  ${hint}`);
    process.exit(1);
  }
}

const ResEdit = loadDep('resedit', 'npm i --no-save resedit png-to-ico');
const pngToIcoMod = loadDep('png-to-ico', 'npm i --no-save resedit png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};
const productName = build.productName || pkg.productName || pkg.name;

const exePath = path.resolve(process.argv[2] || path.join(ROOT, 'release', 'win-unpacked', `${productName}.exe`));
const pngPath = path.resolve(process.argv[3] || path.join(ROOT, build.win?.icon || 'build/icon.png'));
const outPath = path.resolve(process.argv[4] || exePath);

if (!fs.existsSync(exePath)) {
  console.error(`[patch-win-exe] 找不到 exe：${exePath}`);
  process.exit(1);
}

/** z → z.0.0.0（PE 版本号固定四段） */
function quad(v) {
  const parts = String(v || '1.0.0').split(/[.-]/).slice(0, 4);
  while (parts.length < 4) parts.push('0');
  return parts.map((p) => parseInt(p, 10) || 0);
}

const ver = quad(pkg.version);
const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '';
const META = {
  CompanyName: author,
  FileDescription: productName,
  FileVersion: ver.join('.'),
  InternalName: productName,
  LegalCopyright: build.copyright || author,
  OriginalFilename: `${productName}.exe`,
  ProductName: productName,
  ProductVersion: ver.join('.'),
};

const VI = ResEdit.Resource.VersionInfo;
const IG = ResEdit.Resource.IconGroupEntry;

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const before = res.entries.length;

// ---- 版本信息：英文块 1033 + 中文块 2052 都写全，避免中文 Windows 属性页读到空描述 ----
const viList = VI.fromEntries(res.entries);
for (const vi of viList) {
  vi.setStringValues({ lang: 1033, codepage: 1200 }, META);
  vi.setStringValues({ lang: 2052, codepage: 1200 }, META);
  for (const [lang] of [[1033], [2052]]) {
    vi.setFileVersion(...ver, lang, 1200);
    vi.setProductVersion(...ver, lang, 1200);
  }
  vi.outputToResourceEntries(res.entries);
}

// ---- 图标 ----
const icoBuf = fs.existsSync(pngPath) && pngPath.endsWith('.ico')
  ? fs.readFileSync(pngPath)
  : null;

(async () => {
  const ico = ResEdit.Data.IconFile.from(icoBuf || (await pngToIco(pngPath)));
  const groups = IG.fromEntries(res.entries);
  if (groups.length === 0) {
    IG.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
  } else {
    // 全部图标组都换成同一套，避免资源管理器仍取到旧的 Electron 图标
    for (const g of groups) {
      IG.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map((i) => i.data));
    }
  }

  res.outputResource(exe);
  fs.writeFileSync(outPath, Buffer.from(exe.generate()));
  fs.chmodSync(outPath, 0o644);

  const sizes = ico.icons.map((i) => `${i.width || 256}x${i.height || 256}`).join(' ');
  console.log(`[patch-win-exe] ${path.relative(ROOT, outPath)}`);
  console.log(`  版本      ${META.ProductName} ${META.FileVersion}（1033 + 2052）`);
  console.log(`  图标      ${sizes}  组=${groups.map((g) => `${g.id}/${g.lang}`).join(',') || '1/1033(新建)'}`);
  console.log(`  资源条目  ${before} → ${res.entries.length}`);
  console.log(`  体积      ${fs.statSync(outPath).size} bytes`);
})().catch((e) => {
  console.error('[patch-win-exe] 失败：', e?.message || e);
  process.exit(1);
});
