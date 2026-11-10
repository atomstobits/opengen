import type { GenerationArguments, Operation, Route } from '@media-router/contracts';
import {
  generationArgumentSchema,
  getGenerationDefinition,
  getGenerationSchema,
} from '@media-router/contracts/generation';

export type ArgumentName = keyof GenerationArguments;
export type FieldSchema = Record<string, unknown>;
export type PlaygroundField = {
  name: ArgumentName;
  schema: FieldSchema;
  required: boolean;
  advanced: boolean;
  choices?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
};

const primary = new Set<ArgumentName>([
  'prompt',
  'firstFrame',
  'lastFrame',
  'sourceVideo',
  'references',
  'mask',
  'resolution',
  'duration',
  'aspectRatio',
  'count',
  'audio',
]);

/** Use the effective model/operation schema; optional controls never add an argument by themselves. */
export function getPlaygroundFields(modelId: string, operation: Operation, route?: Route) {
  const definition = getGenerationDefinition(modelId, operation);
  const schema = getGenerationSchema(modelId, operation);
  if (!definition || !schema) return [];
  const required = new Set(schema.required as string[]);
  const properties = schema.properties as Record<ArgumentName, FieldSchema>;
  const caps = definition.capabilities;
  return Object.entries(properties).map(([key, schema]): PlaygroundField => {
    const name = key as ArgumentName;
    const field: PlaygroundField = {
      name,
      schema,
      required: required.has(name),
      advanced: !primary.has(name),
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
      ...(Array.isArray(schema.enum) ? { choices: schema.enum } : {}),
    };
    if (name === 'resolution')
      field.choices = caps.resolutions.filter(
        (value) => !route || route.resolutions.includes(value),
      );
    if (name === 'aspectRatio') field.choices = caps.aspectRatios;
    if (name === 'quality' && caps.quality) field.choices = caps.quality;
    if (name === 'count') field.maximum = caps.countMaximum;
    if (name === 'prompt' && definition.promptMaximum !== null)
      field.schema = { ...schema, maxLength: definition.promptMaximum };
    if (name === 'duration' && caps.duration) {
      field.minimum = caps.duration.minimum;
      field.maximum = caps.duration.maximum;
      // fal H3 Max accepts the documented continuous range; its route duration list is not exhaustive.
      const falMax = modelId === 'minimax/h3-max' && route?.adapter === 'fal';
      if (route && !falMax)
        field.choices = [
          ...route.durations.filter(
            (value) => value >= caps.duration!.minimum && value <= caps.duration!.maximum,
          ),
          ...(caps.duration.auto ? ['auto'] : []),
        ];
    }
    if (schema.type === 'boolean') field.choices = [true, false];
    if (name === 'audio')
      field.choices =
        caps.audio === 'switchable' ? [true, false] : caps.audio === 'always-on' ? [true] : [];
    if (name === 'promptExpansion') {
      // The shared union includes booleans and tiers; keep the actual JSON types in the request.
      field.choices = [true, false, 'disabled', 'none', 'balanced', 'quality'];
    }
    return field;
  });
}

/** Compound field edits commit one complete canonical value, preserving the previous value on failure. */
export function parseStructuredArgument(name: ArgumentName, text: string): unknown {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Enter valid JSON. Your last applied value is unchanged.');
  }
  const result = generationArgumentSchema.safeParse({ [name]: value });
  if (!result.success)
    throw new Error(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  return result.data[name];
}
