import { z } from 'zod';

export const teamCreateSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const memberInviteSchema = z
  .object({
    issuer: z
      .url()
      .max(500)
      .refine(
        (value) =>
          new URL(value).protocol === 'https:' &&
          !new URL(value).username &&
          !new URL(value).password &&
          !new URL(value).hash &&
          !new URL(value).search,
        'Issuer must use HTTPS',
      ),
    subject: z.string().min(1).max(512),
    role: z.enum(['admin', 'member']),
  })
  .strict();
export const memberRoleSchema = z.object({ role: z.enum(['admin', 'member']) }).strict();
export const sessionWorkspaceSchema = z
  .object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) })
  .strict();
