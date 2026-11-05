/**
 * 复选框 / 开关
 * ------------------------------------------------------------------
 * 两者的 DOM 形状都是「原生 input + 装饰性 span」，样式全靠相邻兄弟选择器
 * （`.switch input:checked + .switch__track`）。因此不能再包一层 div，
 * 否则选择器失配、控件看起来永远处于关状态。
 */

import type { InputHTMLAttributes, ReactNode } from 'react';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

export function Checkbox({ label, ...rest }: ToggleProps) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({ label, ...rest }: ToggleProps) {
  return (
    <label className="switch">
      <input type="checkbox" {...rest} />
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      <span className="switch__text">{label}</span>
    </label>
  );
}
