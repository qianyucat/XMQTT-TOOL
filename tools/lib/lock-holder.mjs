/**
 * 查出「谁占着这个文件的句柄」（仅 Windows，走 Restart Manager）。
 *
 * 为什么需要：打包时 win-unpacked/resources/app.asar 删不掉，
 * 通常不是应用自己 —— 索引服务、编辑器、同步盘这类宿主进程会一直攥着句柄，
 * 任务管理器里也看不出关联。RmGetList 是系统给出的「谁持有」权威答案，
 * 比逐个猜进程名靠得住。
 *
 * 非 Windows 或查询失败时返回 []，调用方按「原因未知」处理即可，别抛错。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PS_QUERY = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LockQuery {
  [StructLayout(LayoutKind.Sequential)] struct RmUniqueProcess {
    public int pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME start;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RmProcessInfo {
    public RmUniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string appName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string serviceName;
    public int appType;
    public uint status;
    public uint tsSession;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RmUniqueProcess[] apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RmProcessInfo[] apps, ref uint reasons);

  public static string[] Who(string[] files) {
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return new string[0];
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return new string[0];
      uint needed = 0, count = 0, reasons = 0;
      // 第一次只为拿 needed（返回 ERROR_MORE_DATA = 234）
      if (RmGetList(h, out needed, ref count, null, ref reasons) != 234 || needed == 0) return new string[0];
      var infos = new RmProcessInfo[needed];
      count = needed;
      if (RmGetList(h, out needed, ref count, infos, ref reasons) != 0) return new string[0];
      var names = new List<string>();
      for (int i = 0; i < count; i++) {
        int pid = infos[i].Process.pid;
        string name = infos[i].appName;
        try { name = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
        names.Add(name + " (pid " + pid + ")");
      }
      return names.ToArray();
    } finally { RmEndSession(h); }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[LockQuery]::Who($env:XM_LOCK_FILES.Split('|')) | Sort-Object -Unique
`;

/**
 * @param {string[]} files 要查的路径（绝对路径；目录会被跳过）
 * @returns {string[]} 形如 `WorkBuddy (pid 23380)`；查不到返回 []
 */
export function whoLocks(files) {
  // 只登记普通文件：混进目录会让 RmRegisterResources 整体失败（返回空结果，
  // 看起来像「谁都占了」的假阴性 —— 实测 3 条路径里带 2 个目录就查不出来）。
  const list = [...new Set(files.filter((p) => p && isFile(p)))];
  if (process.platform !== 'win32' || list.length === 0) return [];
  const encoded = Buffer.from(PS_QUERY, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, XM_LOCK_FILES: list.join('|') },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('Add-Type') && !s.startsWith('WARNING'));
}

/** 把 [] 渲染成人话：查不到时不要假装知道原因。 */
export function describeHolders(holders) {
  return holders.length ? holders.join('、') : '未查到（可能是索引 / 杀软等内核级持有）';
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
