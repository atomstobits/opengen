import { getGenerationSchema, parseGenerationRequest } from '@media-router/contracts/generation';
import type { GenerationArguments, GenerationDefinition } from '@media-router/contracts';

type Schema = Record<string, unknown>;
/** Create a small local template from the effective argument schema, never external URLs. */
function sample(schema: Schema, field: string): unknown {
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const alternatives = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (alternatives) return sample(alternatives[0]!, field);
  if (schema.type === 'object' || schema.properties) return fillObject(schema);
  if (schema.type === 'array')
    return Array.from({ length: Math.max(1, Number(schema.minItems ?? 1)) }, () =>
      sample(schema.items as Schema, field),
    );
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'boolean') return false;
  return field === 'assetKey' ? 'REPLACE_WITH_OWNED_ASSET_KEY' : 'Describe the desired result.';
}
function fillObject(schema: Schema): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const result: Record<string, unknown> = {};
  for (const [field, property] of Object.entries(properties))
    if (Object.hasOwn(property, 'default')) result[field] = property.default;
  const add = (constraint: Schema) => {
    for (const field of (constraint.required ?? []) as string[])
      if (!Object.hasOwn(result, field) && properties[field])
        result[field] = sample(properties[field], field);
    // Use one allowed branch; never combine mutually exclusive reference/frame modes.
    const alternatives = (constraint.anyOf ?? constraint.oneOf) as Schema[] | undefined;
    if (alternatives?.length) add(alternatives[0]!);
  };
  add(schema);
  for (const constraint of (schema.allOf ?? []) as Schema[]) add(constraint);
  return result;
}
export function generationExamples(definition: GenerationDefinition) {
  const schema = getGenerationSchema(definition.modelId, definition.operation)!;
  const input = fillObject(schema) as GenerationArguments;
  // The arguments-only schema cannot express this full-request continuation requirement.
  if (['video-edit', 'video-extend'].includes(definition.operation))
    input.sourceVideo = { assetKey: 'REPLACE_WITH_OWNED_ASSET_KEY' };
  const request = parseGenerationRequest({
    modelId: definition.modelId,
    operation: definition.operation,
    billing: 'managed',
    input,
  });
  const placeholders: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (value === 'REPLACE_WITH_OWNED_ASSET_KEY') placeholders.push(path);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(request.input, 'input');
  return {
    request,
    quote: { operationId: 'quotes.single' as const, input: request },
    cli: 'opengen quote --input request.json',
    placeholders,
    notices: [
      'Template only. Replace owned asset placeholders after upload prepare/PUT/complete; edit the prompt before quoting.',
      'Quote is read-only. Inspect executable routes, regional restrictions and price/budget before authorizing a separate billable submission.',
      'Managed billing is explicit in this example. Select BYOK only when the user chooses their provider account as payer; unknown direct charges cannot be capped by OpenGen.',
    ],
  };
}
