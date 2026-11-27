import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ActivityFacade } from '../activity/activity-publication.js';
import {
  compileDisclosurePlan,
  DISCLOSURE_FIELDS,
  EMBEDDED_FIELDS,
  EMPTY_DISCLOSURE_OPERATION,
  PINNED_PRIVATE,
  type DisclosureBoundary,
  type DisclosureChain,
  type DisclosureClass,
  type DisclosureDestination,
  type DisclosureField,
  type DisclosureOperation,
  type DisclosureOverride,
  type DisclosureOverrideScope,
  type DisclosurePlan,
  type DisclosurePolicy,
} from '../../shared/disclosure/policy.js';
import type { DisclosurePreview, DisclosurePreviewField, DisclosurePreviewRequest } from '../../shared/ipc/disclosure-channels.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { DisclosureRepository } from './disclosure-repository.js';
import { carriesSourceSidecars, type SourceSidecarFinding } from '../../shared/disclosure/source-sidecars.js';
import { inspectSourceSidecar, sourceSidecarFinding, type SourceSidecarReader } from './source-sidecars.js';

const MAX_SOURCE_PREVIEW_BYTES = 32 * 1024 * 1024;

export interface DisclosureServiceDeps {
  readonly db: BetterSqlite3.Database;
  readonly getPhoto: (photoId: string) => PhotoRecord | undefined;
  /** Export-all scope (the same ids the export facade would take). */
  readonly exportableIds: () => readonly string[];
  /** Retained source sidecars per photo, for the "travel unfiltered" count. */
  readonly sidecarCount?: ((photoId: string) => number) | undefined;
  readonly sourceSidecars?: SourceSidecarReader | undefined;
  readonly activity?: (() => ActivityFacade | undefined) | undefined;
  /** Fires after any policy or override change so mounted projections (the File Provider's dates) re-enumerate. */
  readonly changed?: (() => void) | undefined;
  readonly audit: (line: string) => void;
  readonly now?: (() => Date) | undefined;
}

/** The planner every boundary consumes: one plan per photo and crossing. */
export interface DisclosurePlanner {
  plan(photoId: string, boundary: DisclosureBoundary, destination?: DisclosureDestination, operation?: DisclosureOperation): DisclosurePlan;
}

/** The value a photo carries for a field, or null. Precise location is the
 * pair, capture time the ISO stamp; ratings, faces, comments and provenance
 * are not carried by any boundary today and read as absent. */
export function fieldValue(photo: PhotoRecord, field: DisclosureField): string | null {
  switch (field) {
    case 'title':
      return photo.title;
    case 'description':
      return photo.description;
    case 'tags':
      return photo.tags.length === 0 ? null : photo.tags.join(', ');
    case 'captureTime':
      return photo.takenAt;
    case 'camera':
      return photo.camera;
    case 'lens':
      return photo.lens;
    case 'location':
      return photo.gpsLat === null || photo.gpsLon === null ? null : `${String(photo.gpsLat)}, ${String(photo.gpsLon)}`;
    case 'provenance':
    case 'ratings':
    case 'faces':
    case 'comments':
      return null;
  }
}

/** Embedded fields the original bytes of this photo carry (per its record). */
export function embeddedFieldsOf(photo: PhotoRecord): readonly DisclosureField[] {
  return EMBEDDED_FIELDS.filter((field) => fieldValue(photo, field) !== null);
}

/** Disclosure classes for one library (#509, ADR-0032 §6): the policy, its
 * scope overrides, the plan for one crossing and the preview the user sees
 * before it. Policy and consent changes go to activity history by field
 * name and class only. */
export class DisclosureService implements DisclosurePlanner {
  private readonly repo: DisclosureRepository;
  private revision = 0;

  constructor(private readonly deps: DisclosureServiceDeps) {
    this.repo = new DisclosureRepository(deps.db);
  }

  policy(): DisclosurePolicy {
    return this.repo.policy();
  }

  /** Monotonic consent revision, separate from the policy format version. */
  consentRevision(): number {
    return this.revision;
  }

  pinned(): readonly string[] {
    return PINNED_PRIVATE;
  }

  setField(field: DisclosureField, cls: DisclosureClass): DisclosurePolicy {
    const current = this.repo.policy();
    const from = current.fields[field];
    if (from === cls) return current;
    const stored = this.repo.writePolicy({ ...current, fields: { ...current.fields, [field]: cls } }, this.deps.now);
    this.revision += 1;
    this.deps.audit(`DISCLOSURE-POLICY scope=library field=${field} from=${from} to=${cls} version=${String(stored.version)}`);
    this.deps.activity?.()?.record({
      eventType: 'disclosure.policy-changed',
      outcome: 'succeeded',
      payload: { scope: 'library', field, from, to: cls, policyVersion: stored.version },
    });
    this.deps.changed?.();
    return stored;
  }

  overrides(scope: DisclosureOverrideScope, id: string): readonly DisclosureOverride[] {
    return this.repo.overrides(scope, id);
  }

  /** Sets or clears one scope override. A class wider than what the scope
   * inherits is the explicit widening action §6 requires and is recorded
   * as such; narrowing is silent policy. */
  setOverride(
    scope: DisclosureOverrideScope,
    id: string,
    field: DisclosureField,
    cls: DisclosureClass | null,
  ): readonly DisclosureOverride[] {
    const inherited = this.inheritedClass(scope, id, field);
    const before = this.repo.overrides(scope, id).find((entry) => entry.field === field)?.class ?? null;
    if (cls === null) this.repo.clearOverride(scope, id, field);
    else this.repo.setOverride(scope, id, field, cls, isWider(cls, inherited), this.deps.now);
    if (before !== cls) {
      this.revision += 1;
      this.deps.audit(`DISCLOSURE-POLICY scope=${scope} field=${field} from=${before ?? 'inherit'} to=${cls ?? 'inherit'}`);
      this.deps.activity?.()?.record({
        eventType: 'disclosure.policy-changed',
        entityIds: [id],
        outcome: 'succeeded',
        payload: { scope, field, from: before ?? 'inherit', to: cls ?? 'inherit', widened: cls !== null && isWider(cls, inherited) },
      });
      this.deps.changed?.();
    }
    return this.repo.overrides(scope, id);
  }

  chainFor(photoId: string): DisclosureChain {
    const collectionIds = this.repo.collectionsOf(photoId);
    const byCollection = this.repo.overridesFor('collection', collectionIds);
    return {
      library: this.repo.policy(),
      collections: collectionIds.map((collectionId) => byCollection.get(collectionId) ?? []),
      photo: this.repo.overrides('photo', photoId),
    };
  }

  /** Resolve Export all now, never later after consent has been consumed. */
  selection(photoIds?: readonly string[]): string[] {
    return [...new Set(photoIds ?? this.deps.exportableIds())].sort();
  }

  /** Main-owned exact values for the native ceremony; never audit this text. */
  consentDetail(request: DisclosurePreviewRequest): string {
    return this.selection(request.photoIds)
      .map((id) => {
        const photo = this.deps.getPhoto(id);
        if (photo === undefined) throw new Error('Disclosure selection is no longer available');
        const plan = this.plan(id, request.boundary, request.destination, request.operation);
        const rows = plan.decisions.map(
          (decision) =>
            `${decision.field} (${decision.class}, ${decision.disclosed ? 'crosses' : 'withheld'}): ${JSON.stringify(fieldValue(photo, decision.field))}`,
        );
        return `${JSON.stringify(photo.fileName)} [${id}]\n${rows.join('\n')}`;
      })
      .join('\n\n');
  }

  /** Cheap continuation binding: content-addressed companions are immutable;
   * the export reader also authenticates the exact bytes before copying. */
  consentBinding(request: DisclosurePreviewRequest): string {
    return JSON.stringify([
      this.consentRevision(),
      this.policy(),
      this.consentDetail(request),
      this.selection(request.photoIds).map((id) => [
        id,
        this.chainFor(id),
        carriesSourceSidecars(request) ? (this.deps.sourceSidecars?.sidecarsFor(id) ?? []) : [],
      ]),
    ]);
  }

  plan(
    photoId: string,
    boundary: DisclosureBoundary,
    destination: DisclosureDestination = 'shared',
    operation: DisclosureOperation = EMPTY_DISCLOSURE_OPERATION,
  ): DisclosurePlan {
    return compileDisclosurePlan({ boundary, destination, chain: this.chainFor(photoId), operation });
  }

  /** The exact preview §6 requires before a crossing: per field, how many
   * of the selection cross, a sample value, and what the originals carry
   * embedded that the plan would withhold. */
  async preview(request: DisclosurePreviewRequest): Promise<DisclosurePreview> {
    const ids = request.photoIds ?? this.deps.exportableIds();
    const operation = request.operation ?? EMPTY_DISCLOSURE_OPERATION;
    const photos = ids.map((id) => this.deps.getPhoto(id)).filter((photo): photo is PhotoRecord => photo !== undefined);
    const tallies = new Map<
      DisclosureField,
      { classes: Set<DisclosureClass>; disclosed: number; withheld: number; present: number; sample: string | null; widened: boolean }
    >();
    const embedded = new Set<DisclosureField>();
    const blocked = new Set<DisclosureField>();
    let policyVersion: number = this.repo.policy().version;
    let retainedSidecars = 0;
    const sourceSidecars: SourceSidecarFinding[] = [];
    let sourcePreviewBytes = 0;
    for (const photo of photos) {
      const plan = this.plan(photo.id, request.boundary, request.destination, operation);
      policyVersion = plan.policyVersion;
      const carried = request.payload === 'original' ? embeddedFieldsOf(photo) : [];
      for (const field of carried) {
        embedded.add(field);
        if (!plan.disclosed.includes(field)) blocked.add(field);
      }
      if (carriesSourceSidecars(request)) {
        const reader = this.deps.sourceSidecars;
        const sidecars = reader?.sidecarsFor(photo.id) ?? [];
        retainedSidecars += reader === undefined ? (this.deps.sidecarCount?.(photo.id) ?? 0) : sidecars.length;
        for (const sidecar of sidecars) {
          sourcePreviewBytes += Number.isSafeInteger(sidecar.bytes) && sidecar.bytes >= 0 ? sidecar.bytes : MAX_SOURCE_PREVIEW_BYTES;
          const inspection =
            sourcePreviewBytes > MAX_SOURCE_PREVIEW_BYTES
              ? { status: 'unavailable' as const, fields: [] }
              : await inspectSourceSidecar(sidecar, () => {
                  if (reader === undefined) throw new Error('Source sidecar reader unavailable');
                  return reader.sidecarStream(sidecar.ownerId ?? photo.id, sidecar.contentHash);
                });
          const finding = sourceSidecarFinding(photo.id, sidecar, inspection, plan);
          if (sourcePreviewBytes > MAX_SOURCE_PREVIEW_BYTES) finding.reason = 'budget';
          sourceSidecars.push(finding);
          for (const field of finding.blocked) blocked.add(field);
        }
      }
      for (const decision of plan.decisions) {
        const value = fieldValue(photo, decision.field);
        const tally = tallies.get(decision.field) ?? {
          classes: new Set(),
          disclosed: 0,
          withheld: 0,
          present: 0,
          sample: null,
          widened: false,
        };
        tally.classes.add(decision.class);
        if (value !== null) {
          tally.present += 1;
          if (decision.disclosed) {
            tally.disclosed += 1;
            tally.sample ??= value;
          } else {
            tally.withheld += 1;
          }
        }
        if (decision.reason === 'widened') tally.widened = true;
        tallies.set(decision.field, tally);
      }
    }
    const fields: DisclosurePreviewField[] = DISCLOSURE_FIELDS.flatMap((field) => {
      const tally = tallies.get(field);
      if (tally === undefined) return [];
      const classes = [...tally.classes];
      return [
        {
          field,
          class: classes.length === 1 ? (classes[0] ?? 'private') : 'mixed',
          disclosed: tally.disclosed,
          withheld: tally.withheld,
          present: tally.present,
          sample: tally.sample,
          widened: tally.widened,
        },
      ];
    });
    return {
      boundary: request.boundary,
      destination: request.destination,
      policyVersion,
      photos: photos.length,
      fields,
      embedded: EMBEDDED_FIELDS.filter((field) => embedded.has(field)),
      blocked: DISCLOSURE_FIELDS.filter((field) => blocked.has(field)),
      retainedSidecars,
      sourceSidecars,
    };
  }

  private inheritedClass(scope: DisclosureOverrideScope, id: string, field: DisclosureField): DisclosureClass {
    if (scope === 'collection') return this.repo.policy().fields[field];
    const chain = this.chainFor(id);
    return (
      compileDisclosurePlan({ boundary: 'export', destination: 'shared', chain: { ...chain, photo: [] } }).decisions.find(
        (decision) => decision.field === field,
      )?.class ?? chain.library.fields[field]
    );
  }
}

function isWider(a: DisclosureClass, b: DisclosureClass): boolean {
  const rank = { private: 0, shared: 1, public: 2 };
  return rank[a] > rank[b];
}
