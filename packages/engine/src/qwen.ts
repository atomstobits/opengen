import type { GenerationArguments } from '@media-router/contracts';
import {
  alibabaCredentials,
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  isPublicHttpsAssetUrl,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';

const models = new Set(['qwen-image-2.1-turbo', 'qwen-image-2.1-pro', 'qwen-image-3.0-pro']);
export const isQwenImageModel = (model: string) => models.has(model);

function size(resolution: string, ratio = '1:1'): string | null {
  const tier = resolution.toUpperCase();
  if (!['1K', '2K'].includes(tier)) return null;
  const edge = tier === '2K' ? 2048 : 1024;
  const dimensions: Record<string, [number, number]> = {
    '1:1': [edge, edge],
    '4:3': [edge, (edge * 3) / 4],
    '3:4': [(edge * 3) / 4, edge],
    '16:9': tier === '1K' ? [1280, 720] : [2048, 1152],
    '9:16': tier === '1K' ? [720, 1280] : [1152, 2048],
  };
  const pair = dimensions[ratio];
  return pair ? `${pair[0]}*${pair[1]}` : null;
}

const alibabaRegions = new Set([
  'cn-beijing',
  'ap-southeast-1',
  'ap-northeast-1',
  'eu-central-1',
  'us-east-1',
  'cn-hongkong',
]);

/** All six Alibaba Cloud Model Studio regions document Qwen Image 2.1 Turbo/Pro and 3.0 Pro via regional workspace MaAS endpoints. */
export function createQwenImageAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'negativePrompt',
    'resolution',
    'size',
    'aspectRatio',
    'references',
    'count',
    'seed',
    'promptExtend',
    'thinking',
    'watermark',
  ];
  function dimensions(args: GenerationArguments): string | null {
    if (!args.size)
      return args.aspectRatio === 'source' ? null : size(args.resolution ?? '', args.aspectRatio);
    const { width, height } = args.size;
    return Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 512 &&
      height >= 512 &&
      width <= 4096 &&
      height <= 4096 &&
      width % 16 === 0 &&
      height % 16 === 0 &&
      width / height >= 1 / 8 &&
      width / height <= 8 &&
      width * height >= 262144 &&
      width * height <= 4194304
      ? `${width}*${height}`
      : null;
  }
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { deployment, route, input } = context;
    if (
      deployment.providerId !== 'alibaba' ||
      !alibabaRegions.has(deployment.endpointRegion) ||
      deployment.id !== `alibaba-model-studio-${deployment.endpointRegion}` ||
      !models.has(route.upstreamModelId)
    )
      return 'This Qwen adapter executes qualified Alibaba Model Studio regional routes only.';
    if (!['text-to-image', 'image-edit'].includes(input.operation))
      return 'Qwen image routes support text-to-image and image edits only.';
    const args = input.input;
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(input);
    if (issue) return issue;
    if (args.count !== undefined && args.count !== 1)
      return 'This Qwen adapter returns one image per task.';
    if (args.thinking === true && args.promptExtend !== true)
      return 'Qwen thinking requires promptExtend=true.';
    if (!dimensions(args)) return 'Unsupported exact Qwen image dimensions.';
    const references = referenceUrls(input);
    const maximum = route.upstreamModelId.startsWith('qwen-image-3.') ? 3 : 10;
    if (references.some((url) => !isPublicHttpsAssetUrl(url)))
      return 'Qwen reference images must use public HTTPS URLs without embedded credentials.';
    if (input.operation === 'text-to-image' && references.length)
      return 'Text-to-image does not accept reference assets.';
    if (input.operation === 'image-edit' && (references.length < 1 || references.length > maximum))
      return `The selected Qwen variant supports 1–${maximum} reference images.`;
    return null;
  }
  function auth(context: AdapterContext) {
    const credentials = alibabaCredentials(context.deployment, env);
    if (!credentials)
      throw new SubmissionRejected(
        `Configure matching Alibaba ${context.deployment.endpointRegion} credentials and workspace.`,
      );
    return {
      base: `https://${credentials.workspaceId}.${context.deployment.endpointRegion}.maas.aliyuncs.com/api/v1`,
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
    };
  }
  return {
    id: 'alibaba',
    supportedOperations: ['text-to-image', 'image-edit'],
    inputFields: () => fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'alibaba' &&
      deployment.providerId === 'alibaba' &&
      alibabaRegions.has(deployment.endpointRegion) &&
      deployment.id === `alibaba-model-studio-${deployment.endpointRegion}` &&
      models.has(route.upstreamModelId) &&
      alibabaCredentials(deployment, env) !== null,
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const credentials = auth(context);
      const body = await submitProviderJson(
        request,
        'Alibaba Qwen',
        `${credentials.base}/services/aigc/image-generation/generation`,
        { ...credentials.headers, 'X-DashScope-Async': 'enable' },
        {
          model: route.upstreamModelId,
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  ...referenceUrls(input).map((url) => ({ image: url })),
                  { text: input.input.prompt },
                ],
              },
            ],
          },
          parameters: {
            n: 1,
            size: dimensions(input.input),
            watermark: input.input.watermark ?? true,
            prompt_extend: input.input.promptExtend ?? false,
            enable_thinking: input.input.thinking ?? false,
            ...(input.input.seed !== undefined ? { seed: input.input.seed } : {}),
            ...(input.input.negativePrompt !== undefined
              ? { negative_prompt: input.input.negativePrompt }
              : {}),
          },
        },
      );
      const output = providerObject(body.output);
      if (typeof output.task_id !== 'string' || !output.task_id) throw new SubmissionUnknown();
      return { upstreamId: output.task_id };
    },
    async poll(context) {
      const credentials = auth(context);
      const body = await pollProviderJson(
        request,
        'Alibaba Qwen',
        `${credentials.base}/tasks/${encodeURIComponent(context.upstreamId)}`,
        credentials.headers,
      );
      const output = providerObject(body.output);
      if (output.task_status === 'PENDING' || output.task_status === 'RUNNING')
        return { status: 'running' };
      if (output.task_status === 'UNKNOWN')
        return {
          status: 'unknown',
          error: 'Qwen task cannot be resolved; billing requires reconciliation.',
        };
      if (output.task_status === 'FAILED' || output.task_status === 'CANCELED')
        return {
          status: output.task_status === 'CANCELED' ? 'cancelled' : 'failed',
          failureCategory: 'unknown',
          error: 'Qwen ended this task without a delivered image. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      const choices = Array.isArray(output.choices) ? output.choices : [];
      const message =
        choices.length === 1 ? providerObject(providerObject(choices[0]).message) : {};
      const content = Array.isArray(message.content)
        ? message.content.map(providerObject).filter((item) => typeof item.image === 'string')
        : [];
      const image = content[0]?.image;
      if (
        output.task_status !== 'SUCCEEDED' ||
        content.length !== 1 ||
        typeof image !== 'string' ||
        !isPublicHttpsAssetUrl(image)
      )
        throw new Error('Qwen has not returned the expected single image output.');
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ url: image, mediaType: 'image/png', fidelity: 'unverified' }],
      };
    },
  };
}
