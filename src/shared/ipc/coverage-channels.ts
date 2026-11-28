import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

// Backup coverage over IPC (#506, ADR-0033 §7). Preflight is read-only and
// names everything the ceremony must disclose; exclude carries the Tier D
// authorization literal only when the plan says a provider copy is removed.

export const coverageSkipReasonSchema = z.enum([
  'not-found',
  'deleted',
  'already-excluded',
  'already-included',
  'in-flight',
  'provider-disconnected',
  'restore-failed',
  'local-missing',
  'local-corrupt',
]);

const coveragePreflightItemSchema = z.object({
  photoId: z.string(),
  bytes: z.number().nonnegative(),
  eligible: z.boolean(),
  reason: coverageSkipReasonSchema.nullable(),
  /** The provider holds a verified copy that exclusion will remove. */
  remoteCopy: z.boolean(),
  /** The original is cloud-only and must be downloaded and verified first. */
  download: z.boolean(),
  /** The remote object also backs an included sibling and stays (ADR-0033 §3). */
  sharedRetained: z.boolean(),
});

export const coveragePreflightSchema = z.object({
  /** ADR-0023 tier: irreversible whenever a provider copy would be removed. */
  tier: z.enum(['structural', 'irreversible']),
  eligible: z.number().int().nonnegative(),
  ineligible: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  remoteCopies: z.number().int().nonnegative(),
  remoteBytes: z.number().nonnegative(),
  downloads: z.number().int().nonnegative(),
  sharedRetained: z.number().int().nonnegative(),
  provider: z.string().nullable(),
  account: z.string().nullable(),
  items: z.array(coveragePreflightItemSchema).readonly(),
});

export const coverageChannels = {
  coveragePreflight: defineChannel('coverage:preflight', z.object({ photoIds: z.array(z.string()).min(1) }), coveragePreflightSchema),
  coverageExclude: defineChannel(
    'coverage:exclude',
    z.object({ photoIds: z.array(z.string()).min(1), authorization: z.string().optional() }),
    z.object({
      excluded: z.number().int().nonnegative(),
      /** Excluded, but the provider copy is still owed a removal (§6). */
      removalPending: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      results: z
        .array(
          z.object({
            photoId: z.string(),
            outcome: z.enum(['excluded', 'removal-pending', 'skipped', 'failed']),
            reason: coverageSkipReasonSchema.nullable(),
          }),
        )
        .readonly(),
    }),
  ),
  coverageInclude: defineChannel(
    'coverage:include',
    z.object({ photoIds: z.array(z.string()).min(1) }),
    z.object({
      included: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      results: z
        .array(
          z.object({
            photoId: z.string(),
            outcome: z.enum(['included', 'skipped', 'failed']),
            reason: coverageSkipReasonSchema.nullable(),
          }),
        )
        .readonly(),
    }),
  ),
} as const;
