/**
 * Promise 化弹层（`lib/dialog.ts`）
 * ------------------------------------------------------------------
 * `dialog.prompt()` 必须是「一行 await 拿到结果」，所以 resolve 的时机必须精确：
 * 关闭即结算，取消给 null，确认给值；同时两个请求不能共用一个 resolve（会串台）。
 * 这组用例不需要 DOM —— 弹层的渲染在 `components/Dialog.tsx`，这里只测契约。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialog, useDialogStore } from '../../src/renderer/lib/dialog';

test('prompt：确认时 resolve 用户输入', async () => {
  const pending = dialog.prompt('重命名', '旧名字');
  assert.equal(useDialogStore.getState().request?.kind, 'prompt');

  useDialogStore.getState().close('新名字');
  assert.equal(await pending, '新名字');
  assert.equal(useDialogStore.getState().request, null);
});

test('prompt：取消时 resolve null', async () => {
  const pending = dialog.prompt('重命名', '旧名字');
  useDialogStore.getState().close(null);
  assert.equal(await pending, null);
});

test('confirm：true / false 折成布尔', async () => {
  const ok = dialog.confirm('删除', '确定？', true);
  useDialogStore.getState().close(true);
  assert.equal(await ok, true);

  const no = dialog.confirm('删除');
  useDialogStore.getState().close(null);
  assert.equal(await no, false);
});

test('choose：把选中的 value 原样返回', async () => {
  const pending = dialog.choose('导出', '选格式', [
    { value: 'csv', label: 'CSV' },
    { value: 'json', label: 'JSON' },
  ]);
  assert.equal(useDialogStore.getState().request?.kind, 'choose');
  useDialogStore.getState().close('json');
  assert.equal(await pending, 'json');
});

test('pickTopic：把主题列表带进请求，选中的主题作为结果', async () => {
  const pending = dialog.pickTopic(['a/b', 'c/d'], '选一个');
  const request = useDialogStore.getState().request;
  assert.equal(request?.kind, 'pick-topic');
  assert.deepEqual(request?.kind === 'pick-topic' ? request.topics : [], ['a/b', 'c/d']);

  useDialogStore.getState().close('c/d');
  assert.equal(await pending, 'c/d');
});

test('同一时刻只允许一个弹层：后来的请求直接得到 null', async () => {
  const first = dialog.prompt('第一个');
  const second = dialog.prompt('第二个');

  assert.equal(await second, null);
  assert.equal(useDialogStore.getState().request?.kind, 'prompt');

  useDialogStore.getState().close('值');
  assert.equal(await first, '值');
});
