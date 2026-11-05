/**
 * 共享层出口
 * ------------------------------------------------------------------
 * 渲染层一律从 `@shared` 引用，不直接摸具体文件，便于以后调整内部分层。
 */

export * from './models';
export * from './channels';
export * from './bridge';
