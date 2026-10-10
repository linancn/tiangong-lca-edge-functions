import { z } from 'zod';

import { portalAllowedBrandCodesSchema, portalBrandCodeSchema } from './portal_brand_scope.ts';
import {
  portalHybridFiltersSchema,
  portalHybridSearchRequestV2Schema,
} from './portal_hybrid_contract.ts';

// Opt-in successor. Kept separate from the live V1/V2 union until the matching
// scoped repository and cursor/cache path are ready; no unscoped fallback.
export const portalHybridSearchRequestV3Schema = z
  .strictObject({
    ...portalHybridSearchRequestV2Schema.shape,
    schemaVersion: z.literal('portal.hybrid-search-request.v3'),
    allowedBrandCodes: portalAllowedBrandCodesSchema,
    filters: portalHybridFiltersSchema.safeExtend({ brand: portalBrandCodeSchema.optional() }),
  })
  .superRefine((value, context) => {
    if (value.kind === 'flow' && value.filters.processSubtype !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'processSubtype is not valid for Flow search',
        path: ['filters', 'processSubtype'],
      });
    }
  });

export type PortalHybridSearchRequestV3 = z.infer<typeof portalHybridSearchRequestV3Schema>;
