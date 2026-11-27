import { z } from 'zod';

import { disclosureFieldSchema } from './policy.js';

export const sourceSidecarFindingSchema = z.object({
  photoId: z.string(),
  fileName: z.string(),
  status: z.enum(['inspected', 'unknown', 'malformed', 'unavailable']),
  fields: z.array(z.object({ field: disclosureFieldSchema, values: z.array(z.string()) })),
  blocked: z.array(disclosureFieldSchema),
  refused: z.boolean(),
});
export type SourceSidecarFinding = z.output<typeof sourceSidecarFindingSchema>;

export function carriesSourceSidecars(request: {
  readonly boundary: string;
  readonly payload: string;
  readonly mode?: string | undefined;
  readonly metadata?: string | undefined;
}): boolean {
  return (
    request.boundary === 'export' &&
    request.payload === 'original' &&
    request.mode !== 'original' &&
    request.mode !== 'baked' &&
    (request.metadata ?? 'original') === 'original'
  );
}
