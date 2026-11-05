/**
 * 载荷展示编码（`lib/payload.ts`）
 * ------------------------------------------------------------------
 * 这里只做「把已解码的字符串换一种读法给详情面板看」，但两个细节值得钉：
 * hex 必须两位补零（否则 0x0a 会显示成 "a"），base64 必须走二进制串
 * （直接 btoa 多字节文本会抛 InvalidCharacterError）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteLength, reencode } from '../../src/renderer/lib/payload';

test('reencode：utf8 原样返回', () => {
  assert.equal(reencode('hello', 'utf8'), 'hello');
  assert.equal(reencode('中文', 'utf8'), '中文');
});

test('reencode：hex 逐字节两位补零、空格分隔', () => {
  assert.equal(reencode('AB', 'hex'), '41 42');
  assert.equal(reencode('\n', 'hex'), '0a');
  assert.equal(reencode('', 'hex'), '');
});

test('reencode：base64 对多字节文本不抛错', () => {
  assert.equal(reencode('hello', 'base64'), 'aGVsbG8=');
  // 中文走 TextEncoder 之后是 3 字节/字，必须逐字节拼二进制串
  assert.equal(reencode('中', 'base64'), '5Lit');
});

test('byteLength：按 UTF-8 计，与主进程 publish 的口径一致', () => {
  assert.equal(byteLength('hello'), 5);
  assert.equal(byteLength('中'), 3);
  assert.equal(byteLength(''), 0);
});
