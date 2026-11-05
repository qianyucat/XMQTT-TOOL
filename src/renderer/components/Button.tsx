/**
 * 按钮原语
 * ------------------------------------------------------------------
 * 变体名与既有 CSS 类一一对应（`btn` / `btn--primary` / `btn--icon` / `btn--sm`），
 * 所以换成组件不会改变任何一个像素 —— 阶段 3 的目标是接管结构，不是重做样式。
 *
 * 用 cva 而不是手写三元：变体组合会随阶段 4 的视图变多（工具栏、列表项操作、
 * 弹层脚注各一套），把「哪种组合对应哪些类」集中在一处比散在调用点好维护。
 */

import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

const buttonStyles = cva('btn', {
  variants: {
    variant: {
      default: '',
      primary: 'btn--primary',
      danger: 'btn--danger',
      icon: 'btn--icon',
    },
    size: {
      md: '',
      sm: 'btn--sm',
    },
    wide: {
      true: 'btn--wide',
      false: '',
    },
    /** 开关类按钮的选中态（如「树形 / 平铺」） */
    active: {
      true: 'is-on',
      false: '',
    },
  },
  defaultVariants: { variant: 'default', size: 'md', wide: false, active: false },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {}

export function Button({ variant, size, wide, active, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={buttonStyles({ variant, size, wide, active, className })}
      {...rest}
    />
  );
}
