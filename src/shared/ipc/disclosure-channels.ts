import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import {
  disclosureBoundarySchema,
  disclosureClassSchema,
  disclosureDestinationSchema,
  disclosureFieldSchema,
  disclosureOperationSchema,
  disclosureOverrideSchema,
  disclosureOverrideScopeSchema,
  disclosurePolicySchema,
} from '../disclosure/policy.js';

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

// Disclosure classes over IPC (#509, ADR-0032 §6). The renderer reads the
// policy, changes one field's class, reads and sets scope overrides, and
// asks for the PREVIEW of one crossing — field names, sample values,
// counts, what the originals carry embedded, what would need widening. The
// export and Apple Photos channels carry the same operation intent; main
// recompiles the plan from it and never accepts a field list.

export const disclosurePreviewFieldSchema = z.object({
  field: disclosureFieldSchema,
  /** The class after scope resolution; 'mixed' when photos in the selection resolve differently. */
  class: z.union([disclosureClassSchema, z.literal('mixed')]),
  /** Photos in the selection for which the field crosses. */
  disclosed: z.number().int().nonnegative(),
  withheld: z.number().int().nonnegative(),
  /** Photos that have a value for the field at all. */
  present: z.number().int().nonnegative(),
  /** One value from the selection, for the "which values" half of the preview. */
  sample: z.string().nullable(),
  widened: z.boolean(),
});

export const disclosurePreviewSchema = z.object({
  boundary: disclosureBoundarySchema,
  destination: disclosureDestinationSchema,
  policyVersion: z.number().int().positive(),
  photos: z.number().int().nonnegative(),
  fields: z.array(disclosurePreviewFieldSchema),
  /** Embedded fields (inside the original bytes) that at least one photo carries. */
  embedded: z.array(disclosureFieldSchema),
  /** Embedded fields the plan withholds for at least one photo — the crossing is refused until widened or the payload is Baked. */
  blocked: z.array(disclosureFieldSchema),
  /** Retained source sidecars that would travel unfiltered (Source metadata mode). */
  retainedSidecars: z.number().int().nonnegative(),
  /** Only present after main-owned affirmative confirmation of widening. */
  consent: z.string().uuid().optional(),
});

export const disclosurePreviewRequestSchema = z.object({
  boundary: z.enum(['export', 'photo-kit']),
  destination: disclosureDestinationSchema,
  /** Absent = every exportable photo (Export all). */
  photoIds: z.array(z.string().min(1)).max(10_000).optional(),
  /** Whether original bytes leave (embedded fields travel) — Baked strips them. */
  payload: z.enum(['original', 'baked']),
  mode: z.enum(['original', 'original-sidecars', 'baked']).optional(),
  metadata: z.enum(['original', 'overlook', 'none']).optional(),
  operation: disclosureOperationSchema.optional(),
  /** Requests main's native consent ceremony; passive previews mint nothing. */
  confirmWidening: z.boolean().optional(),
});

export const disclosureChannels = {
  disclosurePolicy: defineChannel(
    'disclosure:policy',
    z.object({}),
    z.object({ policy: disclosurePolicySchema, pinned: z.array(z.string()) }),
  ),
  disclosureSetField: defineChannel(
    'disclosure:set-field',
    z.object({ field: disclosureFieldSchema, class: disclosureClassSchema }),
    z.object({ policy: disclosurePolicySchema }),
  ),
  disclosureOverrides: defineChannel(
    'disclosure:overrides',
    z.object({ scope: disclosureOverrideScopeSchema, id: z.string().min(1) }),
    z.object({ overrides: z.array(disclosureOverrideSchema) }),
  ),
  disclosureSetOverride: defineChannel(
    'disclosure:set-override',
    z.object({
      scope: disclosureOverrideScopeSchema,
      id: z.string().min(1),
      field: disclosureFieldSchema,
      /** null clears the override at this scope. */
      class: disclosureClassSchema.nullable(),
    }),
    z.object({ overrides: z.array(disclosureOverrideSchema) }),
  ),
  disclosurePreview: defineChannel('disclosure:preview', disclosurePreviewRequestSchema, disclosurePreviewSchema),
} as const;

export type DisclosurePreview = z.output<typeof disclosurePreviewSchema>;
export type DisclosurePreviewField = z.output<typeof disclosurePreviewFieldSchema>;
export type DisclosurePreviewRequest = z.output<typeof disclosurePreviewRequestSchema>;
