/**
 * 连接配置的导入 / 导出
 * ------------------------------------------------------------------
 * 触发点有两个：应用菜单（主进程 `app:menu` 事件）和将来的设置页。
 * 单独成模块是为了让 `ipc/events.ts` 能直接用，不必绕回 `app.ts`（那会形成循环）。
 *
 * 导入之后只写 store：顶部服务器下拉、发布页模板列表都从 store 派生，
 * 不需要再喊某个视图「去刷新一下」。
 */

import { api } from '../ipc/client';
import { errMsg, toast } from './util';
import { act } from '../store/appStore';

export async function exportConfig(): Promise<void> {
  try {
    const data = await api.exportConfig();
    const res = await api.saveText({
      title: '导出连接配置',
      defaultName: `xmqtt-config-${Date.now()}.json`,
      content: JSON.stringify(data, null, 2),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.saved) toast('success', '已导出', `${data.servers.length} 个服务器配置`);
  } catch (err) {
    toast('error', '导出失败', errMsg(err));
  }
}

export async function importConfig(): Promise<void> {
  try {
    const read = await api.readText();
    if (!read.imported) return;
    const result = await api.importConfig(read.content ?? '');
    act().setServers(result.servers);
    act().setTemplates(result.templates);
    toast('success', '导入完成', `新增 ${result.added} 个服务器配置`);
  } catch (err) {
    toast('error', '导入失败', errMsg(err));
  }
}
