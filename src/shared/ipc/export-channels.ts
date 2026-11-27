import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { boardExportIntentSchema, boardExportResultSchema } from '../moodboard/export-contract.js';
import { photoCustodyStatusSchema } from '../backup/custody-status.js';
import { disclosureDestinationSchema, disclosureOperationSchema } from '../disclosure/policy.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const metadataMode = z.enum(['original', 'overlook', 'none']);
// #497 (ADR-0031 §6): one declared payload mode; `format: 'jpeg'` stays
// accepted on the wire as Baked. `quality` applies to Baked only.
const payloadMode = z.enum(['baked', 'original-sidecars', 'original']);
const jpegQuality = z.number().int().min(1).max(100);
const authorization = z.string().uuid();
// ADR-0032 §6 (#509): the recipient class of the destination and the
// operation-scope narrowing. Widening requires main-issued consent; legacy
// raw widen lists remain parseable so main can refuse them by field name.
export const exportDisclosureIntentSchema = z
  .object({
    destination: disclosureDestinationSchema,
    operation: disclosureOperationSchema.default({ narrow: [], widen: [] }),
    consent: z.string().uuid().optional(),
  })
  .strict();
const selectedExportIntent = z.object({
  operation: z.literal('selected'),
  photoIds: z.array(z.string().min(1)).min(1),
  format: z.enum(['original', 'jpeg']).optional(),
  metadata: metadataMode.optional(),
  mode: payloadMode.optional(),
  quality: jpegQuality.optional(),
  disclosure: exportDisclosureIntentSchema.optional(),
});
const allExportIntent = z.object({
  operation: z.literal('all'),
  metadata: metadataMode.optional(),
  mode: payloadMode.optional(),
  quality: jpegQuality.optional(),
  disclosure: exportDisclosureIntentSchema.optional(),
});
const boardExportIntent = z.object({ operation: z.literal('board'), request: boardExportIntentSchema });
export const exportDestinationIntentSchema = z.discriminatedUnion('operation', [selectedExportIntent, allExportIntent, boardExportIntent]);
const result = z.object({
  exported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  previewTranscodes: z.number().int().nonnegative(),
  bakedEdits: z.number().int().nonnegative(),
  editSidecars: z.number().int().nonnegative(),
  failures: z.array(
    z.object({ photoId: z.string(), fileName: z.string(), reason: z.string(), custody: photoCustodyStatusSchema.optional() }),
  ),
});

export const exportChannels = {
  exportPickDestination: channel(
    'export:pick-destination',
    z.object({ intent: exportDestinationIntentSchema }),
    z.object({ path: z.string().nullable(), authorization: authorization.nullable() }),
  ),
  exportRevokeDestination: channel('export:revoke-destination', z.object({ authorization }), z.object({ revoked: z.boolean() })),
  exportRun: channel('export:run', selectedExportIntent.omit({ operation: true }).extend({ authorization }), result),
  exportRunAll: channel('export:run-all', allExportIntent.omit({ operation: true }).extend({ authorization }), result),
  exportRunBoard: channel('export:run-board', boardExportIntentSchema.extend({ authorization }), boardExportResultSchema),
  exportCancel: channel('export:cancel', z.object({}), z.object({})),
  /** §6 loss report: absent photoIds = every exportable photo (Export all). */
  exportPreflight: channel(
    'export:preflight',
    z.object({ photoIds: z.array(z.string().min(1)).optional(), mode: payloadMode }),
    z.object({
      edited: z.number().int().nonnegative(),
      losses: z.array(z.object({ photoId: z.string(), fileName: z.string(), reason: z.string() })),
    }),
  ),
} as const;

export type ExportPayloadMode = z.output<typeof payloadMode>;
export type ExportDisclosureIntentWire = z.output<typeof exportDisclosureIntentSchema>;

export type ExportDestinationIntent = z.output<typeof exportDestinationIntentSchema>;
