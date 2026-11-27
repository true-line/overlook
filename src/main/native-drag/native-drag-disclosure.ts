import { discloses, type DisclosureField, type DisclosurePlan } from '../../shared/disclosure/policy.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { ActivityDraft } from '../activity/activity-publication.js';
import { embeddedFieldsOf } from '../disclosure/disclosure-service.js';

export class NativeDragDisclosureError extends Error {
  constructor(readonly fields: readonly DisclosureField[]) {
    super(`Original drag refused: withheld ${fields.join(', ')}. Use Export Baked.`);
  }
}

export function nativeOriginalFields(photo: PhotoRecord, plan: DisclosurePlan): readonly DisclosureField[] {
  if (plan.boundary !== 'export' || plan.destination !== 'shared' || plan.widened.length > 0)
    throw new Error('Native drag disclosure plan unavailable');
  const fields = embeddedFieldsOf(photo);
  const withheld = fields.filter((field) => !discloses(plan, field));
  if (withheld.length > 0) throw new NativeDragDisclosureError(withheld);
  return fields;
}

export function nativeDragActivity(photo: PhotoRecord, plan: DisclosurePlan): ActivityDraft {
  const fields = nativeOriginalFields(photo, plan);
  return {
    eventType: 'photo.exported',
    entityIds: [photo.id],
    outcome: 'succeeded',
    payload: {
      scope: 'native-drag',
      format: 'original',
      disclosureClass: 'shared',
      disclosureWidened: '',
      disclosureNarrowed: '',
      disclosureShared: fields
        .filter((field) => plan.decisions.some((decision) => decision.field === field && decision.class === 'shared'))
        .join(','),
      disclosurePublic: fields
        .filter((field) => plan.decisions.some((decision) => decision.field === field && decision.class === 'public'))
        .join(','),
    },
  };
}
