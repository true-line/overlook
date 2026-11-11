import type { CommandId } from './registry.js';

// One ordered Help list feeds both Help surfaces — the macOS native Help menu
// (main, `application-menu-model.ts`) and the Windows/Linux titlebar Help menu
// (renderer, `TitlebarHelpMenu`). Sharing the order and ids here is what keeps
// the two platforms from drifting (ADR-0024 §5 command parity, I1). Labels,
// enablement, and shortcuts still come from the command registry — this module
// only fixes membership and order.
export interface HelpMenuEntry {
  readonly command: CommandId;
  /** Distinct native menu-item id when the command also appears elsewhere in
   *  the menu tree (Privacy & Diagnostics is also a Settings Sections item, so
   *  the Help copy needs its own id to keep native ids unique). */
  readonly menuItemId?: string;
  /** A divider precedes this entry. */
  readonly separatorBefore?: boolean;
}

export const HELP_URL = 'https://github.com/true-line/overlook#readme';

export const HELP_MENU_ITEMS: readonly HelpMenuEntry[] = [
  { command: 'help.shortcuts' },
  { command: 'help.activity' },
  { command: 'app.settings.open.privacy', menuItemId: 'help.privacy', separatorBefore: true },
  { command: 'help.open' },
];
