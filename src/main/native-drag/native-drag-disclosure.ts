import { BOUNDARY_FIELDS, discloses, type DisclosureField, type DisclosurePlan } from '../../shared/disclosure/policy.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { ActivityDraft } from '../activity/activity-publication.js';

export class NativeDragDisclosureError extends Error {
  constructor(readonly fields: readonly DisclosureField[]) {
    super(`Original drag refused: withheld ${fields.join(', ')}. Use Export Baked.`);
  }
}

export function nativeOriginalFields(plan: DisclosurePlan): readonly DisclosureField[] {
  if (plan.boundary !== 'export' || plan.destination !== 'public' || plan.widened.length > 0)
    throw new Error('Native drag disclosure plan unavailable');
  // Null extraction results do not attest that original bytes are metadata-free.
  // Preserve lazy custody by requiring permission for every potential field.
  const fields = BOUNDARY_FIELDS.export;
  const withheld = fields.filter((field) => !discloses(plan, field));
  if (withheld.length > 0) throw new NativeDragDisclosureError(withheld);
  return fields;
}

export function nativeDragActivity(photo: PhotoRecord, plan: DisclosurePlan): ActivityDraft {
  const fields = nativeOriginalFields(plan);
  return {
    eventType: 'photo.exported',
    entityIds: [photo.id],
    outcome: 'succeeded',
    payload: {
      scope: 'native-drag',
      format: 'original',
      disclosureClass: 'public',
      disclosureWidened: '',
      disclosureNarrowed: '',
      disclosurePublic: fields.join(','),
    },
  };
}
