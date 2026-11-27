import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { disclosureFieldSchema } from '../disclosure/policy.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const unavailableReason = z.enum([
  'unsupported-platform',
  'unsigned-build',
  'native-unavailable',
  'disabled',
  'content-unavailable',
  'disclosure-withheld',
]);

export const nativeDragChannels = {
  nativeDragStatus: channel('native-drag:status', z.object({}), z.object({ available: z.boolean(), reason: unavailableReason.nullable() })),
  nativeDragStart: channel(
    'native-drag:start',
    z
      .object({
        photoIds: z.array(z.string().min(1)).min(1).max(100),
        sourceAlbumId: z.string().min(1).nullable(),
      })
      .strict(),
    z.object({ started: z.boolean(), reason: unavailableReason.nullable(), withheld: z.array(disclosureFieldSchema).optional() }),
  ),
} as const;
