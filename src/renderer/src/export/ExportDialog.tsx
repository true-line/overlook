import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { ExportDestinationIntent, ExportPayloadMode } from '../../../shared/ipc/export-channels.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { useFormats } from '../i18n/use-formats.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { CopyableValue } from '../components/CopyableValue';
import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';
import { custodyPresentation } from '../backup/custody-presentation.js';
import { EXPORT_JPEG_QUALITIES, ExportEditsOptions, type ExportJpegQuality } from './ExportEditsOptions';
import { useExportPreflight } from './use-export-preflight.js';
import { DisclosurePreview } from '../disclosure/DisclosurePreview';
import { useDisclosurePreview } from '../disclosure/use-disclosure-preview.js';
import type { DisclosureDestination, DisclosureField } from '../../../shared/disclosure/policy.js';

import './export.css';

const messages = defineMessages({
  allPhotos: { id: 'export.allPhotos', defaultMessage: 'Export all photos' },
  everyPhoto: { id: 'export.everyPhoto', defaultMessage: 'Every photo in this library' },
  unencryptedOriginals: { id: 'export.unencryptedOriginals', defaultMessage: 'Unencrypted originals' },
  allPhotosHint: {
    id: 'export.allPhotosHint',
    defaultMessage: 'Every original will be written as a plain, openable file to the folder you choose.',
  },
  itemFailures: { id: 'export.itemFailures', defaultMessage: 'View item failures' },
  copyDestination: { id: 'export.copy.destination', defaultMessage: 'export destination' },
  copyFailure: { id: 'export.copy.failure', defaultMessage: 'export failure' },
  metadata: { id: 'export.metadata.label', defaultMessage: 'Metadata' },
  metadataSource: { id: 'export.metadata.source', defaultMessage: 'Source' },
  metadataEdits: { id: 'export.metadata.edits', defaultMessage: 'Edits' },
  metadataNone: { id: 'export.metadata.none', defaultMessage: 'None' },
  metadataSourceHint: {
    id: 'export.metadata.sourceHint',
    defaultMessage: 'Copy retained source sidecars when originals are exported.',
  },
  metadataEditsHint: {
    id: 'export.metadata.editsHint',
    defaultMessage: 'Write title, description, and effective tags to a new XMP sidecar.',
  },
  metadataNoneHint: { id: 'export.metadata.noneHint', defaultMessage: 'Write no metadata sidecars.' },
  exportTo: { id: 'export.destination.kind', defaultMessage: 'Export to' },
  exportDestination: { id: 'export.destination.label', defaultMessage: 'Export destination' },
  folder: { id: 'export.destination.folder', defaultMessage: 'Folder' },
  applePhotos: { id: 'export.destination.applePhotos', defaultMessage: 'Apple Photos' },
  photoKitMetadataHint: {
    id: 'export.photoKit.metadataHint',
    defaultMessage: 'The original bytes, embedded metadata, creation date, and location are preserved where PhotoKit supports them.',
  },
  photoKitDecryptHint: {
    id: 'export.photoKit.decryptHint',
    defaultMessage: 'Apple Photos receives plain originals and may retain them after Overlook locks. Only this reviewed selection is sent.',
  },
  photoKitAccessHint: {
    id: 'export.photoKit.accessHint',
    defaultMessage: 'Export requests add-only Photos access. It cannot read or synchronize your Photos library.',
  },
  photoKitDone: {
    id: 'export.photoKit.done',
    defaultMessage: '{count} {count, plural, one {photo} other {photos}} exported and decrypted to Apple Photos.',
  },
  exportReasonEdits: {
    id: 'export.reason.edits',
    defaultMessage: 'Confirm the edits that won’t be exported, or choose another mode.',
  },
  exportReasonBlocked: { id: 'export.reason.blocked', defaultMessage: 'Include the withheld field, or export Baked.' },
});

// ExportDialog (#99): the design's 420px export flow, safety copy verbatim
// (#497 adds the declared payload mode — Bake / Original + XMP / Original
// only — and the ADR-0031 §6 loss report that gates Export).
// (README §6 + Content voice). The decrypt switch is ON by default; OFF
// disables Export and shows the amber warning — v1 ships no encrypted-export
// format (decision recorded on #97/#98). The host mounts a fresh instance
// per invocation, so state needs no reset.

export interface ExportDialogProps {
  readonly open: boolean;
  /** The selection to export. */
  readonly photoIds: readonly string[];
  /** Export all ordinary visible library photos through the main-process scope. */
  readonly allPhotos?: boolean | undefined;
  readonly onClose: () => void;
}

type Phase = 'options' | 'running' | 'done';

interface Bar {
  readonly done: number;
  readonly total: number;
}

interface DestinationSelection {
  readonly path: string;
  readonly authorization: string;
}

export function ExportDialog({ open, photoIds, allPhotos = false, onClose }: ExportDialogProps): ReactElement | null {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const { announce } = useAnnouncer();
  const destinationLabelId = useId();
  const metadataLabelId = useId();
  const exportReasonId = useId();
  const [phase, setPhase] = useState<Phase>('options');
  const [mode, setMode] = useState<ExportPayloadMode>('original-sidecars');
  const [quality, setQuality] = useState<ExportJpegQuality>('high');
  // The confirmation belongs to one loss list: when the list changes, it
  // resets (#1307).
  const [acknowledgedLosses, setAcknowledgedLosses] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<'original' | 'overlook' | 'none'>('original');
  const [destinationKind, setDestinationKind] = useState<'folder' | 'apple-photos'>('folder');
  const [decrypt, setDecrypt] = useState(true);
  const [destination, setDestination] = useState<DestinationSelection | null>(null);
  const [bar, setBar] = useState<Bar>({ done: 0, total: allPhotos ? 0 : photoIds.length });
  const [exported, setExported] = useState(0);
  const [failed, setFailed] = useState(0);
  const [failures, setFailures] = useState<
    readonly { readonly fileName: string; readonly reason: string; readonly custody?: PhotoCustodyStatus | undefined }[]
  >([]);
  const [cancelled, setCancelled] = useState(0);
  const [previewTranscodes, setPreviewTranscodes] = useState(0);
  const [bakedEdits, setBakedEdits] = useState(0);
  const [editSidecars, setEditSidecars] = useState(0);
  const [runError, setRunError] = useState(false);
  // ADR-0032 §6 (#509): operation-scope disclosure intent. Main compiles the
  // plan from it; the preview below is main's answer for the same intent.
  const [disclosureDestination, setDisclosureDestination] = useState<DisclosureDestination>('shared');
  const [widen, setWiden] = useState<readonly DisclosureField[]>([]);
  const preflight = useExportPreflight(photoIds, allPhotos, mode, open && destinationKind === 'folder');
  const disclosureIntent = { destination: disclosureDestination, operation: { narrow: [], widen: [...widen] } };
  const disclosurePreview = useDisclosurePreview(
    open && phase === 'options'
      ? {
          boundary: destinationKind === 'apple-photos' ? 'photo-kit' : 'export',
          destination: disclosureDestination,
          ...(allPhotos ? {} : { photoIds: [...photoIds] }),
          payload: destinationKind === 'folder' && mode === 'baked' ? 'baked' : 'original',
          metadata: destinationKind === 'apple-photos' ? 'original' : metadata,
          operation: disclosureIntent.operation,
        }
      : null,
  );
  const disclosureBlocked = disclosurePreview === null || disclosurePreview.blocked.length > 0;

  useEffect(() => {
    if (phase !== 'running') {
      return;
    }
    return destinationKind === 'apple-photos'
      ? window.overlook.photoKit.onProgress((payload) => {
          if (payload.operation === 'export') setBar({ done: payload.done, total: payload.total });
        })
      : window.overlook.export.onProgress((payload) => {
          setBar(payload);
        });
  }, [destinationKind, phase]);

  const progressQuarter = bar.total === 0 ? -1 : Math.floor((bar.done / bar.total) * 4);
  const announcedProgressQuarter = useRef(-2);
  useEffect(() => {
    if (phase !== 'running' || progressQuarter < 0 || announcedProgressQuarter.current === progressQuarter) return;
    announcedProgressQuarter.current = progressQuarter;
    announce(
      `${decrypt ? 'Decrypting and writing files' : 'Writing files'}: ${formatCount(bar.done)} of ${formatCount(bar.total)}`,
      'polite',
      'export-progress',
    );
  }, [announce, bar.done, bar.total, decrypt, formatCount, phase, progressQuarter]);

  if (!open) {
    return null;
  }

  const count = photoIds.length;
  const noun = count === 1 ? 'photo' : 'photos';
  const exportLabel = allPhotos ? intl.formatMessage(messages.allPhotos) : `Export ${formatCount(count)} ${noun}`;
  // One declared payload mode (ADR-0031 §6); `format` keeps the wire shape.
  const format = mode === 'baked' ? 'jpeg' : 'original';
  const edits = mode === 'baked' ? { mode, quality: EXPORT_JPEG_QUALITIES[quality] } : { mode };
  const lossKey = (preflight?.losses ?? []).map((loss) => `${loss.photoId}:${loss.reason}`).join('\n');
  const acknowledged = lossKey !== '' && acknowledgedLosses === lossKey;
  const editsBlocked = destinationKind === 'folder' && lossKey !== '' && !acknowledged;
  // Export is unavailable, not disabled, when the user has something to do
  // about it, and says what (#1307).
  const exportReason = editsBlocked
    ? intl.formatMessage(messages.exportReasonEdits)
    : disclosurePreview !== null && disclosurePreview.blocked.length > 0
      ? intl.formatMessage(messages.exportReasonBlocked)
      : undefined;
  const intent: ExportDestinationIntent = allPhotos
    ? { operation: 'all', metadata, ...edits, disclosure: disclosureIntent }
    : { operation: 'selected', photoIds: [...photoIds], format, metadata, ...edits, disclosure: disclosureIntent };

  const discardDestination = (): void => {
    if (destination !== null) {
      void window.overlook.export.revokeDestination({ authorization: destination.authorization });
      setDestination(null);
    }
  };

  const close = (): void => {
    discardDestination();
    onClose();
  };

  const start = (): void => {
    const run =
      destinationKind === 'apple-photos'
        ? window.overlook.photoKit.export({ photoIds: [...photoIds], disclosure: disclosureIntent })
        : destination === null
          ? null
          : allPhotos
            ? window.overlook.export.runAll({ authorization: destination.authorization, metadata, ...edits, disclosure: disclosureIntent })
            : window.overlook.export.run({
                photoIds: [...photoIds],
                authorization: destination.authorization,
                format,
                metadata,
                ...edits,
                disclosure: disclosureIntent,
              });
    if (run === null) return;
    setRunError(false);
    setPhase('running');
    void run
      .then((summary) => {
        setExported(summary.exported);
        setFailed(summary.failed);
        setFailures(summary.failures);
        setCancelled(summary.cancelled);
        setPreviewTranscodes(
          'previewTranscodes' in summary && typeof summary.previewTranscodes === 'number' ? summary.previewTranscodes : 0,
        );
        setBakedEdits('bakedEdits' in summary && typeof summary.bakedEdits === 'number' ? summary.bakedEdits : 0);
        setEditSidecars('editSidecars' in summary && typeof summary.editSidecars === 'number' ? summary.editSidecars : 0);
        setPhase('done');
        if (summary.failed > 0) {
          const custodyFailure = summary.failures
            .map((failure) => ('custody' in failure ? (failure as { readonly custody?: PhotoCustodyStatus }).custody : undefined))
            .find((custody): custody is PhotoCustodyStatus => custody !== undefined);
          announce(
            custodyFailure === undefined
              ? `Export finished with ${formatCount(summary.failed)} ${summary.failed === 1 ? 'failure' : 'failures'}`
              : custodyPresentation(intl, custodyFailure).text,
            'assertive',
          );
        } else if (summary.cancelled > 0) {
          announce(`Export cancelled after ${formatCount(summary.exported)} ${summary.exported === 1 ? 'photo' : 'photos'}`);
        } else {
          announce(
            `Export complete: ${formatCount(summary.exported)} ${summary.exported === 1 ? 'photo' : 'photos'} exported and decrypted`,
          );
        }
      })
      .catch(() => {
        setRunError(true);
        if (destinationKind === 'folder') {
          setDestination(null);
          setPhase('options');
        } else {
          setPhase('done');
        }
        announce('Export failed. No source photos were changed.', 'assertive');
      });
  };

  return (
    <Dialog
      open={open}
      title="Export"
      icon="share"
      width={420}
      onClose={phase === 'running' ? undefined : close}
      footer={
        phase === 'options' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="share"
              disabled={
                exportReason === undefined && (!decrypt || disclosureBlocked || (destinationKind === 'folder' && destination === null))
              }
              aria-disabled={exportReason === undefined ? undefined : true}
              aria-describedby={exportReason === undefined ? undefined : exportReasonId}
              onClick={exportReason === undefined ? start : undefined}
            >
              {exportLabel}
            </Button>
            {exportReason === undefined ? null : (
              <p id={exportReasonId} className="ovl-export__footerReason prose-note" data-testid="export-reason">
                {exportReason}
              </p>
            )}
          </>
        ) : phase === 'running' ? (
          <Button
            variant="ghost"
            onClick={() => {
              if (destinationKind === 'apple-photos') void window.overlook.photoKit.cancel();
              else void window.overlook.export.cancel({});
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {phase === 'options' ? (
        <div className="ovl-export__options">
          <div className="ovl-export__card">
            <Icon name="image" size={16} />
            <div className="ovl-export__cardTitle">
              {allPhotos ? intl.formatMessage(messages.everyPhoto) : `${formatCount(count)} ${noun} selected`}
            </div>
          </div>
          <div className="ovl-export__row">
            <span>{intl.formatMessage(messages.exportTo)}</span>
            <Segmented
              label={intl.formatMessage(messages.exportDestination)}
              value={destinationKind}
              onChange={(next) => {
                if (next !== destinationKind) discardDestination();
                setDestinationKind(next);
              }}
              options={[
                { value: 'folder', icon: 'folder', label: intl.formatMessage(messages.folder) },
                { value: 'apple-photos', icon: 'image', label: intl.formatMessage(messages.applePhotos), disabled: allPhotos },
              ]}
            />
          </div>
          <ExportEditsOptions
            mode={mode}
            onModeChange={(next) => {
              if (next !== mode) discardDestination();
              setMode(next);
              setAcknowledgedLosses(null);
            }}
            quality={quality}
            onQualityChange={(next) => {
              if (next !== quality) discardDestination();
              setQuality(next);
            }}
            disabled={destinationKind === 'apple-photos'}
            preflight={preflight}
            acknowledged={acknowledged}
            onAcknowledge={(checked) => setAcknowledgedLosses(checked ? lossKey : null)}
          />
          <div className="ovl-export__row" role="group" aria-labelledby={metadataLabelId}>
            <span id={metadataLabelId}>{intl.formatMessage(messages.metadata)}</span>
            <Segmented
              label={intl.formatMessage(messages.metadata)}
              value={destinationKind === 'apple-photos' ? 'original' : metadata}
              disabled={destinationKind === 'apple-photos'}
              onChange={(next) => {
                if (next !== metadata) discardDestination();
                setMetadata(next);
              }}
              options={[
                { value: 'original', label: intl.formatMessage(messages.metadataSource) },
                { value: 'overlook', label: intl.formatMessage(messages.metadataEdits) },
                { value: 'none', label: intl.formatMessage(messages.metadataNone) },
              ]}
            />
          </div>
          <div className="ovl-export__metadataHint">
            {destinationKind === 'apple-photos'
              ? intl.formatMessage(messages.photoKitMetadataHint)
              : intl.formatMessage(
                  metadata === 'original'
                    ? messages.metadataSourceHint
                    : metadata === 'overlook'
                      ? messages.metadataEditsHint
                      : messages.metadataNoneHint,
                )}
          </div>
          <DisclosurePreview
            preview={disclosurePreview}
            destination={disclosureDestination}
            onDestinationChange={(next) => {
              if (next !== disclosureDestination) discardDestination();
              setDisclosureDestination(next);
            }}
            widen={widen}
            onWidenChange={(next) => {
              discardDestination();
              setWiden(next);
            }}
          />
          <div className="ovl-export__decrypt">
            <div>
              <div className="ovl-export__decryptTitle">
                {allPhotos ? intl.formatMessage(messages.unencryptedOriginals) : 'Decrypt originals'}
              </div>
              <div className="ovl-export__decryptHint">
                {destinationKind === 'apple-photos'
                  ? intl.formatMessage(messages.photoKitDecryptHint)
                  : allPhotos
                    ? intl.formatMessage(messages.allPhotosHint)
                    : 'Files are stored encrypted. Turn this on to write plain, openable files to disk.'}
              </div>
            </div>
            {allPhotos ? null : <Switch checked={decrypt} onChange={setDecrypt} label="Decrypt originals" />}
          </div>
          {!decrypt ? (
            <div className="ovl-export__warning prose-note" role="alert">
              <Icon name="triangle-alert" size={12} />
              Without decryption, exported files can&apos;t be opened outside Overlook.
            </div>
          ) : null}
          {destinationKind === 'folder' ? (
            <div className="ovl-export__row" role="group" aria-labelledby={destinationLabelId}>
              <span id={destinationLabelId}>Destination</span>
              <Button
                variant="secondary"
                icon="folder"
                size="sm"
                onClick={() => {
                  void window.overlook.export.pickDestination({ intent }).then(({ path, authorization }) => {
                    if (path !== null && authorization !== null) {
                      setRunError(false);
                      setDestination({ path, authorization });
                    }
                  });
                }}
              >
                {destination === null ? 'Choose folder…' : (destination.path.split('/').at(-1) ?? destination.path)}
              </Button>
            </div>
          ) : (
            <div className="ovl-export__photosNotice prose-note">
              <Icon name="info" size={12} />
              {intl.formatMessage(messages.photoKitAccessHint)}
            </div>
          )}
          {destinationKind !== 'folder' || destination === null ? null : (
            <CopyableValue
              value={destination.path}
              label={intl.formatMessage(messages.copyDestination)}
              className="ovl-export__destinationPath"
            />
          )}
          {runError ? (
            <div className="ovl-export__failed" role="alert">
              <Icon name="triangle-alert" size={15} />
              Export failed — check the destination and try again.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ovl-export__running">
          <ProgressBar
            label={decrypt ? 'Decrypting & writing files' : 'Writing files'}
            tone="cyan"
            value={bar.done}
            max={Math.max(bar.total, 1)}
            detail={`${formatCount(bar.done)} / ${formatCount(bar.total)}`}
          />
          {phase === 'done' ? (
            runError || failed > 0 || cancelled > 0 ? (
              <div className="ovl-export__failed" role="alert">
                <Icon name="triangle-alert" size={15} />
                {runError
                  ? 'Export failed — check the destination and try again.'
                  : `${[
                      `${formatCount(exported)} exported`,
                      ...(failed > 0 ? [`${formatCount(failed)} failed`] : []),
                      ...(cancelled > 0 ? [`${formatCount(cancelled)} cancelled`] : []),
                    ].join(' · ')}.`}
                {failures.length > 0 ? (
                  <details>
                    <summary>{intl.formatMessage(messages.itemFailures)}</summary>
                    <ul>
                      {failures.map(({ fileName, reason, custody }) => {
                        const detail = custody === undefined ? reason : custodyPresentation(intl, custody).text;
                        return (
                          <li key={`${fileName}:${reason}`}>
                            <CopyableValue
                              value={`${fileName}: ${detail}`}
                              label={intl.formatMessage(messages.copyFailure)}
                              prose
                              className="ovl-export__failureValue"
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="ovl-export__done">
                <Icon name="circle-check" size={15} />
                {destinationKind === 'apple-photos'
                  ? intl.formatMessage(messages.photoKitDone, { count: exported })
                  : `${formatCount(exported)} ${exported === 1 ? 'photo' : 'photos'} exported and decrypted.`}
                {previewTranscodes > 0 ? ` ${formatCount(previewTranscodes)} from RAW previews (preview resolution).` : ''}
                {bakedEdits > 0 ? ` ${formatCount(bakedEdits)} with edits baked.` : ''}
                {editSidecars > 0 ? ` ${formatCount(editSidecars)} edit ${editSidecars === 1 ? 'sidecar' : 'sidecars'} written.` : ''}
              </div>
            )
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
