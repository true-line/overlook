import { defineMessages, type IntlShape } from 'react-intl';

import type { DisclosureClass, DisclosureField } from '../../../shared/disclosure/policy.js';

// Copy for disclosure classes (#509, ADR-0032 §6), shared by the Settings
// section and the pre-crossing preview.

export const disclosureMessages = defineMessages({
  heading: { id: 'disclosure.heading', defaultMessage: 'Disclosure' },
  hint: {
    id: 'disclosure.hint',
    defaultMessage:
      'What each field may leave the library as. Private never leaves; Shared may go to a named recipient (a folder you choose, Apple Photos, a keyed provider); Public may go to an unauthenticated destination. Local search and filtering never need a field to be shared.',
  },
  pinned: { id: 'disclosure.pinned', defaultMessage: 'Always private' },
  pinnedHint: {
    id: 'disclosure.pinned.hint',
    defaultMessage: 'These never cross any boundary and no setting can change that.',
  },
  classPrivate: { id: 'disclosure.class.private', defaultMessage: 'Private' },
  classShared: { id: 'disclosure.class.shared', defaultMessage: 'Shared' },
  classPublic: { id: 'disclosure.class.public', defaultMessage: 'Public' },
  classMixed: { id: 'disclosure.class.mixed', defaultMessage: 'Mixed' },
  fieldTitle: { id: 'disclosure.field.title', defaultMessage: 'Title' },
  fieldDescription: { id: 'disclosure.field.description', defaultMessage: 'Description' },
  fieldTags: { id: 'disclosure.field.tags', defaultMessage: 'Tags' },
  fieldCaptureTime: { id: 'disclosure.field.captureTime', defaultMessage: 'Capture time' },
  fieldCamera: { id: 'disclosure.field.camera', defaultMessage: 'Camera' },
  fieldLens: { id: 'disclosure.field.lens', defaultMessage: 'Lens' },
  fieldProvenance: { id: 'disclosure.field.provenance', defaultMessage: 'Provenance evidence' },
  fieldLocation: { id: 'disclosure.field.location', defaultMessage: 'Precise location' },
  fieldRatings: { id: 'disclosure.field.ratings', defaultMessage: 'Ratings' },
  fieldFaces: { id: 'disclosure.field.faces', defaultMessage: 'Face data' },
  fieldComments: { id: 'disclosure.field.comments', defaultMessage: 'Comments' },
  classFor: { id: 'disclosure.classFor', defaultMessage: 'Disclosure class for {field}' },
  previewHeading: { id: 'disclosure.preview.heading', defaultMessage: 'What leaves' },
  previewDestination: { id: 'disclosure.preview.destination.label', defaultMessage: 'Destination' },
  previewDestinationShared: { id: 'disclosure.preview.destination.shared', defaultMessage: 'Named recipient' },
  previewDestinationPublic: { id: 'disclosure.preview.destination.public', defaultMessage: 'Public' },
  previewDestinationSharedHint: {
    id: 'disclosure.preview.destination.shared.hint',
    defaultMessage: 'A folder you choose, Apple Photos, or a keyed provider. Shared and Public fields cross.',
  },
  previewDestinationPublicHint: {
    id: 'disclosure.preview.destination.public.hint',
    defaultMessage: 'Anyone with the link or address. Only Public fields cross.',
  },
  previewCrosses: {
    id: 'disclosure.preview.crosses',
    defaultMessage: '{disclosed, plural, one {# photo} other {# photos}} of {present}',
  },
  previewWithheld: { id: 'disclosure.preview.withheld', defaultMessage: 'Withheld' },
  previewLoading: { id: 'disclosure.preview.loading', defaultMessage: 'Checking what would leave…' },
  previewNothing: { id: 'disclosure.preview.nothing', defaultMessage: 'No classified metadata is present in this selection.' },
  previewEmbedded: {
    id: 'disclosure.preview.embedded',
    defaultMessage: 'Embedded in the original bytes and cannot be filtered: {fields}.',
  },
  previewBlocked: {
    id: 'disclosure.preview.blocked',
    defaultMessage:
      'This export cannot leave while an original or retained source sidecar contains a withheld field. Include it for this export, choose Metadata: Edits or None to omit source sidecars, or export Baked.',
  },
  previewBlockedAnnounce: {
    id: 'disclosure.preview.blocked.announce',
    defaultMessage:
      '{count, plural, one {The originals can’t leave while {fields} is withheld.} other {The originals can’t leave while {fields} are withheld.}}',
  },
  previewWiden: { id: 'disclosure.preview.widen', defaultMessage: 'Include {field} in this export (recorded in activity)' },
  previewSidecars: {
    id: 'disclosure.preview.sidecars',
    defaultMessage: '{count, plural, one {# retained source sidecar checked} other {# retained source sidecars checked}}.',
  },
  sidecarFound: { id: 'disclosure.sidecar.found', defaultMessage: 'Found: {fields}.' },
  sidecarEmpty: { id: 'disclosure.sidecar.empty', defaultMessage: 'No supported disclosure fields found.' },
  sidecarWithheld: { id: 'disclosure.sidecar.withheld', defaultMessage: 'Withheld: {fields}.' },
  sidecarUnknown: {
    id: 'disclosure.sidecar.unknown',
    defaultMessage: 'Unknown format. Any withheld field may be present; its values cannot be inspected.',
  },
  sidecarMalformed: {
    id: 'disclosure.sidecar.malformed',
    defaultMessage: 'Malformed or oversized source sidecar. Choose Metadata: Edits or None to omit it.',
  },
  sidecarUnavailable: {
    id: 'disclosure.sidecar.unavailable',
    defaultMessage: 'Sidecar could not be read or verified. Choose Metadata: Edits or None to omit it.',
  },
  sidecarBudget: {
    id: 'disclosure.sidecar.budget',
    defaultMessage: 'This selection is too large to inspect. Select fewer photos or choose Metadata: Edits or None.',
  },
  previewDecline: {
    id: 'disclosure.preview.decline',
    defaultMessage: 'Cancel leaves the library unchanged; nothing has crossed yet.',
  },
});

const FIELD_LABELS = {
  title: disclosureMessages.fieldTitle,
  description: disclosureMessages.fieldDescription,
  tags: disclosureMessages.fieldTags,
  captureTime: disclosureMessages.fieldCaptureTime,
  camera: disclosureMessages.fieldCamera,
  lens: disclosureMessages.fieldLens,
  provenance: disclosureMessages.fieldProvenance,
  location: disclosureMessages.fieldLocation,
  ratings: disclosureMessages.fieldRatings,
  faces: disclosureMessages.fieldFaces,
  comments: disclosureMessages.fieldComments,
} as const;

const CLASS_LABELS = {
  private: disclosureMessages.classPrivate,
  shared: disclosureMessages.classShared,
  public: disclosureMessages.classPublic,
  mixed: disclosureMessages.classMixed,
} as const;

export function fieldLabel(intl: IntlShape, field: DisclosureField): string {
  return intl.formatMessage(FIELD_LABELS[field]);
}

export function classLabel(intl: IntlShape, cls: DisclosureClass | 'mixed'): string {
  return intl.formatMessage(CLASS_LABELS[cls]);
}
