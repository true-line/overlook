import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Board, Placement } from '../../src/shared/moodboard/board.js';
import { layerPosition, placementLabel, readingOrder, readingOrderIds } from '../../src/shared/moodboard/reading-order.js';

function placement(id: string, z: number): Placement {
  return { id, photoId: 'ph-' + id, x: 0, y: 0, w: 100, h: 100, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, z, groupId: null };
}

const board: Board = {
  id: 'b1',
  title: 'T',
  notes: '',
  size: { width: 1600, height: 1200 },
  background: 'ink',
  placements: [placement('a', 3), placement('b', 1), placement('c', 2)],
};

describe('reading order (I5)', () => {
  test('orders placements by ascending layer (z)', () => {
    assert.deepEqual(readingOrderIds(board), ['b', 'c', 'a']);
    assert.equal(readingOrder(board).length, 3);
  });

  test('layerPosition is the 1-based layer index', () => {
    assert.equal(layerPosition(board, 'b'), 1);
    assert.equal(layerPosition(board, 'a'), 3);
    assert.equal(layerPosition(board, 'missing'), 0);
  });
});

describe('placementLabel', () => {
  test('composes name + layer summary', () => {
    assert.equal(placementLabel({ photoName: 'Landscape, Big Sur', layer: 3, total: 14 }), 'Landscape, Big Sur — layer 3 of 14');
  });

  test('falls back to a neutral name when unavailable', () => {
    assert.equal(placementLabel({ photoName: null, layer: 1, total: 2 }), 'Photo — layer 1 of 2');
    assert.equal(placementLabel({ photoName: '   ', layer: 1, total: 2 }), 'Photo — layer 1 of 2');
  });

  test('appends a placeholder qualifier when present', () => {
    // The qualifier sits outside parentheses: a parenthetical is stripped
    // before a label-in-name check compares the visible words with the name.
    assert.equal(placementLabel({ photoName: 'Dunes', layer: 2, total: 5, qualifier: 'offloaded' }), 'Dunes, offloaded — layer 2 of 5');
    assert.equal(placementLabel({ photoName: 'Dunes', layer: 2, total: 5, qualifier: '  ' }), 'Dunes — layer 2 of 5');
  });
});
