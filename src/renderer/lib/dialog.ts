/**
 * 弹层（Promise 化）
 * ------------------------------------------------------------------
 * `prompt / confirm / choose / pickTopic` 在命令式视图里是「await 一个 Promise，
 * 用户点了哪颗按钮就 resolve 成什么」。这个语义很好用，所以保留 ——
 * 只是把渲染换成 React（`components/Dialog.tsx`），状态放在这个小 store 里。
 *
 * 为什么不是「每个调用点自己 useState 控制一个弹层」：模板重命名、删除确认、
 * 导出格式选择、主题挑选分散在四个视图里，各写一遍就要各管一遍 Esc / 焦点 /
 * 遮罩点击。这里只有一处实现，调用点仍然是一行 await。
 */

import { create } from 'zustand';

export interface ChoiceOption {
  value: string;
  label: string;
  desc?: string;
}

export type DialogRequest =
  | { kind: 'prompt'; title: string; message?: string; defaultValue: string }
  | { kind: 'confirm'; title: string; message?: string; danger?: boolean }
  | { kind: 'choose'; title: string; message?: string; options: ChoiceOption[] }
  | { kind: 'pick-topic'; title: string; message?: string; topics: string[] };

type DialogResult = string | boolean | null;

interface DialogState {
  /** 当前请求；null 表示没有弹层 */
  request: DialogRequest | null;
  /** resolve 函数跟着请求一起走，关闭时只认这一次调用的 */
  settle: ((value: DialogResult) => void) | null;
  open(request: DialogRequest, settle: (value: DialogResult) => void): void;
  close(value: DialogResult): void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  request: null,
  settle: null,
  open: (request, settle) => set({ request, settle }),
  close: (value) => {
    const { settle } = get();
    set({ request: null, settle: null });
    settle?.(value);
  },
}));

/** 同一时刻只允许一个弹层，后来的排队等前一个关掉（实际使用中不会撞上） */
function ask<T extends DialogResult>(request: DialogRequest): Promise<T> {
  const { request: current } = useDialogStore.getState();
  if (current) {
    // 前一个还没关：直接拒绝，避免两个请求共用一个 resolve 造成串台
    return Promise.resolve(null as T);
  }
  return new Promise<T>((resolve) => {
    useDialogStore.getState().open(request, (value) => resolve(value as T));
  });
}

export function prompt(title: string, defaultValue = '', message = ''): Promise<string | null> {
  return ask<string | null>({ kind: 'prompt', title, message, defaultValue });
}

export function confirm(title: string, message?: string, danger = false): Promise<boolean> {
  return ask<boolean>({ kind: 'confirm', title, message, danger }).then((v) => v === true);
}

export function choose(title: string, message: string, options: ChoiceOption[]): Promise<string | null> {
  return ask<string | null>({ kind: 'choose', title, message, options });
}

/** 从「已扫描到的主题」里挑一个，带搜索 */
export function pickTopic(topics: string[], message?: string): Promise<string | null> {
  return ask<string | null>({
    kind: 'pick-topic',
    title: '选择主题',
    message,
    topics,
  });
}

/**
 * 视图侧统一从 `dialog.xxx()` 调用（对象属性访问），
 * 这样测试可以整体替换掉弹层，不必真的去点按钮。
 */
export const dialog = { prompt, confirm, choose, pickTopic };
