/**
 * 服务器编辑器的开合状态
 * ------------------------------------------------------------------
 * 打开入口只有一个来源（顶栏的连接组、连接失败时的兜底），但「谁来渲染」
 * 是 AppShell 里那个单例 —— 所以开合状态必须放在组件外部。
 *
 * 用一个独立的小 store 而不是塞进 appStore：它纯粹是界面态，
 * 与「主进程真相 + 业务快照」是两回事，混在一起会让 appStore 越来越像杂物间。
 */

import { create } from 'zustand';

interface ServerEditorState {
  open: boolean;
  /** null = 新建 */
  editingId: string | null;
  openEditor(id: string | null): void;
  close(): void;
}

export const useServerEditor = create<ServerEditorState>((set) => ({
  open: false,
  editingId: null,
  openEditor: (editingId) => set({ open: true, editingId }),
  close: () => set({ open: false, editingId: null }),
}));

export function openServerEditor(id: string | null): void {
  useServerEditor.getState().openEditor(id);
}
