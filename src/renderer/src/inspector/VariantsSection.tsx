import { photoCommandAvailability, LOCKED_PHOTO_COMMAND_REASON } from '../../../shared/commands/photo-availability.js';
import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { thumbUrl } from '../../../shared/library/thumb-url.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { WORD_SEPARATOR } from '../components/word-separator';
import { useFormats } from '../i18n/use-formats.js';
import { duplicateToast } from '../grid/duplicate-photos.js';
import { usePhotoVariants, type PhotoVariantsApi } from './use-photo-variants';

// Inspector "Variants" section (#496, ADR-0031 §1 + §3): every live variant
// over the same original asset, which one is the Promoted representative,
// Duplicate for the shown photo, and Promote for any sibling. A row opens
// that variant in the lightbox. Custody never moves here: a family shares
// one encrypted original, and Promote is reversible metadata.

const messages = defineMessages({
  title: { id: 'inspector.variants.title', defaultMessage: 'Variants' },
  count: { id: 'inspector.variants.count', defaultMessage: '{count, plural, one {# variant} other {# variants}}' },
  representative: { id: 'inspector.variants.representative', defaultMessage: 'Representative' },
  promote: { id: 'inspector.variants.promote', defaultMessage: 'Promote' },
  promoteLabel: { id: 'inspector.variants.promoteLabel', defaultMessage: 'Promote {name} to representative' },
  duplicate: { id: 'inspector.variants.duplicate', defaultMessage: 'Duplicate' },
  duplicating: { id: 'inspector.variants.duplicating', defaultMessage: 'Duplicating…' },
  root: { id: 'inspector.variants.root', defaultMessage: 'Imported' },
  derived: { id: 'inspector.variants.derived', defaultMessage: 'Duplicate' },
  shown: { id: 'inspector.variants.shown', defaultMessage: 'Shown' },
  show: { id: 'inspector.variants.show', defaultMessage: 'Show {name}, {kind}, {date}' },
  // The shown row's visible meta line ends with "Shown", so the name has to
  // carry that word too (WCAG 2.5.3: the visible label must be in the name).
  showCurrent: { id: 'inspector.variants.showCurrent', defaultMessage: 'Show {name}, {kind}, {date}, Shown' },
  sharedOriginal: {
    id: 'inspector.variants.sharedOriginal',
    defaultMessage: 'One encrypted original · each variant keeps its own previews',
  },
});

const SECTION_CLASS = 'ovl-inspector__section';
const TITLE_CLASS = 'ovl-inspector__sectionTitle';
const BADGES_CLASS = 'ovl-inspector__badges';
const NOTE_CLASS = 'ovl-inspector__provenanceNote';
const ACTIONS_CLASS = 'ovl-inspector__provenanceActions';
const LIST_CLASS = 'ovl-inspector__variants';
const ROW_CLASS = 'ovl-inspector__variant';
const OPEN_CLASS = 'ovl-inspector__variantOpen';
const THUMB_CLASS = 'ovl-inspector__variantThumb';
const TEXT_CLASS = 'ovl-inspector__variantText';
const NAME_CLASS = 'ovl-inspector__variantName';
const META_CLASS = 'ovl-inspector__variantMeta mono-data';
const TEST_ID = 'inspector-variants';
const COUNT_TEST_ID = 'inspector-variants-count';
const ROW_TEST_ID = 'inspector-variant';
const ANNOUNCE_KEY = 'inspector-variants';

export interface VariantsSectionProps {
  readonly photo: PhotoRecord;
  /** Opens a sibling variant where the Inspector's photo comes from (the lightbox). */
  readonly onShowPhoto?: ((photoId: string) => void) | undefined;
  /** Test/story seam; production resolves the preload bridge. */
  readonly api?: PhotoVariantsApi;
}

export function VariantsSection({ photo, onShowPhoto, api }: VariantsSectionProps): ReactElement | null {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const { formatCalendarDate } = useFormats();
  const variants = usePhotoVariants(photo, api);
  const duplicateAvailable = photoCommandAvailability('photo.duplicate', photo.locked).enabled;
  if (!variants.available || variants.family === null) return null;
  const family = variants.family;
  const count = family.variants.length;
  const duplicate = async (): Promise<void> => {
    const result = await variants.duplicate();
    if (result !== null) announce(duplicateToast(result).title, 'polite', ANNOUNCE_KEY);
  };
  return (
    <section className={SECTION_CLASS} data-testid={TEST_ID} data-count={count} data-representative={family.representativeId ?? ''}>
      <h3 className={TITLE_CLASS}>{intl.formatMessage(messages.title)}</h3>
      <div className={BADGES_CLASS}>
        <Badge icon="copy" data-testid={COUNT_TEST_ID}>
          {intl.formatMessage(messages.count, { count })}
        </Badge>
      </div>
      <ul className={LIST_CLASS} aria-label={intl.formatMessage(messages.title)}>
        {family.variants.map((variant) => {
          const kind = intl.formatMessage(variant.variantSourceId === null ? messages.root : messages.derived);
          const date = formatCalendarDate(variant.importedAt);
          const current = variant.id === photo.id;
          const representative = variant.id === family.representativeId;
          return (
            <li
              key={variant.id}
              className={ROW_CLASS}
              data-testid={ROW_TEST_ID}
              data-photo-id={variant.id}
              data-representative={representative}
            >
              <button
                type="button"
                className={OPEN_CLASS}
                aria-label={intl.formatMessage(current ? messages.showCurrent : messages.show, { name: variant.fileName, kind, date })}
                aria-current={current ? 'true' : undefined}
                disabled={current || onShowPhoto === undefined}
                onClick={() => onShowPhoto?.(variant.id)}
              >
                <img className={THUMB_CLASS} src={thumbUrl(variant.id)} alt="" />
                <span className={TEXT_CLASS}>
                  {/* The separator keeps the file name and the meta line two
                      separate words: axe reads the visible text of a button by
                      concatenating child text with no separator. */}
                  <span className={NAME_CLASS}>
                    {variant.fileName}
                    {WORD_SEPARATOR}
                  </span>
                  <span className={META_CLASS}>
                    {[kind, date, current ? intl.formatMessage(messages.shown) : null].filter((part) => part !== null).join(' · ')}
                  </span>
                </span>
              </button>
              {representative ? (
                <Badge tone="cyan" icon="star">
                  {intl.formatMessage(messages.representative)}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  aria-label={intl.formatMessage(messages.promoteLabel, { name: variant.fileName })}
                  disabled={variants.busy}
                  onClick={() => void variants.promote(variant.id)}
                >
                  {intl.formatMessage(messages.promote)}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={NOTE_CLASS}>{intl.formatMessage(messages.sharedOriginal)}</p>
      {!duplicateAvailable ? (
        <p className={NOTE_CLASS}>{intl.formatMessage(LOCKED_PHOTO_COMMAND_REASON, { id: String(photo.missingKeyId ?? photo.keyId) })}</p>
      ) : null}
      <div className={ACTIONS_CLASS}>
        <Button size="sm" icon="copy" disabled={variants.busy || !duplicateAvailable} onClick={() => void duplicate()}>
          {intl.formatMessage(variants.busy ? messages.duplicating : messages.duplicate)}
        </Button>
      </div>
    </section>
  );
}
