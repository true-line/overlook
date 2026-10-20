import type { HTMLAttributes, ReactElement } from 'react';

import './controls.css';
import { Icon, type IconName } from './Icon.js';

export type BadgeTone = 'neutral' | 'cyan' | 'amber' | 'green' | 'red';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
  readonly icon?: IconName | undefined;
}

// components/core/Badge.jsx — 18px uppercase mono pill, -dim bg + accent fg;
// glyphs render at 11px/stroke 2 per the mock.
export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps): ReactElement {
  const classes = ['ovl-badge', `ovl-badge--${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...rest}>
      {icon === undefined ? null : <Icon name={icon} size={11} strokeWidth={2} />}
      {children}
    </span>
  );
}
