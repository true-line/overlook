import { PhotoRepairAction } from './photo-repair-action.js';
import { useEffect, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { useFormats } from '../i18n/use-formats.js';
import { usePhotoThumbnailUrl } from './use-photo-thumbnail-url';
import { mediaInfoRows } from '../../../shared/library/media-info-format.js';
import { previewFailureLabel } from '../components/previewFailureLabel.js';
import { Badge } from '../components/Badge';
import { MetadataRow } from '../components/MetadataRow';
import { StatusGlyph, glyphStateOf } from '../components/StatusGlyph';
import { IconButton } from '../components/IconButton';
import { Icon } from '../components/Icon';
import { CopyableValue } from '../components/CopyableValue';
import type { PhotoRecord, SyncStatus } from '../../../shared/library/types.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { PhotoMetadataEditor } from './PhotoMetadataEditor.js';
import { EditsSection } from './EditsSection.js';
import { HistogramSection } from './HistogramSection.js';
import { ProvenanceSection } from './ProvenanceSection.js';
import { VariantsSection } from './VariantsSection.js';
import { custodyPresentation } from '../backup/custody-presentation.js';
import { usePhotoCustodyStatus } from '../backup/use-photo-custody-status.js';
import { OriginalRecoveryAction } from './original-recovery-action.js';

import './inspector.css';

// Inspector (#94, README §4): the 280px right-docked truth panel for the
// focused photo. Every value comes from the real record — missing EXIF rows
// are OMITTED, never fabricated (Content voice), and the cipher row reads
// the photo's actual key id.

const STATUS_TONE: Record<SyncStatus, string> = {
  local: 'var(--text-muted)',
  synced: 'var(--accent-green)',
  syncing: 'var(--accent-amber)',
  offloaded: 'var(--accent-amber)',
  error: 'var(--accent-red)',
};

const messages = defineMessages({
  title: { id: 'inspector.title', defaultMessage: 'Inspector' },
  metadataLabel: { id: 'inspector.file.metadata', defaultMessage: 'Metadata' },
  dimensionMismatch: {
    id: 'inspector.file.dimensionMismatch',
    defaultMessage: 'Dimensions mismatch — possibly corrupt metadata',
  },
  selectionPosition: { id: 'inspector.selection.position', defaultMessage: '{current} of {count} selected' },
  previousSelected: { id: 'inspector.selection.previous', defaultMessage: 'Previous selected photo' },
  nextSelected: { id: 'inspector.selection.next', defaultMessage: 'Next selected photo' },
  copyFileName: { id: 'inspector.copy.fileName', defaultMessage: 'filename' },
  copyCipher: { id: 'inspector.copy.cipher', defaultMessage: 'cipher identity' },
  lockedThumb: { id: 'inspector.custody.lockedThumb', defaultMessage: 'Locked' },
  custodyLocked: {
    id: 'inspector.custody.locked',
    defaultMessage: 'Locked — KEY #{id} is not on this device',
  },
  localMissing: {
    id: 'inspector.custody.localMissing',
    defaultMessage: 'Local original missing — backup remains excluded by choice',
  },
  localCorrupt: {
    id: 'inspector.custody.localCorrupt',
    defaultMessage: 'Local original corrupt — backup remains excluded by choice',
  },
});

function Section({ title, children }: { readonly title: string; readonly children: ReactElement | (ReactElement | null)[] }): ReactElement {
  return (
    <section className="ovl-inspector__section">
      <h3 className="ovl-inspector__sectionTitle">{title}</h3>
      {children}
    </section>
  );
}

export interface InspectorProps {
  /** The focused photo — lightbox photo, else the single grid selection. */
  readonly photo: PhotoRecord | null;
  /** Bulk-edit scope. Defaults to the focused photo in detached inspectors. */
  readonly photoIds?: readonly string[] | undefined;
  readonly providerLabel?: string | undefined;
  readonly selectionPosition?: { readonly index: number; readonly count: number } | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  /** Opens a sibling variant (#496) where the focused photo is shown. */
  readonly onShowPhoto?: ((photoId: string) => void) | undefined;
}

export function Inspector({
  photo,
  photoIds,
  providerLabel = 'Cloud',
  selectionPosition,
  onPrevious,
  onNext,
  onShowPhoto,
}: InspectorProps): ReactElement {
  const intl = useIntl();
  const thumbnailUrl = usePhotoThumbnailUrl(photo?.id ?? null);
  const { announce } = useAnnouncer();
  const { formatBytes, formatCalendarDate } = useFormats();
  const custodyStatus = usePhotoCustodyStatus(
    photo?.id ?? '',
    photo?.coverage === 'included' && (photo.syncState === 'offloaded' || photo.syncState === 'error'),
  );
  const custody =
    custodyStatus === null || (photo?.syncState === 'error' && custodyStatus.state === 'available')
      ? null
      : custodyPresentation(intl, custodyStatus);
  useEffect(() => {
    if (photo === null) return;
    const date = formatCalendarDate(photo.takenAt ?? photo.importedAt);
    announce([photo.fileName, date, photo.place].filter((part) => part !== null).join(', '), 'polite', 'inspector-photo');
  }, [announce, formatCalendarDate, photo?.fileName, photo?.importedAt, photo?.place, photo?.takenAt]);
  useEffect(() => {
    if (custody?.assertive !== true) return;
    announce(custody.text, 'assertive', 'inspector-custody');
  }, [announce, custody?.assertive, custody?.text]);
  if (photo === null) {
    return (
      <div className="ovl-inspector ovl-inspector--empty" data-testid="inspector">
        <h2 className="ovl-sr-only">{intl.formatMessage(messages.title)}</h2>
        <span className="prose-note">Select a photo</span>
      </div>
    );
  }
  const dimensions =
    photo.width > 0 && photo.height > 0
      ? `${String(photo.width)}×${String(photo.height)} · ${((photo.width * photo.height) / 1_000_000).toFixed(1)} MP`
      : 'Unknown — repair pending';
  const exposure = [
    photo.aperture === null ? null : `ƒ/${photo.aperture}`,
    photo.shutter === null ? null : `${photo.shutter}S`,
    photo.iso === null ? null : `ISO ${String(photo.iso)}`,
  ].filter((part) => part !== null);
  const dateLine = [formatCalendarDate(photo.takenAt ?? photo.importedAt), photo.place ?? null].filter((part) => part !== null).join(' · ');
  const mediaRows = mediaInfoRows(photo.fileKind, photo.mediaInfo);
  const provider = providerLabel;
  const statusText: Record<SyncStatus, string> = {
    local: 'Local only — not backed up',
    synced: `Encrypted · ${provider}`,
    syncing: `Encrypting → ${provider}…`,
    offloaded: `Offloaded — original in ${provider}`,
    error: 'Sync failed — will retry',
  };
  // Backup coverage (#506, ADR-0033 §6): an excluded row reads as a choice,
  // and an owed provider removal reads as pending, never as backed up.
  const coverageText =
    photo.coverage === 'excluding' ? 'On this device only — cloud copy removal pending' : 'On this device only — not backed up by choice';
  const localProblem = photo.coverage === 'excluded' ? photo.localCustodyFailure : null;
  return (
    <div className="ovl-inspector" data-testid="inspector">
      <h2 className="ovl-sr-only">{intl.formatMessage(messages.title)}</h2>
      {selectionPosition === undefined ? null : (
        <nav
          className="ovl-inspector__selectionNav"
          aria-label={intl.formatMessage(messages.selectionPosition, {
            current: selectionPosition.index + 1,
            count: selectionPosition.count,
          })}
        >
          <IconButton icon="chevron-left" label={intl.formatMessage(messages.previousSelected)} onClick={onPrevious} />
          <span className="prose-note" aria-live="polite">
            {intl.formatMessage(messages.selectionPosition, {
              current: selectionPosition.index + 1,
              count: selectionPosition.count,
            })}
          </span>
          <IconButton icon="chevron-right" label={intl.formatMessage(messages.nextSelected)} onClick={onNext} />
        </nav>
      )}
      {photo.previewFailure === 'deferred-original' ? (
        <p className="prose-note" role="status">
          {previewFailureLabel(intl, photo.previewFailure)}
        </p>
      ) : null}
      <PhotoRepairAction key={`repair:${photo.id}`} photo={photo} />
      <OriginalRecoveryAction key={`recover:${photo.id}`} photo={photo} />
      <div className="ovl-inspector__header">
        {photo.locked ? (
          <div
            className="ovl-inspector__thumb ovl-inspector__thumb--locked"
            role="img"
            aria-label={intl.formatMessage(messages.lockedThumb)}
          >
            <Icon name="lock" size={18} strokeWidth={1.75} />
          </div>
        ) : (
          <img className="ovl-inspector__thumb" src={thumbnailUrl} alt="" />
        )}
        <div className="ovl-inspector__headText">
          <CopyableValue
            value={photo.fileName}
            label={intl.formatMessage(messages.copyFileName)}
            className="ovl-inspector__copyName"
            textClassName="ovl-inspector__name"
          />
          <div className="ovl-inspector__date mono-data">{dateLine}</div>
        </div>
        <StatusGlyph state={glyphStateOf(photo)} {...(custody === null ? {} : { title: custody.text })} />
      </div>
      <PhotoMetadataEditor photo={photo} photoIds={photoIds ?? [photo.id]} />
      <Section title="Badges">
        <div className="ovl-inspector__badges">
          <Badge tone="green" icon="lock">
            Encrypted
          </Badge>
          <Badge>{photo.fileKind}</Badge>
          {photo.favorite ? (
            <Badge tone="cyan" icon="star">
              Favorite
            </Badge>
          ) : null}
          {photo.isOriginal ? (
            <Badge tone="amber" icon="shield-check">
              Original
            </Badge>
          ) : null}
        </div>
      </Section>
      <Section title="Capture">
        {photo.camera === null ? null : <MetadataRow label="Camera" value={photo.camera} />}
        {photo.lens === null ? null : <MetadataRow label="Lens" value={photo.lens} />}
        {exposure.length === 0 ? null : <MetadataRow label="Exposure" value={exposure.join(' · ')} />}
        {photo.focalLength === null ? null : <MetadataRow label="Focal" value={`${String(photo.focalLength)}MM`} />}
      </Section>
      {mediaRows.length === 0 ? null : (
        <Section title="Media">
          {mediaRows.map((row) => (
            <MetadataRow key={row.label} label={row.label} value={row.value} />
          ))}
        </Section>
      )}
      <Section title="File">
        <MetadataRow label="Dimensions" value={dimensions} mono={photo.width > 0 && photo.height > 0} />
        {photo.dimensionStatus === 'metadata-mismatch' ? (
          <MetadataRow
            label={intl.formatMessage(messages.metadataLabel)}
            value={intl.formatMessage(messages.dimensionMismatch)}
            mono={false}
            tone="var(--accent-amber)"
          />
        ) : null}
        <MetadataRow label="Size" value={formatBytes(photo.bytes)} />
        {photo.locked ? (
          <MetadataRow
            label="Custody"
            value={intl.formatMessage(messages.custodyLocked, { id: String(photo.missingKeyId ?? photo.keyId) })}
            mono={false}
            tone="var(--accent-amber)"
          />
        ) : null}
        <MetadataRow label="Imported" value={`${formatCalendarDate(photo.importedAt)} · ${photo.importSource}`} />
      </Section>
      <HistogramSection photo={photo} />
      <EditsSection photoId={photo.id} />
      <VariantsSection photo={photo} onShowPhoto={onShowPhoto} />
      <ProvenanceSection photoId={photo.id} />
      <Section title="Backup">
        <MetadataRow
          label="State"
          value={
            localProblem != null
              ? intl.formatMessage(localProblem === 'local-missing' ? messages.localMissing : messages.localCorrupt)
              : photo.coverage === 'included'
                ? (custody?.text ?? statusText[photo.syncState])
                : coverageText
          }
          mono={false}
          tone={
            localProblem != null
              ? STATUS_TONE.error
              : photo.coverage === 'included'
                ? (custody?.tone ?? STATUS_TONE[photo.syncState])
                : STATUS_TONE.offloaded
          }
        />
        <MetadataRow
          label="Cipher"
          value={`AES-256-GCM · KEY #${String(photo.keyId)}`}
          copyLabel={intl.formatMessage(messages.copyCipher)}
        />
      </Section>
    </div>
  );
}
