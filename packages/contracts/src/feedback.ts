import { z } from 'zod';

/** Explicitly reviewed text only. These checks catch common accidental pastes;
 * they cannot prove that arbitrary prose contains no private information. */
export const feedbackInputSchema = z
  .object({
    kind: z.enum(['feedback', 'catalog-request']),
    category: z.enum(['quality', 'pricing', 'setup', 'missing-model', 'missing-route', 'other']),
    summary: z.string().trim().min(8).max(1000),
    modelId: z.string().min(1).max(160).optional(),
    routeId: z.string().min(1).max(240).optional(),
    jobId: z.uuid().optional(),
    reviewedForPrivacy: z.literal(true),
  })
  .strict();
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

export function containsPrivatePaste(summary: string): boolean {
  return /https?:\/\/|data:|\bBearer\s|\b(?:sk|og_sk|og_mcp|og_key)[-_][a-z0-9_-]{8,}|-----BEGIN|\b(?:password|api[_ -]?key|authorization|cookie|prompt)\s*[:=]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\n\s*(?:at\s|\{|\[)/i.test(
    summary,
  );
}
