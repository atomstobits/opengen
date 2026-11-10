import {
  adapterInputIssue,
  referenceTypeIssue,
  referenceUrls,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { detectedMediaType, readPublicAsset, outputLimitBytes } from './output.js';
import type { GenerationArguments } from '@media-router/contracts';
import type { StoreProviderImage } from './openai.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';
import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';

const model = 'gemini-nano-banana-2.1';
const ratios = new Set([
  '1:1',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
]);

/** Store the interaction ID before retrieving the generated image, so polling remains restartable. */
export function createGoogleImageAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storeOutput?: StoreProviderImage;
    captureOutputs?: CaptureProviderOutputs;
    readAsset?: typeof readPublicAsset;
  } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'references',
    'resolution',
    'aspectRatio',
    'count',
    'outputFormat',
    'seed',
    'thinkingLevel',
    'systemPrompt',
    'grounding',
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (context.deployment.providerId !== 'google' || context.route.upstreamModelId !== model)
      return 'This adapter supports Gemini Nano Banana 2.1 only.';
    if (!['text-to-image', 'image-edit'].includes(context.input.operation))
      return 'This Google adapter supports text-to-image and image editing only.';
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(context.input);
    if (issue) return issue;
    const args = context.input.input;
    const references = referenceUrls(context.input);
    if (context.input.previousJobId || context.previousUpstreamId)
      return 'Owned Nano Banana multi-turn continuation is not implemented by this adapter.';
    if (context.input.operation === 'text-to-image' && references.length)
      return 'Text-to-image does not accept references.';
    if (
      context.input.operation === 'image-edit' &&
      (references.length < 1 || references.length > 14)
    )
      return 'Nano Banana edits require 1–14 reference images.';
    if (!['1K', '2K', '4K'].includes((args.resolution ?? '').toUpperCase()))
      return 'Unsupported Nano Banana output size.';
    if (args.aspectRatio === 'source' && references.length !== 1)
      return 'Source ratio requires exactly one source image on this Google adapter.';
    if (args.aspectRatio && args.aspectRatio !== 'source' && !ratios.has(args.aspectRatio))
      return 'Unsupported Nano Banana aspect ratio.';
    if (args.count !== undefined && args.count !== 1)
      return 'This Google adapter produces one image; prompt-requested counts are not guaranteed.';
    if (args.outputFormat && !['png', 'jpeg'].includes(args.outputFormat))
      return 'This Google adapter supports documented PNG and JPEG output only.';
    if (args.grounding)
      return 'Google Search grounding requires downstream citation delivery, which is not implemented by this adapter.';
    return null;
  }
  function auth() {
    const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!key || !(options.captureOutputs || options.storeOutput))
      throw new SubmissionRejected('Configure GEMINI_API_KEY and a private output store.');
    return { 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' };
  }
  return {
    id: 'google',
    supportedOperations: ['text-to-image', 'image-edit'],
    preflight,
    inputFields: () => fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'google' &&
      deployment.providerId === 'google' &&
      route.upstreamModelId === model &&
      Boolean(
        (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) &&
        (options.captureOutputs || options.storeOutput),
      ),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const references: Record<string, string>[] = [];
      let total = 0;
      for (const url of referenceUrls(context.input)) {
        try {
          const asset = await (options.readAsset ?? readPublicAsset)(url, {
            maxBytes: 20 * 1024 * 1024,
          });
          total += asset.bytes.length;
          if (
            total > 20 * 1024 * 1024 ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)
          )
            throw new Error('Unsupported reference type or size.');
          references.push({
            type: 'image',
            mime_type: asset.mediaType,
            data: asset.bytes.toString('base64'),
          });
        } catch {
          throw new SubmissionRejected(
            'A Nano Banana reference could not be read safely within the 20 MiB total limit. No provider generation was submitted.',
          );
        }
      }
      const args = context.input.input;
      const body = await submitProviderJson(
        request,
        'Google',
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        auth(),
        {
          model,
          input: [{ type: 'text', text: args.prompt ?? '' }, ...references],
          ...(args.systemPrompt !== undefined ? { system_instruction: args.systemPrompt } : {}),
          ...(args.seed !== undefined || args.thinkingLevel !== undefined
            ? {
                generation_config: {
                  ...(args.seed !== undefined ? { seed: args.seed } : {}),
                  ...(args.thinkingLevel !== undefined
                    ? { thinking_level: args.thinkingLevel }
                    : {}),
                },
              }
            : {}),
          ...(args.grounding === false ? { tools: [] } : {}),
          store: true,
          response_format: {
            type: 'image',
            mime_type: args.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
            image_size: (args.resolution ?? '').toUpperCase(),
            ...(args.aspectRatio && args.aspectRatio !== 'source'
              ? { aspect_ratio: args.aspectRatio }
              : {}),
          },
        },
        { timeoutMs: 90_000, maxBytes: 32_000_000 },
      );
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Google',
        `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(context.upstreamId)}`,
        auth(),
        32_000_000,
      );
      if (body.status === 'in_progress') return { status: 'running' };
      if (body.status === 'failed' || body.status === 'cancelled')
        return {
          status: body.status,
          failureCategory: 'unknown',
          error:
            'Google ended this interaction without a delivered image. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      if (body.status !== 'completed') throw new Error('Unrecognized Google interaction status.');
      const images = (Array.isArray(body.steps) ? body.steps : []).flatMap((value) => {
        const step = providerObject(value);
        return step.type === 'model_output' && Array.isArray(step.content)
          ? step.content.map(providerObject).filter((block) => block.type === 'image')
          : [];
      });
      const image = images[0];
      const expectedType = context.input.input.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
      if (
        images.length !== 1 ||
        image?.mime_type !== expectedType ||
        typeof image.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
        image.data.length % 4 !== 0
      )
        throw new Error('Google has not returned the requested single image format.');
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.byteLength > outputLimitBytes || detectedMediaType(bytes) !== expectedType)
        throw new Error('Google output did not match the requested image format.');
      if (options.captureOutputs)
        return captureProviderResult(options.captureOutputs, context, [
          { kind: 'inline', bytes, mediaType: expectedType },
        ]);
      const asset = await options.storeOutput!({
        jobId: context.jobId,
        bytes,
        mediaType: expectedType,
      });
      const url = new URL(asset.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid store URL.');
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ ...asset, mediaType: expectedType, fidelity: 'unverified' }],
      };
    },
  };
}
