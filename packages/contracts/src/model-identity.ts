/** Confirmed provider labels for the same exact model, not inferred derivative equivalence. */
export function canonicalModelId(id: string): string {
  return id === 'fal/h3-max' ? 'minimax/h3-max' : id;
}
