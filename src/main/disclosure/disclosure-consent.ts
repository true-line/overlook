import { randomUUID } from 'node:crypto';

import { EMPTY_DISCLOSURE_OPERATION } from '../../shared/disclosure/policy.js';
import { requiresSourceOmission } from '../../shared/disclosure/source-sidecars.js';
import type { DisclosurePreview, DisclosurePreviewRequest } from '../../shared/ipc/disclosure-channels.js';
import type { ExportDisclosureIntentWire } from '../../shared/ipc/export-channels.js';
import type { ExportDisclosureIntent } from '../export/export-engine.js';
import type { DisclosureService } from './disclosure-service.js';

export interface DisclosureRunRequest {
  readonly photoIds?: readonly string[] | undefined;
  readonly boundary: 'export' | 'photo-kit';
  readonly payload: 'original' | 'baked';
  readonly mode?: 'original' | 'original-sidecars' | 'baked' | undefined;
  readonly metadata?: 'original' | 'overlook' | 'none' | undefined;
  readonly disclosure?: ExportDisclosureIntentWire | undefined;
}

interface Snapshot {
  readonly service: DisclosureService;
  readonly context: string;
  readonly fingerprint: string;
  readonly request: DisclosurePreviewRequest;
  readonly preview: DisclosurePreview;
  readonly detail: string;
  readonly revision: number;
  readonly binding: string;
}

interface Grant {
  readonly snapshot: Snapshot;
  readonly expires: number;
}

export interface DisclosureConsentDeps {
  readonly getService: () => DisclosureService;
  readonly admit: () => void;
  readonly libraryId: () => string;
  readonly authorizationEpoch: () => number;
  readonly confirm: (detail: string) => Promise<boolean>;
  readonly now?: () => number;
}

/** Only main's affirmative native ceremony can create authority. Deletion
 * precedes every binding check and every await in either export adapter. */
export class DisclosureConsentAuthority {
  private readonly grants = new Map<string, Grant>();
  private confirming = false;

  constructor(private readonly deps: DisclosureConsentDeps) {}

  async preview(request: DisclosurePreviewRequest): Promise<DisclosurePreview> {
    this.deps.admit();
    if (!request.confirmWidening || (request.operation?.widen.length ?? 0) === 0) {
      const service = this.deps.getService();
      const context = this.context();
      const preview = await service.preview(request);
      this.deps.admit();
      if (service !== this.deps.getService() || context !== this.context()) throw new Error('Disclosure preview changed; review it again');
      return preview;
    }
    if (this.confirming) throw new Error('Disclosure confirmation already open');
    this.confirming = true;
    try {
      const snapshot = await this.snapshot(request);
      if (snapshot.preview.sourceSidecars?.some((sidecar) => requiresSourceOmission(sidecar.status))) {
        throw new Error('Source sidecars cannot be inspected. Use Metadata: Edits/None.');
      }
      if (snapshot.detail.length > 60_000) throw new Error('Select fewer photos to confirm disclosure');
      const confirmed = await this.deps.confirm(snapshot.detail);
      this.deps.admit();
      const current = await this.snapshot(request);
      if (!this.same(snapshot, current)) throw new Error('Disclosure preview changed; review it again');
      if (!confirmed) return current.preview;
      this.prune();
      if (this.grants.size >= 32) this.grants.clear();
      const consent = randomUUID();
      this.grants.set(consent, { snapshot, expires: this.now() + 5 * 60_000 });
      return { ...current.preview, consent };
    } finally {
      this.confirming = false;
    }
  }

  async consume(request: DisclosureRunRequest): Promise<{ photoIds: readonly string[]; disclosure: ExportDisclosureIntent }> {
    const token = request.disclosure?.consent ?? '';
    const grant = this.grants.get(token);
    this.grants.delete(token);
    this.prune();
    refuseRawWidening(request.disclosure);
    this.deps.admit();
    if (grant === undefined || grant.expires <= this.now()) throw new Error('Disclosure consent is invalid or expired');
    const stored = grant.snapshot.request;
    const current = await this.snapshot({
      boundary: request.boundary,
      destination: request.disclosure?.destination ?? 'shared',
      ...(request.photoIds === undefined ? {} : { photoIds: [...request.photoIds] }),
      payload: request.payload,
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      metadata: request.metadata ?? 'original',
      operation: {
        narrow: request.disclosure?.operation.narrow ?? [],
        widen: stored.operation?.widen ?? [],
      },
    });
    if (grant.expires <= this.now() || !this.same(grant.snapshot, current))
      throw new Error('Disclosure consent does not match this request');
    return {
      photoIds: [...(stored.photoIds ?? [])],
      disclosure: {
        destination: stored.destination,
        operation: structuredClone(stored.operation ?? EMPTY_DISCLOSURE_OPERATION),
        assertCurrent: () => {
          this.deps.admit();
          if (
            grant.snapshot.service !== this.deps.getService() ||
            grant.snapshot.context !== this.context() ||
            grant.snapshot.binding !== this.deps.getService().consentBinding(stored)
          )
            throw new Error('Disclosure consent is no longer current');
        },
      },
    };
  }

  private async snapshot(input: DisclosurePreviewRequest): Promise<Snapshot> {
    const service = this.deps.getService();
    const request: DisclosurePreviewRequest = {
      boundary: input.boundary,
      destination: input.destination,
      photoIds: service.selection(input.photoIds),
      payload: input.payload,
      mode: input.mode ?? (input.boundary === 'photo-kit' ? 'original' : input.payload === 'baked' ? 'baked' : 'original-sidecars'),
      metadata: input.metadata ?? 'original',
      operation: {
        narrow: [...new Set(input.operation?.narrow ?? [])].sort(),
        widen: [...new Set(input.operation?.widen ?? [])].sort(),
      },
    };
    const context = this.context();
    const binding = service.consentBinding(request);
    const preview = await service.preview(request);
    this.deps.admit();
    if (
      service !== this.deps.getService() ||
      context !== this.context() ||
      binding !== service.consentBinding(request) ||
      JSON.stringify(request.photoIds) !== JSON.stringify(service.selection(input.photoIds))
    )
      throw new Error('Disclosure preview changed; review it again');
    const detail = [
      `Destination: ${request.boundary === 'photo-kit' ? 'Apple Photos' : 'Export folder'} (${request.destination})`,
      `Payload: ${request.mode ?? request.payload}; metadata: ${request.metadata ?? 'original'}`,
      `Include for this export: ${request.operation?.widen.join(', ') ?? ''}`,
      service.consentDetail(request),
      ...(preview.sourceSidecars ?? []).map(
        (sidecar) =>
          `Source sidecar ${JSON.stringify(sidecar.fileName)}: ${sidecar.status}` +
          (sidecar.status === 'unknown' ? '; field values unknown; any withheld export field may be present' : '') +
          `\n${JSON.stringify(sidecar.fields)}\nWithheld: ${sidecar.blocked.join(', ')}`,
      ),
      'Declining stops this export. Remove the widening or choose Baked to keep these fields private.',
    ].join('\n\n');
    return {
      service,
      request,
      preview,
      detail,
      revision: service.consentRevision(),
      context,
      binding,
      fingerprint: JSON.stringify([request, preview, detail, binding]),
    };
  }

  private context(): string {
    return JSON.stringify([this.deps.libraryId(), this.deps.authorizationEpoch()]);
  }

  private same(a: Snapshot, b: Snapshot): boolean {
    return a.service === b.service && a.context === b.context && a.fingerprint === b.fingerprint;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private prune(): void {
    const context = JSON.stringify([this.deps.libraryId(), this.deps.authorizationEpoch()]);
    const service = this.deps.getService();
    for (const [token, grant] of this.grants) {
      if (
        grant.expires <= this.now() ||
        grant.snapshot.context !== context ||
        grant.snapshot.service !== service ||
        grant.snapshot.preview.policyVersion !== service.policy().version ||
        grant.snapshot.revision !== service.consentRevision()
      )
        this.grants.delete(token);
    }
  }
}

function refuseRawWidening(disclosure: ExportDisclosureIntentWire | undefined): void {
  if ((disclosure?.operation.widen.length ?? 0) > 0) {
    throw new Error(`Disclosure consent required for: ${disclosure?.operation.widen.join(', ') ?? ''}`);
  }
}

/** Fail closed even in adapters without a configured authority. */
export async function authorizeDisclosure(
  authority: DisclosureConsentAuthority | undefined,
  request: DisclosureRunRequest,
): Promise<{
  photoIds: readonly string[] | undefined;
  disclosure: ExportDisclosureIntent | undefined;
}> {
  if (request.disclosure?.consent !== undefined) {
    if (authority === undefined) throw new Error('Disclosure consent is unavailable');
    return await authority.consume(request);
  }
  refuseRawWidening(request.disclosure);
  return { photoIds: request.photoIds, disclosure: request.disclosure };
}
