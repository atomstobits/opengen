import { z } from 'zod';

/** Named media roles are shared by discovery and the canonical request input. */
export const catalogInputRoles = [
  'firstFrame',
  'lastFrame',
  'keyframes',
  'sourceVideo',
  'references.image',
  'references.video',
  'references.audio',
  'references.document',
  'mask',
  'elements',
  'targetAudio',
] as const;
export const catalogSearchFiltersSchema = z
  .object({
    modality: z.enum(['image', 'video']).optional(),
    familyId: z.string().min(1).max(160).optional(),
    providerId: z.string().min(1).max(160).optional(),
    region: z.string().min(1).max(160).optional(),
    operation: z
      .enum([
        'text-to-image',
        'image-edit',
        'text-to-video',
        'image-to-video',
        'reference-to-video',
        'video-edit',
        'video-extend',
      ])
      .optional(),
    inputRole: z.enum(catalogInputRoles).optional(),
  })
  .strict();
export const catalogSearchQuerySchema = catalogSearchFiltersSchema
  .extend({
    q: z.string().max(200).default(''),
  })
  .strict();
export type CatalogSearchFilters = z.infer<typeof catalogSearchFiltersSchema>;
