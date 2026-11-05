/**
 * 载荷展示编码
 * ------------------------------------------------------------------
 * 主进程已经按订阅声明的编码把字节解成了字符串，这里只是「把这段文本
 * 重新表示成另一种读法」给详情面板看，不参与收发。
 *
 * 单独成模块的理由：它纯输入纯输出、不碰 DOM，单测可以直接覆盖
 * （hex 补零、base64 的二进制安全、UTF-8 多字节边界）。
 */

import type { PayloadEncoding } from '@shared/models';

/** 把展示字符串按目标编码重新表示 */
export function reencode(text: string, encoding: PayloadEncoding): string {
  if (encoding === 'utf8') return text;

  const bytes = new TextEncoder().encode(text);
  if (encoding === 'hex') {
    let out = '';
    for (const b of bytes) out += `${b.toString(16).padStart(2, '0')} `;
    return out.trim();
  }

  // base64：逐字节拼二进制串再交给 btoa，避免 TextEncoder 的多字节序列被截断
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** payload 的字节数（按 UTF-8 计，和主进程 publish 的 bytes 口径一致） */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
