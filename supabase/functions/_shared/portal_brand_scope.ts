import { z } from 'zod';

// Database contract: 489402c6d118be4202cef22f9b89266c9229ed76,
// contracts/portal/portal.common-types.v2.schema.json.
export const portalBrandCodeSchema = z.enum(['tiangong_lca', 'bafu', 'uslci', 'worldsteel']);
export type PortalBrandCode = z.infer<typeof portalBrandCodeSchema>;

/** Signed BFF wire scope: already canonical, never inferred from caller filters. */
export const portalAllowedBrandCodesSchema = z
  .array(portalBrandCodeSchema)
  .min(1)
  .max(4)
  .refine(
    (codes) =>
      new Set(codes).size === codes.length && codes.join(',') === [...codes].sort().join(','),
    'allowedBrandCodes must be unique and sorted',
  );

export function portalBrandScopeIdentity(codes: unknown): string {
  return `portal-display-scope.v1:${portalAllowedBrandCodesSchema.parse(codes).join(',')}`;
}
