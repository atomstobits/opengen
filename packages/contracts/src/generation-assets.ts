import type {
  AssetRef,
  GenerationArguments,
  GenerationElement,
  GenerationIssue,
  ReferenceType,
} from './generation-types';
export interface GenerationAsset {
  asset: AssetRef;
  path: string;
  type: ReferenceType;
}
export function assetUrl(asset: AssetRef): string {
  if ('url' in asset && asset.url) return asset.url;
  throw new Error('An owned asset must be resolved before a provider request.');
}
export function assertHandledArguments(
  input: GenerationArguments,
  handled: readonly string[],
): GenerationIssue[] {
  const allowed = new Set(handled);
  return Object.keys(input)
    .filter((key) => input[key as keyof GenerationArguments] !== undefined && !allowed.has(key))
    .map((field) => ({
      code: 'unsupported_argument',
      field: `input.${field}`,
      message: `This provider route does not implement ${field}.`,
    }));
}
/** This visitor enumerates only typed media roles, never arbitrary objects with a URL-like property. */
function transformAssets(
  input: GenerationArguments,
  map: (asset: AssetRef, context: Omit<GenerationAsset, 'asset'>) => AssetRef,
): GenerationArguments {
  const result = { ...input };
  for (const [name, type] of [
    ['firstFrame', 'image'],
    ['lastFrame', 'image'],
    ['mask', 'image'],
    ['sourceVideo', 'video'],
    ['targetAudio', 'audio'],
  ] as const) {
    const asset = input[name];
    if (asset) result[name] = map(asset, { path: name, type });
  }
  if (input.references)
    result.references = input.references.map((ref, index) => ({
      ...ref,
      asset: map(ref.asset, { path: `references[${index}].asset`, type: ref.type }),
    }));
  if (input.keyframes)
    result.keyframes = input.keyframes.map((frame, index) => ({
      ...frame,
      image: map(frame.image, { path: `keyframes[${index}].image`, type: 'image' }),
    }));
  if (input.elements)
    result.elements = input.elements.map((element, index): GenerationElement => {
      const common = {
        id: element.id,
        ...(element.description === undefined ? {} : { description: element.description }),
        ...(element.voice
          ? { voice: map(element.voice, { path: `elements[${index}].voice`, type: 'audio' }) }
          : {}),
      };
      if (element.images !== undefined)
        return {
          ...common,
          images: element.images.map((image, imageIndex) =>
            map(image, { path: `elements[${index}].images[${imageIndex}]`, type: 'image' }),
          ),
        };
      return {
        ...common,
        video: map(element.video, { path: `elements[${index}].video`, type: 'video' }),
      };
    });
  return result;
}
export function collectGenerationAssets(input: GenerationArguments): GenerationAsset[] {
  const result: GenerationAsset[] = [];
  transformAssets(input, (asset, context) => {
    result.push({ asset, ...context });
    return asset;
  });
  return result;
}
/** Resolve each semantic position independently, preserving mixed owned/external ordering. */
export async function mapGenerationAssets(
  input: GenerationArguments,
  map: (asset: AssetRef, context: Omit<GenerationAsset, 'asset'>) => Promise<AssetRef>,
): Promise<GenerationArguments> {
  const resolved = new Map(
    await Promise.all(
      collectGenerationAssets(input).map(
        async ({ asset, ...context }) => [context.path, await map(asset, context)] as const,
      ),
    ),
  );
  return transformAssets(input, (_asset, context) => resolved.get(context.path)!);
}
