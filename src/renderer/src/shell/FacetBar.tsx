import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';

import {
  AVAILABILITY_VALUES,
  EMPTY_PREDICATE,
  ENUMERATED_FACETS,
  FACET_IDS,
  FAVORITE_VALUES,
  SYNC_STATUSES,
  groupFor,
  predicateEquals,
  type EnumeratedFacet,
  type FacetId,
  type SmartPredicate,
} from '../../../shared/library/smart-album.js';
import { commandById } from '../../../shared/commands/registry.js';
import type { AlbumListing } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { Segmented } from '../components/Segmented';
import { WORD_SEPARATOR } from '../components/word-separator';
import { useFormats } from '../i18n/use-formats.js';
import { useAppDispatch, useAppState } from '../state/app-state-context';
import { SaveSmartAlbumDialog } from './SmartAlbumDialogs';

import './facet-bar.css';

// The facet bar (#514, ADR-0030 §3): one predicate document drives both the
// live filters here and a saved Smart Album, so what the bar shows is
// exactly what a Smart Album would save. Values inside a facet are an
// inclusive union (Shift-click or "Add to selection" widens it); facets
// compose by an explicit, visible Match all / Match any — never a hidden
// boolean. Saving never touches a photo: only the query is written.

const messages = defineMessages({
  region: { id: 'facets.region', defaultMessage: 'Facet filters' },
  fileType: { id: 'facets.facet.fileType', defaultMessage: 'File type' },
  megapixels: { id: 'facets.facet.megapixels', defaultMessage: 'Megapixels' },
  camera: { id: 'facets.facet.camera', defaultMessage: 'Camera' },
  lens: { id: 'facets.facet.lens', defaultMessage: 'Lens' },
  location: { id: 'facets.facet.location', defaultMessage: 'Location' },
  tag: { id: 'facets.facet.tag', defaultMessage: 'Tag' },
  favorite: { id: 'facets.facet.favorite', defaultMessage: 'Favorite' },
  custody: { id: 'facets.facet.custody', defaultMessage: 'Custody' },
  availability: { id: 'facets.facet.availability', defaultMessage: 'Availability' },
  facetChip: { id: 'facets.chip', defaultMessage: '{facet}{count, plural, =0 {} other { · #}}' },
  composition: { id: 'facets.composition', defaultMessage: 'Combine facets' },
  matchAll: { id: 'facets.composition.all', defaultMessage: 'Match all' },
  matchAny: { id: 'facets.composition.any', defaultMessage: 'Match any' },
  summaryNone: { id: 'facets.summary.none', defaultMessage: 'No facets' },
  summary: {
    id: 'facets.summary',
    defaultMessage: '{count, plural, one {# facet} other {# facets · {composition, select, and {match all} other {match any}}}}',
  },
  clearAll: { id: 'facets.clearAll', defaultMessage: 'Clear' },
  saveChanges: { id: 'facets.saveChanges', defaultMessage: 'Save changes' },
  savedChanges: { id: 'facets.savedChanges', defaultMessage: 'Saved changes to {name}' },
  saveFailed: { id: 'facets.saveFailed', defaultMessage: 'Could not save the Smart Album. Try again.' },
  savedAs: { id: 'facets.savedAs', defaultMessage: 'Saved Smart Album {name}' },
  editing: { id: 'facets.editing', defaultMessage: '· Editing {name}' },
  panel: { id: 'facets.panel', defaultMessage: '{facet} values' },
  additive: { id: 'facets.additive', defaultMessage: 'Add to selection' },
  additiveHint: { id: 'facets.additive.hint', defaultMessage: 'Shift-click also adds a value' },
  noValues: { id: 'facets.noValues', defaultMessage: 'No values in this library yet' },
  loading: { id: 'facets.loading', defaultMessage: 'Loading…' },
  min: { id: 'facets.megapixels.min', defaultMessage: 'Minimum megapixels' },
  max: { id: 'facets.megapixels.max', defaultMessage: 'Maximum megapixels' },
  apply: { id: 'facets.megapixels.apply', defaultMessage: 'Apply' },
  clearFacet: { id: 'facets.clearFacet', defaultMessage: 'Clear {facet}' },
  unknownSize: { id: 'facets.megapixels.unknown', defaultMessage: 'Photos with unknown dimensions never match a size range.' },
  favoriteYes: { id: 'facets.value.favorite.yes', defaultMessage: 'Favorite' },
  favoriteNo: { id: 'facets.value.favorite.no', defaultMessage: 'Not favorite' },
  available: { id: 'facets.value.availability.available', defaultMessage: 'Available' },
  unavailable: { id: 'facets.value.availability.unavailable', defaultMessage: 'Unavailable' },
  custodyLocal: { id: 'facets.value.custody.local', defaultMessage: 'Local' },
  custodySyncing: { id: 'facets.value.custody.syncing', defaultMessage: 'Syncing' },
  custodySynced: { id: 'facets.value.custody.synced', defaultMessage: 'Synced' },
  custodyOffloaded: { id: 'facets.value.custody.offloaded', defaultMessage: 'Offloaded' },
  custodyError: { id: 'facets.value.custody.error', defaultMessage: 'Error' },
});

const facetLabels: Readonly<Record<FacetId, MessageDescriptor>> = {
  fileType: messages.fileType,
  megapixels: messages.megapixels,
  camera: messages.camera,
  lens: messages.lens,
  location: messages.location,
  tag: messages.tag,
  favorite: messages.favorite,
  custody: messages.custody,
  availability: messages.availability,
};

const fixedValueLabels: Readonly<Record<string, MessageDescriptor>> = {
  'favorite:yes': messages.favoriteYes,
  'favorite:no': messages.favoriteNo,
  'availability:available': messages.available,
  'availability:unavailable': messages.unavailable,
  'custody:local': messages.custodyLocal,
  'custody:syncing': messages.custodySyncing,
  'custody:synced': messages.custodySynced,
  'custody:offloaded': messages.custodyOffloaded,
  'custody:error': messages.custodyError,
};

const FIXED_VALUES: Readonly<Record<'favorite' | 'custody' | 'availability', readonly string[]>> = {
  favorite: FAVORITE_VALUES,
  custody: SYNC_STATUSES,
  availability: AVAILABILITY_VALUES,
};

interface FacetOption {
  readonly value: string;
  readonly count: number | null;
}

function isEnumerated(facet: FacetId): facet is EnumeratedFacet {
  return (ENUMERATED_FACETS as readonly string[]).includes(facet);
}

function groupSize(predicate: SmartPredicate, facet: FacetId): number {
  const group = groupFor(predicate, facet);
  if (group === undefined) return 0;
  return group.facet === 'megapixels' ? group.ranges.length : group.values.length;
}

function useFacetOptions(facet: FacetId | null): readonly FacetOption[] | null {
  const [loaded, setLoaded] = useState<{ readonly facet: FacetId; readonly options: readonly FacetOption[] } | null>(null);
  useEffect(() => {
    if (facet === null || !isEnumerated(facet)) return undefined;
    let cancelled = false;
    void window.overlook.library
      .facetValues({ facet })
      .then(({ values }) => {
        if (!cancelled) setLoaded({ facet, options: values });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ facet, options: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [facet]);
  if (facet === null || facet === 'megapixels') return null;
  if (!isEnumerated(facet)) return FIXED_VALUES[facet].map((value) => ({ value, count: null }));
  return loaded !== null && loaded.facet === facet ? loaded.options : null;
}

function MegapixelPanel({ facet }: { readonly facet: 'megapixels' }): ReactElement {
  const intl = useIntl();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const current = groupFor(state.facets, facet);
  const range = current?.facet === 'megapixels' ? current.ranges[0] : undefined;
  const [min, setMin] = useState(range?.min === null || range?.min === undefined ? '' : String(range.min));
  const [max, setMax] = useState(range?.max === null || range?.max === undefined ? '' : String(range.max));
  const parse = (raw: string): number | null => {
    const value = Number(raw);
    return raw.trim() === '' || !Number.isFinite(value) || value < 0 ? null : value;
  };
  const apply = (): void => {
    const next = { min: parse(min), max: parse(max) };
    if (next.min === null && next.max === null) dispatch({ type: 'facet/cleared', facet });
    else if (next.min === null || next.max === null || next.min <= next.max) dispatch({ type: 'facet/rangeSet', ranges: [next] });
  };
  return (
    <div className="ovl-facetbar__range">
      <label className="ovl-facetbar__field">
        <span>{intl.formatMessage(messages.min)}</span>
        <input type="number" min={0} step={0.1} value={min} onChange={(event) => setMin(event.currentTarget.value)} />
      </label>
      <label className="ovl-facetbar__field">
        <span>{intl.formatMessage(messages.max)}</span>
        <input type="number" min={0} step={0.1} value={max} onChange={(event) => setMax(event.currentTarget.value)} />
      </label>
      <Button variant="secondary" size="sm" onClick={apply}>
        {intl.formatMessage(messages.apply)}
      </Button>
      <span className="ovl-facetbar__hint">{intl.formatMessage(messages.unknownSize)}</span>
    </div>
  );
}

function ValuePanel({ facet, additive }: { readonly facet: Exclude<FacetId, 'megapixels'>; readonly additive: boolean }): ReactElement {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const options = useFacetOptions(facet);
  const group = groupFor(state.facets, facet);
  const selected = new Set(group !== undefined && group.facet !== 'megapixels' ? group.values : []);
  if (options === null) return <span className="ovl-facetbar__hint">{intl.formatMessage(messages.loading)}</span>;
  if (options.length === 0) return <span className="ovl-facetbar__hint">{intl.formatMessage(messages.noValues)}</span>;
  return (
    <div className="ovl-facetbar__values">
      {options.map(({ value, count }) => {
        const fixed = fixedValueLabels[`${facet}:${value}`];
        const label = fixed === undefined ? (facet === 'fileType' ? value.toUpperCase() : value) : intl.formatMessage(fixed);
        const countText = count === null ? null : formatCount(count);
        // The chip shows the value and how many photos carry it; the accessible
        // name repeats both so the visible words stay inside the name
        // (WCAG 2.5.3).
        const ariaLabel = countText === null ? label : `${label} ${countText}`;
        return (
          <button
            key={value}
            type="button"
            className="ovl-facetbar__value"
            aria-pressed={selected.has(value)}
            aria-label={ariaLabel}
            onClick={(event) => {
              dispatch({ type: 'facet/toggled', facet, value, additive: additive || event.shiftKey });
            }}
          >
            {/* The separator keeps the value and the count two separate words:
                axe reads the visible text of a button by concatenating child
                text with no separator. */}
            <span>
              {label}
              {WORD_SEPARATOR}
            </span>
            {countText === null ? null : <span className="ovl-facetbar__count mono-data">{countText}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface FacetBarProps {
  /** The Smart Album whose query the bar is editing, when one is open. */
  readonly smartAlbum: AlbumListing | null;
  readonly albums: readonly AlbumListing[];
}

export function FacetBar({ smartAlbum, albums }: FacetBarProps): ReactElement {
  const intl = useIntl();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [openFacet, setOpenFacet] = useState<FacetId | null>(null);
  const [additive, setAdditive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const groups = state.facets.groups;
  const saved = smartAlbum?.predicate ?? EMPTY_PREDICATE;
  const dirty = smartAlbum !== null && !predicateEquals(state.facets, saved) && (groups.length > 0 || smartAlbum.predicate !== null);
  const saveChanges = (): void => {
    if (smartAlbum === null || saving) return;
    setSaving(true);
    void window.overlook.albums
      .setPredicate({ albumId: smartAlbum.id, predicate: state.facets })
      .then(() => {
        dispatch({
          type: 'toast/shown',
          toast: { title: intl.formatMessage(messages.savedChanges, { name: smartAlbum.name }), tone: 'green' },
        });
      })
      .catch(() => {
        dispatch({ type: 'toast/shown', toast: { title: intl.formatMessage(messages.saveFailed), tone: 'red' } });
      })
      .finally(() => setSaving(false));
  };
  return (
    <div className="ovl-facetbar" data-testid="facet-bar" role="group" aria-label={intl.formatMessage(messages.region)}>
      <div className="ovl-facetbar__row">
        {FACET_IDS.map((facet) => {
          const size = groupSize(state.facets, facet);
          return (
            <Chip
              key={facet}
              selected={size > 0}
              aria-expanded={openFacet === facet}
              onClick={() => setOpenFacet((open) => (open === facet ? null : facet))}
            >
              {intl.formatMessage(messages.facetChip, { facet: intl.formatMessage(facetLabels[facet]), count: size })}
            </Chip>
          );
        })}
        {groups.length < 2 ? null : (
          <Segmented<'and' | 'or'>
            label={intl.formatMessage(messages.composition)}
            options={[
              { value: 'and', label: intl.formatMessage(messages.matchAll) },
              { value: 'or', label: intl.formatMessage(messages.matchAny) },
            ]}
            value={state.facets.composition}
            onChange={(composition) => dispatch({ type: 'facetComposition/set', composition })}
          />
        )}
        <span className="ovl-facetbar__summary mono-data" role="status" aria-live="polite">
          {groups.length === 0
            ? intl.formatMessage(messages.summaryNone)
            : intl.formatMessage(messages.summary, { count: groups.length, composition: state.facets.composition })}
          {smartAlbum === null ? null : <span> {intl.formatMessage(messages.editing, { name: smartAlbum.name })}</span>}
        </span>
        <span className="ovl-facetbar__spacer" />
        {groups.length === 0 ? null : (
          <Button variant="ghost" size="sm" icon="x" onClick={() => dispatch({ type: 'facet/cleared' })}>
            {intl.formatMessage(messages.clearAll)}
          </Button>
        )}
        {smartAlbum === null ? (
          <Button variant="secondary" size="sm" icon="funnel" disabled={groups.length === 0} onClick={() => setSaveDialog(true)}>
            {intl.formatMessage(commandById('album.smart.new').label)}
          </Button>
        ) : (
          <Button variant="primary" size="sm" icon="funnel" disabled={!dirty || saving} onClick={saveChanges}>
            {intl.formatMessage(messages.saveChanges)}
          </Button>
        )}
      </div>
      {openFacet === null ? null : (
        <div
          className="ovl-facetbar__panel"
          role="group"
          aria-label={intl.formatMessage(messages.panel, { facet: intl.formatMessage(facetLabels[openFacet]) })}
        >
          {openFacet === 'megapixels' ? (
            // Keyed to the active range so the drafts follow a Clear or a
            // switch to another Smart Album while the panel stays open.
            <MegapixelPanel key={JSON.stringify(groupFor(state.facets, openFacet) ?? null)} facet={openFacet} />
          ) : (
            <ValuePanel facet={openFacet} additive={additive} />
          )}
          <div className="ovl-facetbar__panel-foot">
            {openFacet === 'megapixels' ? null : (
              <label className="ovl-facetbar__additive" title={intl.formatMessage(messages.additiveHint)}>
                <input type="checkbox" checked={additive} onChange={(event) => setAdditive(event.currentTarget.checked)} />
                <span>{intl.formatMessage(messages.additive)}</span>
              </label>
            )}
            {groupSize(state.facets, openFacet) === 0 ? null : (
              <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'facet/cleared', facet: openFacet })}>
                {intl.formatMessage(messages.clearFacet, { facet: intl.formatMessage(facetLabels[openFacet]) })}
              </Button>
            )}
          </div>
        </div>
      )}
      {saveDialog ? (
        <SaveSmartAlbumDialog
          predicate={state.facets}
          albums={albums}
          onClose={() => setSaveDialog(false)}
          onComplete={(album) => {
            setSaveDialog(false);
            dispatch({ type: 'toast/shown', toast: { title: intl.formatMessage(messages.savedAs, { name: album.name }), tone: 'green' } });
            dispatch({ type: 'smartAlbum/set', albumId: album.id, predicate: album.predicate ?? state.facets });
          }}
        />
      ) : null}
    </div>
  );
}
