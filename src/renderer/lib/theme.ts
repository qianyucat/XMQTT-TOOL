/**
 * 主题切换
 * ------------------------------------------------------------------
 * 只做三件事：给 `<html>` 打 `data-theme`、写回 store、持久化到主进程。
 *
 * 单独成模块是为了让 React 外壳（TitleBar）能用它，又不必为了一个函数
 * 去 import 整个 `app.ts`（那样会顺着把全部视图拖进外壳的依赖图）。
 */

import type { ThemeMode } from '@shared/models';
import { api } from '../ipc/client';
import { act } from '../store/appStore';

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  act().mergeSettings({ theme });
  // 持久化失败不影响当前观感，静默即可 —— 下次启动退回默认主题，不是错误路径
  api.patchSettings({ theme }).catch(() => {});
}

/** 在深色 / 浅色之间翻转 */
export function toggleTheme(): void {
  applyTheme(act().settings.theme === 'dark' ? 'light' : 'dark');
}
