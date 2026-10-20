import type { Board, Placement } from './board.js';

// Accessible reading order (#693, invariant I5). A spatial canvas cannot rely on
// pixel position for structure, so a board exposes an explicit list of its
// placements that a screen reader can traverse. Reading order == layer order (z
// ascending): it matches the panel's layer list and Tab focus order exactly, so
// the parallel list and the canvas never disagree.

export function readingOrder(board: Board): readonly Placement[] {
  return [...board.placements].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function readingOrderIds(board: Board): readonly string[] {
  return readingOrder(board).map((placement) => placement.id);
}

/** 1-based layer position of a placement within the board, or 0 if absent. */
export function layerPosition(board: Board, placementId: string): number {
  return readingOrderIds(board).indexOf(placementId) + 1;
}

export interface PlacementLabelInput {
  /** Descriptive photo name, or null when unavailable/locked. */
  readonly photoName: string | null;
  /** 1-based layer position. */
  readonly layer: number;
  readonly total: number;
  /** Placeholder qualifier appended after the name (e.g. "offloaded"). Not
   * parenthesised: a parenthetical is invisible to name-in-label checks, which
   * strip it before comparing the visible words with the accessible name. */
  readonly qualifier?: string | null;
}

/** The placement's accessible name, e.g. "Landscape, Big Sur — layer 3 of 14".
 * Falls back to a neutral name when the photo can't be identified. */
export function placementLabel({ photoName, layer, total, qualifier = null }: PlacementLabelInput): string {
  const name = photoName === null || photoName.trim() === '' ? 'Photo' : photoName.trim();
  const suffix = qualifier === null || qualifier.trim() === '' ? '' : `, ${qualifier.trim()}`;
  return `${name}${suffix} — layer ${layer} of ${total}`;
}
