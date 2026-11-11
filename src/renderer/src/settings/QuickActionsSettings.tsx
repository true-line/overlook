import { useEffect, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { QUICK_ACTION_COMMANDS, type QuickActionCommandId } from '../../../shared/commands/registry.js';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';

const messages = defineMessages({
  moveUp: { id: 'settings.general.quickActions.moveUp', defaultMessage: ' — Move {action} up' },
  moveDown: { id: 'settings.general.quickActions.moveDown', defaultMessage: ' — Move {action} down' },
  maxReached: {
    id: 'settings.general.quickActions.maxReached',
    defaultMessage: 'Disable an action before enabling another.',
  },
  up: { id: 'settings.general.quickActions.up', defaultMessage: 'Up' },
  down: { id: 'settings.general.quickActions.down', defaultMessage: 'Down' },
});

export interface QuickActionsSettingsProps {
  readonly value: readonly QuickActionCommandId[];
  readonly onChange: (value: readonly QuickActionCommandId[]) => void;
}

export function QuickActionsSettings({ value, onChange }: QuickActionsSettingsProps): ReactElement {
  const intl = useIntl();
  const [optimisticValue, setOptimisticValue] = useState(value);
  const optimisticValueRef = useRef(value);
  const pendingValuesRef = useRef<readonly (readonly QuickActionCommandId[])[]>([]);

  useEffect(() => {
    const acknowledgedIndex = pendingValuesRef.current.findIndex(
      (pending) => pending.length === value.length && pending.every((id, index) => id === value[index]),
    );
    if (acknowledgedIndex >= 0) {
      const remaining = pendingValuesRef.current.slice(acknowledgedIndex + 1);
      pendingValuesRef.current = remaining;
      if (remaining.length > 0) return;
    } else {
      pendingValuesRef.current = [];
    }
    optimisticValueRef.current = value;
    setOptimisticValue(value);
  }, [value]);

  const commit = (next: readonly QuickActionCommandId[]): void => {
    pendingValuesRef.current = [...pendingValuesRef.current, next];
    optimisticValueRef.current = next;
    setOptimisticValue(next);
    onChange(next);
  };

  const enabled = new Set(optimisticValue);
  const commandsById = new Map(QUICK_ACTION_COMMANDS.map((command) => [command.id, command]));
  const commands = [
    ...optimisticValue
      .map((id) => commandsById.get(id))
      .filter((command): command is (typeof QUICK_ACTION_COMMANDS)[number] => command !== undefined),
    ...QUICK_ACTION_COMMANDS.filter(({ id }) => !enabled.has(id)),
  ];

  const toggle = (id: QuickActionCommandId, checked: boolean): void => {
    const current = optimisticValueRef.current;
    commit(checked ? [...current, id] : current.filter((candidate) => candidate !== id));
  };

  const move = (index: number, offset: -1 | 1): void => {
    const next = [...optimisticValueRef.current];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + offset, 0, item);
    commit(next);
  };

  return (
    <div className="ovl-quick-action-settings">
      {commands.map((command) => {
        const checked = enabled.has(command.id);
        const index = optimisticValue.indexOf(command.id);
        const label = intl.formatMessage(command.label);
        const maxReached = !checked && optimisticValue.length >= 5;
        return (
          <div className="ovl-quick-action-settings__row" key={command.id}>
            <Icon name={command.quickAction.icon} size={14} />
            <Switch
              checked={checked}
              disabled={maxReached}
              label={label}
              onChange={(nextChecked) => {
                toggle(command.id, nextChecked);
              }}
            />
            {checked ? (
              <div className="ovl-quick-action-settings__order">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  {intl.formatMessage(messages.up)}
                  <span className="ovl-sr-only">{intl.formatMessage(messages.moveUp, { action: label })}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === optimisticValue.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  {intl.formatMessage(messages.down)}
                  <span className="ovl-sr-only">{intl.formatMessage(messages.moveDown, { action: label })}</span>
                </Button>
              </div>
            ) : maxReached ? (
              <span className="ovl-quick-action-settings__reason">{intl.formatMessage(messages.maxReached)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
