import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Icon, ICON_NAMES } from '../../src/renderer/src/components/Icon.js';

// The DS readme §ICONOGRAPHY vocabulary, verbatim — the component must cover
// exactly this set.
const VOCABULARY = [
  'layout-grid',
  'list',
  'search',
  'funnel',
  'album',
  'star',
  'trash-2',
  'download',
  'share',
  'info',
  'settings-2',
  'lock',
  'shield-check',
  'key-round',
  'keyboard',
  'cloud',
  'cloud-upload',
  'copy',
  'cloud-download',
  'cloud-check',
  'cloud-alert',
  'refresh-cw',
  'hard-drive',
  'database',
  'camera',
  'map-pin',
  'aperture',
  // Window-control glyphs the design's TitleBar.jsx uses beyond the readme
  // list (#58).
  'minus',
  'square',
  'x',
  'triangle-alert',
  // Checkbox mark the design's Checkbox.jsx uses beyond the readme list (#61).
  'check',
  // Empty-state glyph the design's LibraryGrid.jsx uses beyond the readme
  // list (#76).
  'image-off',
  // Toolbar glyphs the design's Toolbar.jsx uses beyond the readme list
  // (#79): zoom-scale hints and the RAW chip.
  'grid-2x2',
  'grid-3x3',
  'image',
  // Sidebar glyphs the design's Sidebar.jsx uses beyond the readme list
  // (#80): All Photos row and the albums + affordance.
  'images',
  'plus',
  // Animated-media playback affordance (#547, ADR-0026 §7): reduced-motion
  // play/stop toggle now, video controls later (#549).
  'pause',
  'play',
  // Lightbox glyphs the design's Lightbox.jsx uses beyond the readme list
  // (#92): back control and the side navigation arrows.
  'arrow-left',
  // Album reorder controls (#225).
  'arrow-down',
  'arrow-up',
  'chevrons-down',
  'chevrons-up',
  'grip-vertical',
  'chevron-left',
  'chevron-right',
  // Library-switcher trigger glyph (#386).
  'chevrons-up-down',
  // Orientation-toolbar glyphs from the current lightbox handoff (#369).
  'flip-horizontal-2',
  'rotate-ccw',
  'rotate-cw',
  // ExportDialog glyphs the design's ExportDialog.jsx uses beyond the readme
  // list (#99): the folder picker and the done check.
  'folder',
  'circle-check',
  // Titlebar Help menu (#699): the Help button/Overlook Help glyph.
  'circle-help',
  // Titlebar Overlook menu (#1293): the ⋯ button.
  'ellipsis',
  'clock',
  // SettingsDialog nav glyph the design's SettingsDialog.jsx uses beyond the
  // readme list (#112): the General section row.
  'sliders-horizontal',
  // Sidebar rail toggle glyphs the updated design's Sidebar.jsx uses beyond
  // the readme list (#238).
  'panel-left-close',
  'panel-left-open',
  // Disconnected-state glyph the updated design's StatusBar.jsx/Sidebar.jsx
  // use beyond the readme list (#239).
  'cloud-off',
  // Import-source glyphs the updated design's ImportDialog.jsx/index.html
  // use beyond the readme list (#237): the folder dropzone + drop overlay.
  'folder-open',
  'image-down',
  // Recovery-key glyphs the design's KeyDialog.jsx/SettingsDialog.jsx use
  // beyond the readme list (#240).
  'eye',
  'eye-off',
  'file-key',
  'fingerprint',
  'upload',
  // Moodboard view glyphs the design's Moodboard.jsx uses beyond the readme
  // list (#515): the view Segmented option and the floating board toolbar
  // (align, group, layer order, crop, zoom, fit, share).
  'layout-dashboard',
  'align-horizontal-justify-center',
  'group',
  'bring-to-front',
  'send-to-back',
  'crop',
  'zoom-in',
  'zoom-out',
  'maximize-2',
  'layers',
  // Rename-library-folder affordance in the switcher rows (#686).
  'pencil',
  // Video transport + kind iconography (#548, ADR-0026 §5/§6/§7): the full
  // viewer's play/pause/mute/volume/captions/fullscreen controls, the grid
  // duration pill (play/film), and the video/audio/probing placeholder tiles.
  'captions',
  'film',
  'loader',
  'maximize',
  'music',
  'volume-2',
  'volume-x',
  // Disclosure class badges (Pass E, #1308): Shared and Public; Private uses 'lock'.
  'users',
  'globe',
] as const;

describe('Icon', () => {
  test('vocabulary matches the design system exactly', () => {
    assert.deepEqual([...ICON_NAMES].sort(), [...VOCABULARY].sort());
  });

  test('renders every glyph at every DS size with stroke 1.75', () => {
    for (const name of ICON_NAMES) {
      for (const size of [14, 16, 20] as const) {
        const svg = renderToStaticMarkup(createElement(Icon, { name, size }));
        assert.match(svg, /^<svg/, `${name}@${size} renders an svg`);
        assert.ok(svg.includes(`width="${size}"`), `${name}@${size} width`);
        assert.ok(svg.includes('stroke-width="1.75"'), `${name}@${size} stroke`);
        assert.ok(svg.includes('aria-hidden="true"'), `${name}@${size} aria-hidden`);
      }
    }
  });

  test('off-vocabulary names are a type error', () => {
    // @ts-expect-error 'sparkles' is not in the DS vocabulary — if this stops
    // erroring, the IconName union has leaked.
    const props: Parameters<typeof Icon>[0] = { name: 'sparkles' };
    assert.ok(props);
  });

  test('defaults: size 16, currentColor', () => {
    const svg = renderToStaticMarkup(createElement(Icon, { name: 'aperture' }));
    assert.ok(svg.includes('width="16"'));
    assert.ok(svg.includes('stroke="currentColor"'));
  });
});
