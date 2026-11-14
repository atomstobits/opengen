import type {
  Catalog,
  Deployment,
  Model,
  Operation,
  Provider,
  Rate,
  Route,
  Source,
} from '@media-router/contracts';
import { publishedPricingFor } from './published-pricing';

const checkedAt = '2026-11-02';
const source = (url: string, note?: string): Source => ({
  url,
  checkedAt,
  ...(note ? { note } : {}),
});
const unknownPrice = (url: string) =>
  source(
    url,
    'No request-price formula has been qualified for this route. A catalog listing is not a live verification.',
  );

const providers: Provider[] = [
  { id: 'alibaba', name: 'Alibaba Cloud', website: 'https://www.alibabacloud.com/' },
  { id: 'byteplus', name: 'BytePlus', website: 'https://www.byteplus.com/' },
  { id: 'kling', name: 'Kling AI', website: 'https://kling.ai/dev' },
  { id: 'minimax', name: 'MiniMax', website: 'https://platform.minimax.io/' },
  { id: 'fal', name: 'fal', website: 'https://fal.ai/' },
  { id: 'pika', name: 'Pika', website: 'https://dev.pika.art/' },
  { id: 'runway', name: 'Runway', website: 'https://dev.runwayml.com/' },
  { id: 'replicate', name: 'Replicate', website: 'https://replicate.com/' },
  { id: 'google', name: 'Google', website: 'https://ai.google.dev/' },
  { id: 'openai', name: 'OpenAI', website: 'https://developers.openai.com/' },
  { id: 'xai', name: 'xAI', website: 'https://docs.x.ai/' },
  { id: 'bfl', name: 'Black Forest Labs', website: 'https://docs.bfl.ai/' },
];

// Explicit author/service relationships, including BytePlus and the Qwen parent brand.
const modelAuthors = {
  ByteDance: ['byteplus'],
  'Kling AI': ['kling'],
  Alibaba: ['alibaba'],
  Qwen: ['alibaba'],
  MiniMax: ['minimax'],
  fal: ['fal'],
  Pika: ['pika'],
  Google: ['google'],
  xAI: ['xai'],
  OpenAI: ['openai'],
  'Black Forest Labs': ['bfl'],
} as const;

const wanGuide = 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference';
const wanStandard = 'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video';
const wanPrime = 'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video-prime';
const regionalDefinitions: Array<{ code: string; name: string; scope: Deployment['scope'] }> = [
  { code: 'cn-beijing', name: 'Beijing', scope: 'mainland-china' },
  { code: 'ap-southeast-1', name: 'Singapore', scope: 'international' },
  { code: 'ap-northeast-1', name: 'Tokyo', scope: 'global' },
  { code: 'eu-central-1', name: 'Frankfurt', scope: 'global' },
  { code: 'us-east-1', name: 'Virginia', scope: 'global' },
  { code: 'cn-hongkong', name: 'Hong Kong', scope: 'global' },
];

const deployments: Deployment[] = regionalDefinitions.map(({ code, name, scope }) => ({
  id: `alibaba-model-studio-${code}`,
  providerId: 'alibaba',
  name: `Model Studio · ${name}`,
  endpointRegion: code,
  scope,
  processingRegions: null,
  storageRegions: null,
  endpointTemplate: `https://{workspaceId}.${code}.maas.aliyuncs.com/api/v1`,
  credentialEnv: `ALIBABA_${code.toUpperCase().replaceAll('-', '_')}_API_KEY`,
  source: source(
    wanGuide,
    'Endpoint region and deployment scope are documented. Neither establishes a per-request inference location. API key, workspace, endpoint and model access must match this region.',
  ),
}));

deployments.push({
  id: 'byteplus-modelark-ap-southeast-1',
  providerId: 'byteplus',
  name: 'ModelArk · Singapore',
  endpointRegion: 'ap-southeast-1',
  scope: 'undisclosed',
  processingRegions: null,
  storageRegions: null,
  endpointTemplate: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  credentialEnv: 'BYTEPLUS_API_KEY',
  source: source(
    'https://console.byteplus.com/ark/region%3Aap-southeast-1/docs/model-pricing',
    'Singapore API offering. Processing and storage commitments have not been qualified; the API region is not a residency assertion.',
  ),
});

const providerEndpoints: Record<string, { endpoint: string; credential: string }> = {
  fal: { endpoint: 'https://queue.fal.run', credential: 'FAL_KEY' },
  runway: { endpoint: 'https://api.dev.runwayml.com/v1', credential: 'RUNWAYML_API_SECRET' },
  pika: { endpoint: 'https://api.dev.pika.art/v1/media', credential: 'PIKA_API_KEY' },
  replicate: { endpoint: 'https://api.replicate.com/v1', credential: 'REPLICATE_API_TOKEN' },
  minimax: { endpoint: 'https://api.minimax.io/v2', credential: 'MINIMAX_API_KEY' },
  openai: { endpoint: 'https://api.openai.com/v1', credential: 'OPENAI_API_KEY' },
  xai: { endpoint: 'https://api.x.ai/v1', credential: 'XAI_API_KEY' },
  bfl: { endpoint: 'https://api.bfl.ai/v1', credential: 'BFL_API_KEY' },
  google: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    credential: 'GEMINI_API_KEY',
  },
};

// A fixed API host does not establish inference or storage residency.
for (const provider of providers.filter((item) => item.id !== 'alibaba')) {
  deployments.push({
    id: `${provider.id}-undisclosed`,
    providerId: provider.id,
    name: `${provider.name} · Region undisclosed`,
    endpointRegion: 'undisclosed',
    scope: 'undisclosed',
    processingRegions: null,
    storageRegions: null,
    endpointTemplate: providerEndpoints[provider.id]?.endpoint ?? null,
    credentialEnv: providerEndpoints[provider.id]?.credential ?? null,
    source: source(
      provider.website,
      'Regional coverage has not yet been qualified for this integration. This row must not be interpreted as a residency commitment.',
    ),
  });
}

function model(
  id: string,
  name: string,
  creator: keyof typeof modelAuthors,
  familyId: string,
  modality: Model['modality'],
  url: string,
  description: string,
  extra: Partial<Pick<Model, 'aliases' | 'openness' | 'license'>> = {},
): Model {
  return {
    id,
    name,
    creator,
    authorProviderIds: [...modelAuthors[creator]],
    familyId,
    modality,
    aliases: [],
    openness: 'closed',
    license: 'Provider service terms; no open-weight grant established',
    source: source(url),
    description,
    ...extra,
  };
}

const models: Model[] = [
  model(
    'bytedance/seedance-2.5',
    'Seedance 2.5',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5',
    'Native long-form video generation with multimodal references.',
  ),
  model(
    'bytedance/seedance-2.0',
    'Seedance 2.0',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/ModelArk/seedance-2-0',
    'Standard release in the complete Seedance 2.0 family.',
  ),
  model(
    'bytedance/seedance-2.0-fast',
    'Seedance 2.0 Fast',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/ModelArk/seedance-2-0',
    'Fast variant; its identity is preserved across provider routes.',
  ),
  model(
    'bytedance/seedance-2.0-mini',
    'Seedance 2.0 Mini',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/ModelArk/seedance-2-0',
    'Mini variant; not an alias of the standard or Fast release.',
  ),
  model(
    'bytedance/seedance-1.0-pro',
    'Seedance 1.0 Pro',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/modelark/seedance-1-0-pro',
    'Silent 480p–1080p video generation with text-to-video and first/last-frame conditioning.',
  ),
  model(
    'bytedance/seedance-1.0-pro-fast',
    'Seedance 1.0 Pro Fast',
    'ByteDance',
    'seedance',
    'video',
    'https://docs.byteplus.com/en/docs/modelark/seedance-1-0-pro-fast',
    'Lower-cost fast sibling in the Seedance 1.0 silent video series.',
  ),
  model(
    'kling/kling-4.0',
    'Kling 4.0',
    'Kling AI',
    'kling',
    'video',
    'https://kling.ai/dev/model-release/kling-4',
    'Video generation and editing with separately qualified serving routes.',
  ),
  model(
    'kling/kling-4.0-flash',
    'Kling 4.0 Flash',
    'Kling AI',
    'kling',
    'video',
    'https://fal.ai/models/kling/v4/flash/text-to-video',
    '720p fast sibling in the Kling 4.0 family with native synchronized audio.',
  ),
  model(
    'alibaba/happy-horse-1.1',
    'HappyHorse 1.1',
    'Alibaba',
    'happy-horse',
    'video',
    'https://fal.ai/models/alibaba/happy-horse/v1.1/text-to-video',
    '720p and 1080p video generation with native synchronized audio and multi-image references.',
  ),
  model(
    'alibaba/wan-3.0',
    'Wan 3.0',
    'Alibaba',
    'wan',
    'video',
    wanStandard,
    'All-in-one video generation. Six documented Alibaba regional offerings.',
  ),
  model(
    'alibaba/wan-3.0-prime',
    'Wan 3.0 Prime',
    'Alibaba',
    'wan',
    'video',
    wanPrime,
    'Accelerated Wan 3.0 sibling with its own regional prices.',
  ),
  model(
    'minimax/h3',
    'MiniMax H3',
    'MiniMax',
    'minimax-h3',
    'video',
    'https://design.minimax.io/h3',
    'Open-weight base family; hosted enhancements are recorded separately.',
    {
      openness: 'open-weights',
      license: 'MiniMax H3 Community License — restricted commercial and territorial terms',
    },
  ),
  model(
    'minimax/h3-highspeed',
    'MiniMax H3 Highspeed',
    'MiniMax',
    'minimax-h3',
    'video',
    'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
    'Official hosted Highspeed variant; open weights are not assumed.',
  ),
  model(
    'minimax/h3-lite',
    'MiniMax H3 Lite',
    'MiniMax',
    'minimax-h3',
    'video',
    'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
    'Official hosted Lite variant.',
  ),
  model(
    'minimax/h3-max',
    'MiniMax H3 Max',
    'MiniMax',
    'minimax-h3',
    'video',
    'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
    'MiniMax H3 Max, served by MiniMax and fal under provider-specific names.',
    { aliases: ['H3 Max', 'H3 Max · fal', 'MiniMax H3 Max · MiniMax', 'fal/h3-max'] },
  ),
  model(
    'fal/h3-max-turbo',
    'H3 Max Turbo · fal',
    'fal',
    'minimax-h3',
    'video',
    'https://fal.ai/models/minimax/h3-max-turbo/text-to-video',
    'fal’s accelerated H3 Max derivative.',
  ),
  model(
    'pika/h3-flex',
    'H3 Flex · Pika',
    'Pika',
    'minimax-h3',
    'video',
    'https://pika.art/pika-h3-flex',
    'Post-trained H3 derivative; hosted high-resolution upsampling and stems are separate capabilities.',
    {
      openness: 'open-weights',
      license:
        'Adapters inherit MiniMax H3 Community License; hosted features have separate service terms',
    },
  ),
  model(
    'google/gemini-omni-1.2-flash',
    'Gemini Omni 1.2 Flash',
    'Google',
    'gemini-omni',
    'video',
    'https://aistudio.google.com/docs/models/gemini-omni-flash',
    'Expanded 3–15s conversational video generation, editing and stateful extension.',
    { aliases: ['gemini-omni-1.2-flash'] },
  ),
  model(
    'google/gemini-omni-1.1-flash',
    'Gemini Omni 1.1 Flash',
    'Google',
    'gemini-omni',
    'video',
    'https://aistudio.google.com/docs/models/gemini-omni-flash',
    'Conversational video generation and editing; continuation state must remain on the originating route.',
    { aliases: ['Gemini Omni Flash', 'gemini-omni-1.1-flash'] },
  ),
  model(
    'bfl/flux-3-video',
    'FLUX 3 Video',
    'Black Forest Labs',
    'flux-3',
    'video',
    'https://docs.bfl.ai/flux_3/flux3_video',
    '720p–2160p video generation, editing and extension with switchable generated audio.',
  ),
  model(
    'fal/flux-3-max-video',
    'FLUX 3 Max Video · fal',
    'fal',
    'flux-3',
    'video',
    'https://fal.ai/models/blackforestlabs/flux-3-max/text-to-video',
    'Post-trained fal Research FLUX 3 Video derivative with configurable reasoning level.',
  ),
  model(
    'xai/grok-imagine-video-1.5',
    'Grok Imagine Video 1.5',
    'xAI',
    'grok-imagine-video',
    'video',
    'https://docs.x.ai/developers/model-capabilities/video/overview',
    'Text, image and reference video generation with generated audio.',
  ),
  model(
    'xai/grok-imagine-video-1.5-lite',
    'Grok Imagine Video 1.5 Lite',
    'xAI',
    'grok-imagine-video',
    'video',
    'https://docs.x.ai/developers/model-capabilities/video/overview',
    'Lower-cost sibling; 1080p is upscaled from 720p.',
  ),
  model(
    'xai/grok-imagine-video',
    'Grok Imagine Video · Edit / Extend',
    'xAI',
    'grok-imagine-video',
    'video',
    'https://docs.x.ai/developers/model-capabilities/video/overview',
    'Existing model retained for video editing and extension.',
  ),
  model(
    'openai/gpt-image-2.6-sunburst',
    'GPT Image 2.6 Sunburst',
    'OpenAI',
    'gpt-image',
    'image',
    'https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst',
    'Highest-detail GPT Image 2.6 flagship with configurable pre-render reasoning complexity.',
  ),
  model(
    'openai/gpt-image-2.6-flare',
    'GPT Image 2.6 Flare',
    'OpenAI',
    'gpt-image',
    'image',
    'https://developers.openai.com/api/docs/models/gpt-image-2.6-flare',
    'Lower-latency GPT Image 2.6 sibling, distinct from Sunburst.',
  ),
  model(
    'openai/gpt-image-2.5-sunburst',
    'GPT Image 2.5 Sunburst',
    'OpenAI',
    'gpt-image',
    'image',
    'https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst',
    'Image generation and editing; priced separately from Flare.',
  ),
  model(
    'openai/gpt-image-2.5-flare',
    'GPT Image 2.5 Flare',
    'OpenAI',
    'gpt-image',
    'image',
    'https://developers.openai.com/api/docs/models/gpt-image-2.5-flare',
    'Distinct GPT Image 2.5 variant, not a provider pricing tier.',
  ),
  model(
    'openai/gpt-image-2',
    'GPT Image 2',
    'OpenAI',
    'gpt-image',
    'image',
    'https://developers.openai.com/api/docs/models/gpt-image-2',
    'Official model name GPT Image 2; 2.0 remains a discoverable alias.',
    { aliases: ['GPT Image 2.0', 'gpt-image-2'] },
  ),
  model(
    'google/nano-banana-2.1',
    'Nano Banana 2.1',
    'Google',
    'nano-banana',
    'image',
    'https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1',
    'Native Gemini image generation and editing.',
    { aliases: ['gemini-nano-banana-2.1'] },
  ),
  model(
    'google/nano-banana-pro',
    'Nano Banana Pro',
    'Google',
    'nano-banana',
    'image',
    'https://aistudio.google.com/docs/image-generation',
    'Gemini 3 Pro Image high-reasoning tier across 1K, 2K and 4K.',
    { aliases: ['gemini-3-pro-image'] },
  ),
  model(
    'google/nano-banana-2',
    'Nano Banana 2',
    'Google',
    'nano-banana',
    'image',
    'https://aistudio.google.com/docs/image-generation',
    'Gemini 3.1 Flash Image generation and editing across 0.5K–4K.',
    { aliases: ['gemini-3.1-flash-image'] },
  ),
  model(
    'google/nano-banana-2-lite',
    'Nano Banana 2 Lite',
    'Google',
    'nano-banana',
    'image',
    'https://aistudio.google.com/docs/image-generation',
    'Low-latency Gemini 3.1 Flash Lite Image 1K specialist.',
    { aliases: ['gemini-3.1-flash-lite-image'] },
  ),
  model(
    'minimax/h3-image',
    'MiniMax H3 Image',
    'MiniMax',
    'minimax-h3-image',
    'image',
    'https://platform.minimax.io/docs/api-reference/image-generation-h3-generations',
    'Unified 1K–4K image generation and up to 16-reference editing.',
    { aliases: ['MiniMax-H3-Image'] },
  ),
  model(
    'minimax/h3-image-highspeed',
    'MiniMax H3 Image Highspeed',
    'MiniMax',
    'minimax-h3-image',
    'image',
    'https://platform.minimax.io/docs/api-reference/image-generation-h3-generations',
    'High-throughput MiniMax H3 Image sibling with distinct token rates.',
    { aliases: ['MiniMax-H3-Image-Highspeed'] },
  ),
  model(
    'bfl/flux-3-image',
    'FLUX 3 Image',
    'Black Forest Labs',
    'flux-3',
    'image',
    'https://docs.bfl.ai/flux_3/flux3_image_generate',
    'Flagship FLUX 3 image generation and multi-reference editing across 768sq–4K.',
  ),
  model(
    'bfl/flux-3-klein',
    'FLUX 3 Klein',
    'Black Forest Labs',
    'flux-3',
    'image',
    'https://docs.bfl.ai/flux_3/flux3_image_klein',
    'Compact 5.6B open-weights FLUX 3 image generation and editing sibling.',
    {
      openness: 'open-weights',
      license:
        'FLUX Kommunity License — commercial self-hosting permitted below $5M annual revenue',
    },
  ),
  model(
    'xai/grok-imagine-image-2.0',
    'Grok Imagine Image 2.0',
    'xAI',
    'grok-imagine-image',
    'image',
    'https://docs.x.ai/developers/models/grok-imagine-image-2.0',
    'Image generation and editing.',
    { aliases: ['Grok Image 2.0'] },
  ),
  model(
    'bytedance/seedream-5.5',
    'Seedream 5.5',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-5',
    'Latest Seedream 5.5 image generation and multi-reference editing release.',
  ),
  model(
    'bytedance/seedream-5.0-pro',
    'Seedream 5.0 Pro',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro',
    'Generation, multi-reference editing, interactive edits and layer decomposition.',
  ),
  model(
    'bytedance/seedream-5.0-flash',
    'Seedream 5.0 Flash',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-flash',
    'Fast Seedream 5.0 image generation and editing.',
  ),
  model(
    'bytedance/seedream-5.0-lite',
    'Seedream 5.0 Lite',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-lite',
    'High-resolution 2K–4K Seedream 5.0 Lite image generation and editing.',
  ),
  model(
    'bytedance/seedream-4.5',
    'Seedream 4.5',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-4-5',
    'Seedream 4.5 2K and 4K image generation and editing.',
  ),
  model(
    'bytedance/seedream-4.0',
    'Seedream 4.0',
    'ByteDance',
    'seedream',
    'image',
    'https://docs.byteplus.com/en/docs/modelark/seedream-4-0',
    'Seedream 4.0 1K–4K image generation and editing.',
  ),
  model(
    'qwen/image-2.1',
    'Qwen Image 2.1',
    'Qwen',
    'qwen-image-2.1',
    'image',
    'https://github.com/QwenLM/Qwen-Image-2.1',
    'Published base weights; commercial weight use requires separate authorization.',
    {
      openness: 'open-weights',
      license:
        'Qwen Research License — non-commercial research/evaluation; separate commercial license required',
    },
  ),
  model(
    'qwen/image-2.1-turbo',
    'Qwen Image 2.1 Turbo',
    'Qwen',
    'qwen-image-2.1',
    'image',
    'https://github.com/QwenLM/Qwen-Image-2.1',
    'Published Turbo checkpoint; keep hosted identity and checkpoint provenance explicit.',
    {
      openness: 'open-weights',
      license:
        'Qwen Research License — separate commercial license required for commercial weight use',
    },
  ),
  model(
    'alibaba/qwen-image-2.1-pro',
    'Qwen Image 2.1 Pro · Hosted',
    'Alibaba',
    'qwen-image-2.1',
    'image',
    'https://www.alibabacloud.com/help/en/model-studio/text-to-image',
    'Hosted Pro offering. Identity is not presumed equal to the base checkpoint.',
  ),
  model(
    'alibaba/qwen-image-3.0-pro',
    'Qwen Image 3.0 Pro',
    'Alibaba',
    'qwen-image-3',
    'image',
    'https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference',
    'Hosted image generation and editing; no public-weight grant is assumed.',
  ),
  model(
    'fal/qwen-image-3',
    'Qwen Image 3 · fal',
    'fal',
    'qwen-image-3',
    'image',
    'https://fal.ai/models/alibaba/qwen-image-3/text-to-image',
    'fal-hosted Qwen Image 3 offering; kept distinct from Qwen Image 3.0 Pro until checkpoint identity is confirmed.',
  ),
];

const videoOps: Operation[] = [
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'video-edit',
  'video-extend',
];
const routes: Route[] = [];
const durations = (minimum: number, maximum: number) =>
  Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);

// These are model-card offerings, not a Cartesian product inferred from company locations.
for (const region of regionalDefinitions) {
  for (const prime of [false, true]) {
    const modelId = prime ? 'alibaba/wan-3.0-prime' : 'alibaba/wan-3.0';
    const singapore = region.code === 'ap-southeast-1';
    const verified = singapore;
    const prices = prime
      ? singapore
        ? [68_000, 140_000, 280_000]
        : [63_600, 127_199, 254_399]
      : singapore
        ? [50_000, 100_000, 200_000]
        : [41_256, 82_513, 165_025];
    const rates: Rate[] = ['480p', '720p', '1080p'].flatMap((resolution, index) =>
      (['text-to-video', 'image-to-video'] satisfies Operation[]).map((operation) => ({
        resolution,
        operation,
        unit: 'output-second' as const,
        usdMicros: prices[index]!,
        note: 'Published list price, excluding promotions. Reference-video input has an additional duration charge and is not quoted by this bootstrap formula.',
      })),
    );
    routes.push({
      id: `alibaba/${region.code}/${prime ? 'wan-3.0-prime' : 'wan-3.0'}`,
      modelId,
      deploymentId: `alibaba-model-studio-${region.code}`,
      upstreamModelId: prime ? 'wan3.0-video-prime' : 'wan3.0-video',
      operations: [...videoOps],
      resolutions: ['480p', '720p', '1080p'],
      durations: durations(2, 30),
      fidelity: 'unknown',
      adapter: 'alibaba',
      status: verified ? 'live-verified' : 'documented',
      ...(verified && {
        liveVerification: {
          checkedAt: '2026-11-06',
          operation: prime ? 'text-to-video' : 'image-to-video',
          operations: ['text-to-video', 'image-to-video'],
          resolution: '480p',
          duration: 2,
        },
      }),
      rates,
      pricingSource: source(
        prime ? wanPrime : wanStandard,
        verified
          ? 'Original regional list tariff, excluding promotional offers. The live tests covered 480p text-to-video and image-to-video for two seconds.'
          : 'Original regional list tariff, excluding promotional offers. Live account access and settled billing remain unverified.',
      ),
      source: source(wanGuide),
    });
  }
}

function route(
  modelId: string,
  deploymentId: string,
  upstreamModelId: string,
  url: string,
  operations: Operation[],
  resolutions: string[],
  allowedDurations: number[] = [],
  extra: Partial<
    Pick<Route, 'id' | 'providerModelName' | 'adapter' | 'rates' | 'fidelity' | 'pricingSource'>
  > = {},
): void {
  routes.push({
    id: `${deploymentId}/${modelId.replace('/', '-')}`,
    modelId,
    deploymentId,
    upstreamModelId,
    operations,
    resolutions,
    durations: allowedDurations,
    fidelity: 'unknown',
    adapter: null,
    status: 'documented',
    rates: [],
    pricingSource: unknownPrice(url),
    source: source(url),
    ...extra,
  });
}

const seed20 = 'https://docs.byteplus.com/en/docs/ModelArk/seedance-2-0';
route(
  'bytedance/seedance-2.0',
  'byteplus-undisclosed',
  'dreamina-seedance-2-0-260128',
  seed20,
  videoOps,
  ['480p', '720p', '1080p', '4K'],
  durations(4, 15),
);
route(
  'bytedance/seedance-2.0-fast',
  'byteplus-undisclosed',
  'dreamina-seedance-2-0-fast-260128',
  seed20,
  videoOps,
  ['480p', '720p'],
  durations(4, 15),
);
route(
  'bytedance/seedance-2.0-mini',
  'byteplus-undisclosed',
  'dreamina-seedance-2-0-mini-260615',
  seed20,
  videoOps,
  ['480p', '720p'],
  durations(4, 15),
);
route(
  'bytedance/seedance-2.5',
  'runway-undisclosed',
  'seedance2_5',
  'https://docs.dev.runwayml.com/guides/models/',
  ['text-to-video', 'image-to-video'],
  ['480p', '720p'],
  durations(4, 30),
);
route(
  'bytedance/seedance-2.5',
  'replicate-undisclosed',
  'bytedance/seedance-2.5',
  'https://replicate.com/bytedance/seedance-2.5',
  ['text-to-video', 'image-to-video', 'reference-to-video'],
  ['480p', '720p'],
  durations(4, 30),
  { adapter: 'replicate' },
);
route(
  'kling/kling-4.0',
  'runway-undisclosed',
  'kling_4',
  'https://dev.runwayml.com/learn/kling-4-0-api',
  ['text-to-video', 'image-to-video', 'video-edit'],
  ['720p', '1080p'],
  durations(3, 30),
  {
    adapter: 'runway',
    rates: ['text-to-video', 'image-to-video'].flatMap((operation) => [
      {
        operation: operation as Operation,
        resolution: '720p',
        unit: 'output-second' as const,
        usdMicros: 157_000,
      },
      {
        operation: operation as Operation,
        resolution: '1080p',
        unit: 'output-second' as const,
        usdMicros: 235_000,
      },
    ]),
    pricingSource: source(
      'https://dev.runwayml.com/learn/kling-4-0-api',
      'Output-only generation list tariff including generated sound. Video input/edit operations have separate input billing and are not priced by this formula. Provider page prices are dated November 3 UTC, observed November 2 in America/Los_Angeles.',
    ),
  },
);
for (const [operation, suffix] of [
  ['text-to-video', 'text-to-video'],
  ['image-to-video', 'image-to-video'],
  ['reference-to-video', 'reference-to-video'],
  ['video-edit', 'video-to-video/edit'],
] as const) {
  const upstream = `kling/v4/${suffix}`;
  const priced = operation === 'text-to-video' || operation === 'image-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'kling/kling-4.0',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['720p', '1080p'],
    durations: durations(3, 30),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['720p', '1080p'].map((resolution, index) => ({
          operation,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [157_000, 235_000][index]!,
          note: 'Published fal Kling v4 output-second list estimate without video input.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note: priced
        ? 'Exact fal Kling v4 output-second list estimate without video input ($0.157/s at 720p, $0.235/s at 1080p).'
        : 'Video-reference and source-video edit operations bill across active input and output seconds and remain unpriced.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Kling v4 queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'kling/kling-4.0-flash',
  'runway-undisclosed',
  'kling_4_flash',
  'https://docs.dev.runwayml.com/guides/models/',
  ['text-to-video', 'image-to-video', 'video-edit'],
  ['720p'],
  durations(3, 20),
  {
    adapter: 'runway',
    pricingSource: {
      url: 'https://docs.dev.runwayml.com/guides/pricing/',
      checkedAt: '2026-11-14',
      note: 'Runway charges 9.4 credits ($0.094)/s without input video, rounded up to whole credits with a 29-credit ($0.29) minimum; linear per-second quoting is omitted.',
    },
  },
);
for (const [operation, suffix] of [
  ['text-to-video', 'text-to-video'],
  ['image-to-video', 'image-to-video'],
  ['reference-to-video', 'reference-to-video'],
  ['video-edit', 'video-to-video'],
] as const) {
  const upstream = `kling/v4/flash/${suffix}`;
  const priced = operation === 'text-to-video' || operation === 'image-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'kling/kling-4.0-flash',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['720p'],
    durations: durations(3, 20),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? [
          {
            operation,
            resolution: '720p',
            unit: 'output-second' as const,
            usdMicros: 94_000,
            note: 'Published fal Kling v4 Flash output-second list estimate without video input.',
          },
        ]
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note: priced
        ? 'Exact fal Kling v4 Flash 720p output-second list estimate ($0.094/s) without video input.'
        : 'Video-reference and video-to-video operations carry input-duration billing and remain unpriced.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Kling v4 Flash queue endpoint schema checked; not live-verified.',
    ),
  });
}
for (const operation of ['text-to-video', 'image-to-video', 'reference-to-video'] as const) {
  const upstream = `alibaba/happy-horse/v1.1/${operation}`;
  const priced = operation !== 'reference-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'alibaba/happy-horse-1.1',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['720p', '1080p'],
    durations: durations(3, 15),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['720p', '1080p'].map((resolution) => ({
          operation,
          resolution,
          unit: 'output-second' as const,
          usdMicros: 140_000,
          note: 'Published fal HappyHorse 1.1 output-second list estimate ($0.14/s).',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note: priced
        ? 'Exact fal HappyHorse 1.1 output-second list estimate ($0.14/s across 720p and 1080p).'
        : 'Reference-to-video remains unpriced for managed quotes.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal HappyHorse 1.1 queue endpoint schema checked; not live-verified.',
    ),
  });
}

// Singapore ModelArk endpoints are independently qualified, separate from unqualified regional listings.
for (const [modelId, upstream, minimumDuration, maximumDuration, resolutions, operations] of [
  [
    'bytedance/seedance-2.5',
    'dreamina-seedance-2-5-260628',
    4,
    30,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0',
    'dreamina-seedance-2-0-260128',
    4,
    15,
    ['480p', '720p', '1080p', '4K'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0-fast',
    'dreamina-seedance-2-0-fast-260128',
    4,
    15,
    ['480p', '720p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0-mini',
    'dreamina-seedance-2-0-mini-260615',
    4,
    15,
    ['480p', '720p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-1.0-pro',
    'seedance-1-0-pro-250528',
    2,
    12,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video'],
  ],
  [
    'bytedance/seedance-1.0-pro-fast',
    'seedance-1-0-pro-fast-251015',
    2,
    12,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video'],
  ],
] as const) {
  route(
    modelId,
    'byteplus-modelark-ap-southeast-1',
    upstream,
    'https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api',
    [...operations],
    [...resolutions],
    durations(minimumDuration, maximumDuration),
    { adapter: 'byteplus' },
  );
}

// Exact fal endpoints are distinct routes; standard, fast, first-frame and reference input are never substituted.
for (const [modelId, prefix, minimumDuration, maximumDuration, resolutions, operations] of [
  [
    'bytedance/seedance-2.5',
    'bytedance/seedance-2.5',
    4,
    30,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0',
    'bytedance/seedance-2.0',
    4,
    15,
    ['480p', '720p', '1080p', '4K'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0-fast',
    'bytedance/seedance-2.0/fast',
    4,
    15,
    ['480p', '720p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-2.0-mini',
    'bytedance/seedance-2.0/mini',
    4,
    15,
    ['480p', '720p'],
    ['text-to-video', 'image-to-video', 'reference-to-video'],
  ],
  [
    'bytedance/seedance-1.0-pro',
    'fal-ai/bytedance/seedance/v1/pro',
    2,
    12,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video'],
  ],
  [
    'bytedance/seedance-1.0-pro-fast',
    'fal-ai/bytedance/seedance/v1/pro/fast',
    2,
    12,
    ['480p', '720p', '1080p'],
    ['text-to-video', 'image-to-video'],
  ],
] as const) {
  for (const operation of operations) {
    const upstream = `${prefix}/${operation}`;
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: [...resolutions],
      durations: durations(minimumDuration, maximumDuration),
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      rates: [],
      pricingSource: source(
        `https://fal.ai/models/${upstream}`,
        'Token-based video billing depends on exact frame dimensions and input/output duration. Approximate per-second marketing figures have not been converted into a flat rate.',
      ),
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Explicit endpoint schema checked; not live-verified. Canonical reference roles and media types are validated per operation; unsupported options are rejected before submission.',
      ),
    });
  }
}

for (const [modelId, prefix, prices] of [
  ['alibaba/wan-3.0', 'alibaba/wan-3.0', [50_000, 100_000, 200_000]],
  ['alibaba/wan-3.0-prime', 'alibaba/wan-3.0-prime', [68_000, 140_000, 280_000]],
] as const) {
  for (const operation of ['text-to-video', 'image-to-video', 'reference-to-video'] as const) {
    const upstream = `${prefix}/${operation}`;
    const priced = operation !== 'reference-to-video';
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: ['480p', '720p', '1080p'],
      durations: durations(2, 30),
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      rates: priced
        ? ['480p', '720p', '1080p'].map((resolution, index) => ({
            operation,
            resolution,
            unit: 'output-second' as const,
            usdMicros: prices[index]!,
            note: 'Published fal output-second list estimate. Provider marks Wan 3.0 pricing subject to change; settled charges are reconciled separately.',
          }))
        : [],
      pricingSource: {
        url: `https://fal.ai/models/${upstream}`,
        checkedAt: '2026-11-13',
        note: priced
          ? 'Exact fal Wan 3.0 output-second list estimate without video-reference inputs.'
          : 'Reference-to-video video-input duration billing is not quoted by a flat output-second formula.',
      },
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Explicit fal Wan 3.0 queue endpoint schema checked; not live-verified.',
      ),
    });
  }
}

deployments.push({
  id: 'fal-seedance-us-account-enabled',
  providerId: 'fal',
  name: 'Seedance 2.0 · US-hosted · Account-enabled',
  endpointRegion: 'undisclosed',
  scope: 'regional',
  processingRegions: ['US'],
  storageRegions: null,
  endpointTemplate: null,
  credentialEnv: null,
  source: source(
    'https://fal.ai/seedance-2.0-us-hosting',
    'US inference hosting is documented for approved US-company accounts. Exact API endpoint, storage region, access and pricing need provider onboarding; an ordinary FAL_KEY does not establish this access.',
  ),
});
route(
  'bytedance/seedance-2.0',
  'fal-seedance-us-account-enabled',
  'account-enabled-seedance-2.0-us',
  'https://fal.ai/seedance-2.0-us-hosting',
  ['text-to-video', 'image-to-video', 'reference-to-video'],
  ['480p', '720p'],
  durations(4, 15),
);

const h3 = 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create';
for (const [slug, upstream, resolutions, prices, minimum] of [
  ['h3', 'MiniMax-H3', ['768p', '2K'], [80_000, 130_000], 4],
  ['h3-highspeed', 'MiniMax-H3-Highspeed', ['480p', '768p'], [40_000, 60_000], 4],
  ['h3-lite', 'MiniMax-H3-Lite', ['480p', '768p'], [25_000, 40_000], 4],
  ['h3-max', 'MiniMax-H3-Max', ['480p', '768p'], [50_000, 80_000], 5],
] as const) {
  route(
    `minimax/${slug}`,
    'minimax-undisclosed',
    upstream,
    h3,
    slug === 'h3' ? videoOps : ['text-to-video', 'image-to-video', 'reference-to-video'],
    [...resolutions],
    durations(minimum, 15),
    {
      adapter: 'minimax',
      rates: resolutions.map((resolution, index) => ({
        operation: 'text-to-video' as const,
        resolution,
        unit: 'output-second' as const,
        usdMicros: prices[index]!,
        note: 'Native MiniMax text-only output list estimate, with no input media or prompt-expansion mode beyond the reviewed adapter default/disabled setting. Image/video/reference, Context-IR and regeneration charges are not included. Requested-duration pricing is an estimate, not settled billing or a provider charge ceiling.',
      })),
      pricingSource: {
        url: 'https://platform.minimax.io/docs/pricing/overview#video',
        checkedAt: '2026-11-03',
        note: 'Exact native H3 variant and resolution, text-to-video output seconds only. No media-input formula, separate regional tariff, actual task charge or account entitlement is inferred.',
      },
      ...(slug === 'h3-max' ? { providerModelName: 'MiniMax H3 Max' } : {}),
    },
  );
}
route(
  'minimax/h3-max',
  'fal-undisclosed',
  'minimax/h3-max/text-to-video',
  'https://fal.ai/models/minimax/h3-max/text-to-video',
  ['text-to-video'],
  ['480p', '768p', '1080p'],
  durations(5, 15),
  // Route IDs identify persisted provider attempts; regrouping the model must not rename them.
  {
    id: 'fal-undisclosed/fal-h3-max',
    adapter: 'fal',
    providerModelName: 'H3 Max',
    rates: ['480p', '768p', '1080p'].map((resolution, index) => ({
      operation: 'text-to-video' as const,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [50_000, 80_000, 160_000][index]!,
      note: 'Standard list estimate for text-only generation with prompt expansion disabled. The November 1–15, 2026 promotion is $0.035/$0.056/$0.112 per second at 480p/768p/1080p; standard rates resume November 16. Actual output may run about 0.7 seconds longer than requested. This estimate is not settled billing or a provider charge ceiling.',
    })),
    pricingSource: {
      url: 'https://fal.ai/models/minimax/h3-max/text-to-video',
      checkedAt: '2026-11-03',
      note: 'Exact fal H3 Max text-to-video endpoint: standard output-second rates, excluding promotional discounts. Qualified only without media inputs and with prompt expansion disabled. No reference/edit pricing, regional access, actual duration or settled charge is established.',
    },
  },
);
route(
  'fal/h3-max-turbo',
  'fal-undisclosed',
  'minimax/h3-max-turbo/text-to-video',
  'https://fal.ai/models/minimax/h3-max-turbo/text-to-video',
  ['text-to-video'],
  ['480p', '768p', '1080p'],
  durations(5, 15),
  {
    adapter: 'fal',
    rates: ['480p', '768p', '1080p'].map((resolution, index) => ({
      operation: 'text-to-video' as const,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [25_000, 40_000, 80_000][index]!,
      note: 'Standard list estimate for text-only generation with prompt expansion disabled. The November 1–15, 2026 promotion is $0.0175/$0.028/$0.056 per second at 480p/768p/1080p; standard rates resume November 16. Actual output may run about 0.7 seconds longer than requested. This estimate is not settled billing or a provider charge ceiling.',
    })),
    pricingSource: {
      url: 'https://fal.ai/models/minimax/h3-max-turbo/text-to-video',
      checkedAt: '2026-11-03',
      note: 'Exact H3 Max Turbo text-to-video endpoint: standard output-second rates, excluding promotional discounts. Qualified only without media inputs and with prompt expansion disabled. No reference/edit pricing, regional access, actual duration or settled charge is established.',
    },
  },
);
for (const [modelId, prefix, providerModelName] of [
  ['minimax/h3-max', 'minimax/h3-max', 'H3 Max'],
  ['fal/h3-max-turbo', 'minimax/h3-max-turbo', undefined],
] as const) {
  for (const operation of ['image-to-video', 'reference-to-video'] as const) {
    const upstream = `${prefix}/${operation}`;
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: ['480p', '768p', '1080p'],
      durations: durations(5, 15),
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      ...(providerModelName ? { providerModelName } : {}),
      rates: [],
      pricingSource: {
        url: `https://fal.ai/models/${upstream}`,
        checkedAt: '2026-11-13',
        note: 'Includes 4,096 shared reference tokens per request; excess reference tokens carry separate per-thousand-token charges and remain unpriced for managed quotes.',
      },
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Explicit fal H3 queue endpoint schema checked; not live-verified.',
      ),
    });
  }
}
for (const operation of ['text-to-video', 'image-to-video', 'reference-to-video'] as const) {
  const upstream = `minimax/h3/${operation}`;
  const priced = operation !== 'reference-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'minimax/h3',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['480p', '768p', '2K', '4K'],
    durations: durations(4, 15),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['480p', '768p', '2K', '4K'].map((resolution, index) => ({
          operation,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [50_000, 60_000, 130_000, 160_000][index]!,
          note: 'Published fal MiniMax H3 output-second list estimate with prompt expansion disabled.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-13',
      note: priced
        ? 'Exact fal MiniMax H3 output-second list estimate with prompt expansion disabled.'
        : 'Reference-to-video adds per-image charges beyond five reference images and remains unpriced.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal MiniMax H3 open-weights queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'pika/h3-flex',
  'pika-undisclosed',
  'pika/pika-h3-flex/text-to-video',
  'https://dev.pika.art/models/pika/pika-h3-flex/text-to-video',
  ['text-to-video'],
  ['480p', '768p', '1080p', '2K', '4K'],
  durations(5, 15),
  {
    adapter: 'pika',
    rates: ['480p', '768p', '1080p', '2K', '4K'].map((resolution, index) => ({
      operation: 'text-to-video' as const,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [10_000, 20_000, 35_000, 40_000, 80_000][index]!,
    })),
    pricingSource: source(
      'https://dev.pika.art/models/pika/pika-h3-flex/text-to-video/pricing',
      'Single video output with rewriting disabled; no audio stems. Above 768p uses upscaling. The settled charge comes from provider billing, not this estimate.',
    ),
  },
);
routes.push({
  id: 'pika-undisclosed/pika-h3-flex-reference-to-video',
  modelId: 'pika/h3-flex',
  deploymentId: 'pika-undisclosed',
  upstreamModelId: 'pika/pika-h3-flex/reference-to-video',
  operations: ['reference-to-video'],
  resolutions: ['480p', '768p', '1080p', '2K', '4K'],
  durations: durations(5, 15),
  fidelity: 'unknown',
  adapter: 'pika',
  status: 'documented',
  rates: ['480p', '768p', '1080p', '2K', '4K'].map((resolution, index) => ({
    operation: 'reference-to-video' as const,
    resolution,
    unit: 'output-second' as const,
    usdMicros: [30_000, 60_000, 75_000, 80_000, 100_000][index]!,
  })),
  source: source(
    'https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/api',
    'Image-reference generation only; no mixed video/audio reference billing in this adapter.',
  ),
  pricingSource: source(
    'https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/pricing',
    '1–9 reference images, single video output, rewriting disabled. Native 480p/768p; higher tiers use upscaling. No audio stems.',
  ),
});
routes.push({
  id: 'pika-undisclosed/pika-h3-flex-image-to-video',
  modelId: 'pika/h3-flex',
  deploymentId: 'pika-undisclosed',
  upstreamModelId: 'pika/pika-h3-flex/image-to-video',
  operations: ['image-to-video'],
  resolutions: ['480p', '768p', '1080p', '2K', '4K'],
  durations: durations(5, 15),
  fidelity: 'unknown',
  adapter: 'pika',
  status: 'documented',
  rates: ['480p', '768p', '1080p', '2K', '4K'].map((resolution, index) => ({
    operation: 'image-to-video' as const,
    resolution,
    unit: 'output-second' as const,
    usdMicros: [10_000, 20_000, 35_000, 40_000, 80_000][index]!,
  })),
  source: source(
    'https://dev.pika.art/models/pika/pika-h3-flex/image-to-video/api',
    'Explicit Pika H3 Flex image-to-video schema checked; not live-verified.',
  ),
  pricingSource: {
    url: 'https://dev.pika.art/models/pika/pika-h3-flex/image-to-video/pricing',
    checkedAt: '2026-11-14',
    note: 'Single video output with rewriting disabled and no audio stems; above 768p uses upscaling.',
  },
});
route(
  'google/gemini-omni-1.2-flash',
  'google-undisclosed',
  'gemini-omni-1.2-flash',
  'https://aistudio.google.com/docs/models/gemini-omni-flash',
  videoOps,
  ['360p', '720p', '1080p', '4K'],
  durations(3, 15),
  { adapter: 'google' },
);
for (const [operation, suffix, allowedDurations] of [
  ['text-to-video', 'text-to-video', durations(3, 15)],
  ['image-to-video', 'image-to-video', durations(3, 15)],
  ['reference-to-video', 'reference-to-video', durations(3, 15)],
  ['video-edit', 'edit', [] as number[]],
  ['video-extend', 'extend', durations(3, 10)],
] as const) {
  const upstream = `google/gemini-omni-flash/v1.2/${suffix}`;
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'google/gemini-omni-1.2-flash',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['360p', '720p', '1080p', '4K'],
    durations: [...allowedDurations],
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note:
        operation === 'text-to-video'
          ? 'Output-second rates ($0.0273/$0.0819/$0.1229/$0.2457 per second across 360p/720p/1080p/4K) plus $1.50/1M input tokens; quoted via bounded token reservation.'
          : 'Media input token charges and source-derived duration billing remain unpriced for managed quotes.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Gemini Omni Flash v1.2 queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'google/gemini-omni-1.2-flash',
  'runway-undisclosed',
  'gemini_omni_flash_1.2',
  'https://docs.dev.runwayml.com/guides/models/',
  videoOps,
  ['360p', '720p', '1080p', '4K'],
  durations(3, 15),
);
for (const [operation, suffix, allowedResolutions, allowedDurations] of [
  ['text-to-video', 'text-to-video', ['720p', '1080p', '1440p', '2160p'], durations(5, 20)],
  ['image-to-video', 'image-to-video', ['720p', '1080p', '1440p', '2160p'], durations(5, 20)],
  ['video-edit', 'edit-video', [] as string[], [] as number[]],
  ['video-extend', 'extend-video', ['720p', '1080p', '1440p', '2160p'], durations(5, 20)],
] as const) {
  const upstream = `blackforestlabs/flux-3/${suffix}`;
  const priced = operation === 'text-to-video' || operation === 'image-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'bfl/flux-3-video',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: [...allowedResolutions],
    durations: [...allowedDurations],
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['720p', '1080p', '1440p', '2160p'].map((resolution, index) => ({
          operation,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [170_000, 290_000, 320_000, 470_000][index]!,
          note: 'Published fal FLUX 3 Video regular output-second list estimate.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note: priced
        ? 'Regular fal FLUX 3 Video output-second list estimate ($0.17/$0.29/$0.32/$0.47 per second across 720p/1080p/1440p/2160p) for fixed integer durations.'
        : 'Source-derived video-edit and video-extend billing remains unpriced for managed quotes.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal FLUX 3 Video queue endpoint schema checked; not live-verified.',
    ),
  });
}
for (const operation of ['text-to-video', 'image-to-video'] as const) {
  const upstream = `blackforestlabs/flux-3-max/${operation}`;
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'fal/flux-3-max-video',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['720p', '1080p', '2K', '4K'],
    durations: durations(5, 20),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: ['720p', '1080p'].map((resolution, index) => ({
      operation,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [170_000, 290_000][index]!,
      note: 'Regular fal FLUX 3 Max Video list rate ($0.17/s at 720p, $0.29/s at 1080p; excluding temporary November 8–22 promotional discounts).',
    })),
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-14',
      note: 'Regular fal FLUX 3 Max Video output-second list rates at 720p and 1080p, excluding temporary promotional discounts; 2K and 4K remain unpriced.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal FLUX 3 Max Video queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'google/gemini-omni-1.1-flash',
  'google-undisclosed',
  'gemini-omni-1.1-flash',
  'https://aistudio.google.com/docs/models/gemini-omni-flash',
  videoOps,
  ['360p', '720p', '1080p', '4K'],
  durations(3, 10),
  { adapter: 'google' },
);
for (const [operation, suffix] of [
  ['text-to-video', 'text-to-video'],
  ['image-to-video', 'image-to-video'],
  ['reference-to-video', 'reference-to-video'],
  ['video-edit', 'edit'],
] as const) {
  const upstream = `google/gemini-omni-flash/v1.1/${suffix}`;
  const priced = operation === 'text-to-video' || operation === 'image-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'google/gemini-omni-1.1-flash',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['360p', '720p', '1080p', '4K'],
    durations: durations(3, 10),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['360p', '720p', '1080p', '4K'].map((resolution, index) => ({
          operation,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [30_000, 100_000, 150_000, 300_000][index]!,
          note: 'Published fal Gemini Omni Flash v1.1 output-second list estimate.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-13',
      note: priced
        ? 'Exact fal Gemini Omni Flash v1.1 output-second list estimate without reference or source-video inputs.'
        : 'Reference and source-derived edit duration billing remains unpriced for managed quotes.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Gemini Omni Flash v1.1 queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'xai/grok-imagine-video-1.5',
  'xai-undisclosed',
  'grok-imagine-video-1.5',
  'https://docs.x.ai/developers/model-capabilities/video/overview',
  ['text-to-video', 'image-to-video', 'reference-to-video'],
  ['480p', '720p', '1080p'],
  durations(1, 15),
  {
    adapter: 'xai',
    rates: ['480p', '720p', '1080p'].map((resolution, index) => ({
      operation: 'text-to-video' as const,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [80_000, 140_000, 250_000][index]!,
      note: 'Text-only Grok Imagine Video 1.5 output list estimate. Input frames and reference images add $0.01 each and remain outside this output-only rate. Settled billing uses valid provider-reported usage ticks when present.',
    })),
    pricingSource: {
      url: 'https://docs.x.ai/developers/pricing#imagine-api',
      checkedAt: '2026-11-03',
      note: 'Exact Video 1.5 text-to-video output-second tariff without input media. Image-to-video and reference-to-video incur additional per-image input charges and remain unpriced. The global media endpoint does not establish an inference/storage region.',
    },
  },
);
for (const operation of ['text-to-video', 'image-to-video', 'reference-to-video'] as const) {
  const upstream = `xai/grok-imagine-video/v1.5/${operation}`;
  const priced = operation === 'text-to-video';
  const resolutions =
    operation === 'reference-to-video' ? ['480p', '720p'] : ['480p', '720p', '1080p'];
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'xai/grok-imagine-video-1.5',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions,
    durations: durations(1, operation === 'reference-to-video' ? 10 : 15),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['480p', '720p', '1080p'].map((resolution, index) => ({
          operation: 'text-to-video' as const,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [80_000, 140_000, 250_000][index]!,
          note: 'Published fal Grok Imagine Video 1.5 text-to-video output-second list estimate.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-13',
      note: priced
        ? 'Exact fal Grok Imagine Video 1.5 text-to-video output-second tariff without input media.'
        : 'Input frames and reference images add $0.01 each and remain outside flat output-second quoting.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Grok Imagine Video 1.5 queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'xai/grok-imagine-video-1.5-lite',
  'xai-undisclosed',
  'grok-imagine-video-1.5-lite',
  'https://docs.x.ai/developers/model-capabilities/video/overview',
  ['text-to-video', 'image-to-video'],
  ['480p', '720p', '1080p'],
  durations(1, 15),
  {
    adapter: 'xai',
    rates: ['480p', '720p', '1080p'].map((resolution, index) => ({
      operation: 'text-to-video' as const,
      resolution,
      unit: 'output-second' as const,
      usdMicros: [20_000, 30_000, 140_000][index]!,
      note: 'Text-only Grok Imagine Video 1.5 Lite output list estimate (1080p is upscaled). Input frames add $0.01 each and remain outside this output-only rate. Settled billing uses valid provider-reported usage ticks when present.',
    })),
    pricingSource: {
      url: 'https://docs.x.ai/developers/pricing#imagine-api',
      checkedAt: '2026-11-03',
      note: 'Exact Video 1.5 Lite text-to-video output-second tariff without input media. Image-to-video incurs an additional input-image charge and remains unpriced. The global media endpoint does not establish an inference/storage region.',
    },
  },
);
for (const operation of ['text-to-video', 'image-to-video'] as const) {
  const upstream = `xai/grok-imagine-video/v1.5/lite/${operation}`;
  const priced = operation === 'text-to-video';
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'xai/grok-imagine-video-1.5-lite',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['480p', '720p', '1080p'],
    durations: durations(1, 15),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: priced
      ? ['480p', '720p', '1080p'].map((resolution, index) => ({
          operation: 'text-to-video' as const,
          resolution,
          unit: 'output-second' as const,
          usdMicros: [20_000, 30_000, 140_000][index]!,
          note: 'Published fal Grok Imagine Video 1.5 Lite text-to-video output-second list estimate.',
        }))
      : [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-13',
      note: priced
        ? 'Exact fal Grok Imagine Video 1.5 Lite text-to-video output-second tariff without input media.'
        : 'Image-to-video adds $0.01 per input image and remains unpriced.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Grok Imagine Video 1.5 Lite queue endpoint schema checked; not live-verified.',
    ),
  });
}
route(
  'xai/grok-imagine-video',
  'xai-undisclosed',
  'grok-imagine-video',
  'https://docs.x.ai/developers/model-capabilities/video/overview',
  ['video-edit', 'video-extend'],
  ['480p', '720p'],
  durations(1, 15),
);
for (const [operation, suffix, minDuration, maxDuration] of [
  ['video-edit', 'edit-video', 1, 15],
  ['video-extend', 'extend-video', 2, 10],
] as const) {
  const upstream = `xai/grok-imagine-video/${suffix}`;
  routes.push({
    id: `fal-undisclosed/${upstream}`,
    modelId: 'xai/grok-imagine-video',
    deploymentId: 'fal-undisclosed',
    upstreamModelId: upstream,
    operations: [operation],
    resolutions: ['480p', '720p'],
    durations: durations(minDuration, maxDuration),
    fidelity: 'unknown',
    adapter: 'fal',
    status: 'documented',
    rates: [],
    pricingSource: {
      url: `https://fal.ai/models/${upstream}`,
      checkedAt: '2026-11-13',
      note: 'Source-video duration incurs $0.01 per input second in addition to output-second rates; remains unpriced for managed quotes.',
    },
    source: source(
      `https://fal.ai/models/${upstream}/api`,
      'Explicit fal Grok Imagine Video edit/extend queue endpoint schema checked; not live-verified.',
    ),
  });
}

const imageOps: Operation[] = ['text-to-image', 'image-edit'];
for (const suffix of ['2.6-sunburst', '2.6-flare', '2.5-sunburst', '2.5-flare', '2']) {
  const id = `gpt-image-${suffix}`;
  route(
    `openai/${id}`,
    'openai-undisclosed',
    id,
    `https://developers.openai.com/api/docs/models/${id}`,
    imageOps,
    ['1K', '2K', '4K'],
    [],
    { adapter: 'openai' },
  );
}
route(
  'google/nano-banana-2.1',
  'google-undisclosed',
  'gemini-nano-banana-2.1',
  'https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1',
  imageOps,
  ['1K', '2K', '4K'],
  [],
  { adapter: 'google' },
);
route(
  'google/nano-banana-pro',
  'google-undisclosed',
  'gemini-3-pro-image',
  'https://aistudio.google.com/docs/image-generation',
  imageOps,
  ['1K', '2K', '4K'],
  [],
  { adapter: 'google' },
);
route(
  'google/nano-banana-2',
  'google-undisclosed',
  'gemini-3.1-flash-image',
  'https://aistudio.google.com/docs/image-generation',
  imageOps,
  ['0.5K', '1K', '2K', '4K'],
  [],
  { adapter: 'google' },
);
route(
  'google/nano-banana-2-lite',
  'google-undisclosed',
  'gemini-3.1-flash-lite-image',
  'https://aistudio.google.com/docs/image-generation',
  imageOps,
  ['1K'],
  [],
  { adapter: 'google' },
);
for (const [modelId, upstream] of [
  ['minimax/h3-image', 'MiniMax-H3-Image'],
  ['minimax/h3-image-highspeed', 'MiniMax-H3-Image-Highspeed'],
] as const) {
  route(
    modelId,
    'minimax-undisclosed',
    upstream,
    'https://platform.minimax.io/docs/api-reference/image-generation-h3-generations',
    imageOps,
    ['1K', '2K', '4K'],
    [],
    { adapter: 'minimax' },
  );
}
route(
  'xai/grok-imagine-image-2.0',
  'xai-undisclosed',
  'grok-imagine-image-2.0',
  'https://docs.x.ai/developers/models/grok-imagine-image-2.0',
  imageOps,
  ['1K', '1.5K', '2K'],
  [],
  {
    adapter: 'xai',
    rates: ['1K', '2K'].map((resolution, index) => ({
      operation: 'text-to-image' as const,
      resolution,
      unit: 'image' as const,
      usdMicros: [40_000, 60_000][index]!,
      note: 'One text-generated Grok Imagine Image 2.0 output at low quality (the adapter default). Auto/medium quality, 1.5K, editing and input media require separate qualified pricing. This list estimate is not a settled charge or provider charge ceiling.',
    })),
    pricingSource: {
      url: 'https://docs.x.ai/developers/pricing#imagine-api',
      checkedAt: '2026-11-03',
      note: 'Exact Image 2.0 low-quality 1K/2K text-to-image output tariff, one image without media input. The global media endpoint does not establish an inference/storage region. No edit or medium/auto-quality image price is qualified here.',
    },
  },
);
route(
  'bytedance/seedream-5.0-pro',
  'byteplus-undisclosed',
  'dola-seedream-5-0-pro-260628',
  'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro',
  imageOps,
  ['1K', '1.5K', '2K'],
);
for (const [modelId, upstream, docUrl, resolutions, prices, pricingNote] of [
  [
    'bytedance/seedream-5.5',
    'dola-seedream-5-5-261028',
    'https://docs.byteplus.com/en/docs/modelark/image-generation-api',
    ['1K', '1.5K', '2K'],
    [20_000, 20_000, 35_000],
    'Single-image text-to-image list tariff: up to 2.60MP $0.02; 2K tier $0.035. Image editing adds $0.008 per input image and remains outside flat output-only quoting.',
  ],
  [
    'bytedance/seedream-5.0-pro',
    'dola-seedream-5-0-pro-260628',
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro',
    ['1K', '1.5K', '2K'],
    [45_000, 45_000, 90_000],
    'Single-image text-to-image list tariff: up to 2.61MP $0.045; higher-resolution 2K tier $0.09. Multi-image inputs and layer decomposition require separate pricing.',
  ],
  [
    'bytedance/seedream-5.0-flash',
    'dola-seedream-5-0-flash-260915',
    'https://docs.byteplus.com/en/docs/modelark/image-generation-api',
    ['1K', '1.5K', '2K'],
    [18_000, 18_000, 18_000],
    'Single-image text-to-image list tariff: flat $0.018 across 1K, 1.5K and 2K.',
  ],
  [
    'bytedance/seedream-5.0-lite',
    'seedream-5-0-lite-260128',
    'https://docs.byteplus.com/en/docs/modelark/image-generation-api',
    ['2K', '3K', '4K'],
    [35_000, 35_000, 35_000],
    'Single-image text-to-image list tariff: flat $0.035 across 2K, 3K and 4K.',
  ],
  [
    'bytedance/seedream-4.5',
    'seedream-4-5-251128',
    'https://docs.byteplus.com/en/docs/modelark/image-generation-api',
    ['2K', '4K'],
    [40_000, 40_000],
    'Single-image text-to-image list tariff: flat $0.04 across 2K and 4K.',
  ],
  [
    'bytedance/seedream-4.0',
    'seedream-4-0-250828',
    'https://docs.byteplus.com/en/docs/modelark/image-generation-api',
    ['1K', '2K', '4K'],
    [30_000, 30_000, 30_000],
    'Single-image text-to-image list tariff: flat $0.03 across 1K, 2K and 4K.',
  ],
] as const) {
  route(
    modelId,
    'byteplus-modelark-ap-southeast-1',
    upstream,
    docUrl,
    imageOps,
    [...resolutions],
    [],
    {
      adapter: 'byteplus',
      pricingSource: source(
        'https://console.byteplus.com/ark/region%3Aap-southeast-1/docs/model-pricing',
        pricingNote,
      ),
      rates: resolutions.map((resolution, index) => ({
        operation: 'text-to-image' as const,
        resolution,
        unit: 'image' as const,
        usdMicros: prices[index]!,
      })),
    },
  );
}
route(
  'bytedance/seedream-5.0-pro',
  'replicate-undisclosed',
  'bytedance/seedream-5-pro',
  'https://replicate.com/bytedance/seedream-5-pro/readme',
  imageOps,
  ['1K', '1.5K', '2K'],
  [],
  { adapter: 'replicate' },
);
// Verified fal reseller endpoints preserve the upstream exact model identity.
for (const [modelId, prefix, resolutions, t2iPrices, priceNote] of [
  ['bytedance/seedream-5.0-pro', 'bytedance/seedream/v5/pro', ['1K', '1.5K', '2K'], null, null],
  [
    'bytedance/seedream-5.5',
    'bytedance/seedream/v5.5',
    ['1K', '1.5K', '2K'],
    [30_000, 30_000, 40_500],
    'Exact fal Seedream v5.5 text-to-image list tariff ($0.03 up to 2.61MP, $0.0405 at 2K). Image editing adds $0.012 per input image per output and remains unpriced.',
  ],
  ['bytedance/seedream-5.0-flash', 'bytedance/seedream/v5/flash', ['1K', '1.5K', '2K'], null, null],
  [
    'bytedance/seedream-5.0-lite',
    'bytedance/seedream/v5/lite',
    ['2K', '3K', '4K'],
    [35_000, 35_000, 35_000],
    'Exact fal Seedream v5 Lite text-to-image list tariff ($0.035 per image).',
  ],
  [
    'bytedance/seedream-4.5',
    'fal-ai/bytedance/seedream/v4.5',
    ['2K', '4K'],
    [40_000, 40_000],
    'Exact fal Seedream v4.5 text-to-image list tariff ($0.04 per image).',
  ],
  ['bytedance/seedream-4.0', 'fal-ai/bytedance/seedream/v4', ['1K', '2K', '4K'], null, null],
  ['openai/gpt-image-2.6-flare', 'openai/gpt-image-2.6/flare', ['1K', '2K', '4K'], null, null],
  [
    'openai/gpt-image-2.6-sunburst',
    'openai/gpt-image-2.6/sunburst',
    ['1K', '2K', '4K'],
    null,
    null,
  ],
  ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5/flare', ['1K', '2K', '4K'], null, null],
  [
    'openai/gpt-image-2.5-sunburst',
    'openai/gpt-image-2.5/sunburst',
    ['1K', '2K', '4K'],
    null,
    null,
  ],
  ['openai/gpt-image-2', 'openai/gpt-image-2', ['1K', '2K', '4K'], null, null],
  ['google/nano-banana-2.1', 'google/nano-banana-2.1', ['1K', '2K', '4K'], null, null],
  ['minimax/h3-image', 'minimax/h3-image', ['1K', '2K', '4K'], null, null],
  ['minimax/h3-image-highspeed', 'minimax/h3-image/highspeed', ['1K', '2K', '4K'], null, null],
  [
    'xai/grok-imagine-image-2.0',
    'xai/grok-imagine-image/v2.0',
    ['1K', '1.5K', '2K'],
    [40_000, 50_000, 60_000],
    'Exact fal Grok Imagine Image 2.0 single-output low-quality text-to-image tariff. Medium/auto quality and image edits carry additional charges and remain unpriced.',
  ],
  [
    'fal/qwen-image-3',
    'alibaba/qwen-image-3',
    ['1K', '2K'],
    [40_000, 75_000],
    'Exact fal Qwen Image 3 text-to-image list tariff ($0.04 at 1K, $0.075 at 2K).',
  ],
] as const) {
  for (const operation of ['text-to-image', 'image-edit'] as const) {
    const upstream =
      operation === 'image-edit'
        ? `${prefix}/edit`
        : prefix === 'google/nano-banana-2.1' || prefix === 'openai/gpt-image-2'
          ? prefix
          : `${prefix}/text-to-image`;
    const priced = operation === 'text-to-image' && t2iPrices !== null;
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: [...resolutions],
      durations: [],
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      rates: priced
        ? resolutions.map((resolution, index) => ({
            operation: 'text-to-image' as const,
            resolution,
            unit: 'image' as const,
            usdMicros: t2iPrices[index]!,
          }))
        : [],
      pricingSource:
        priced && priceNote
          ? { url: `https://fal.ai/models/${upstream}`, checkedAt: '2026-11-13', note: priceNote }
          : unknownPrice(`https://fal.ai/models/${upstream}`),
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Exact reseller endpoint and schema checked. Single-image output; references preserve order. Actual account access and settled charges remain reconciled separately.',
      ),
    });
  }
}
for (const [modelId, prefix, resolutions, oneKPrice] of [
  ['google/nano-banana-pro', 'fal-ai/nano-banana-pro', ['1K', '2K', '4K'], 150_000],
  ['google/nano-banana-2', 'fal-ai/nano-banana-2', ['0.5K', '1K', '2K', '4K'], 80_000],
] as const) {
  for (const operation of ['text-to-image', 'image-edit'] as const) {
    const upstream = operation === 'image-edit' ? `${prefix}/edit` : prefix;
    const priced = operation === 'text-to-image';
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: [...resolutions],
      durations: [],
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      rates: priced
        ? [
            {
              operation: 'text-to-image' as const,
              resolution: '1K',
              unit: 'image' as const,
              usdMicros: oneKPrice,
              note: 'Published fal 1K base output-image list estimate without search grounding.',
            },
          ]
        : [],
      pricingSource: priced
        ? {
            url: `https://fal.ai/models/${upstream}`,
            checkedAt: '2026-11-14',
            note: `Exact fal 1K text-to-image list tariff ($${(oneKPrice / 1_000_000).toFixed(2)} per image without search grounding); other resolution tiers and edits remain unpriced.`,
          }
        : unknownPrice(`https://fal.ai/models/${upstream}`),
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Explicit fal Nano Banana queue endpoint schema checked; not live-verified.',
      ),
    });
  }
}
routes.push({
  id: 'fal-undisclosed/google/nano-banana-2-lite',
  modelId: 'google/nano-banana-2-lite',
  deploymentId: 'fal-undisclosed',
  upstreamModelId: 'google/nano-banana-2-lite',
  operations: ['text-to-image'],
  resolutions: ['1K'],
  durations: [],
  fidelity: 'unknown',
  adapter: 'fal',
  status: 'documented',
  rates: [],
  pricingSource: unknownPrice('https://fal.ai/models/google/nano-banana-2-lite'),
  source: source(
    'https://fal.ai/models/google/nano-banana-2-lite/api',
    'Explicit fal Nano Banana 2 Lite text-to-image queue endpoint schema checked; not live-verified.',
  ),
});
for (const [modelId, prefix, resolutions] of [
  ['bfl/flux-3-image', 'blackforestlabs/flux-3', ['768sq', '1K', '1.5K', '2K', '4K']],
  ['bfl/flux-3-klein', 'blackforestlabs/flux-3/klein', ['1K', '2K', '4K']],
] as const) {
  for (const [operation, suffix] of [
    ['text-to-image', 'text-to-image'],
    ['image-edit', 'edit-image'],
  ] as const) {
    const upstream = `${prefix}/${suffix}`;
    routes.push({
      id: `fal-undisclosed/${upstream}`,
      modelId,
      deploymentId: 'fal-undisclosed',
      upstreamModelId: upstream,
      operations: [operation],
      resolutions: [...resolutions],
      durations: [],
      fidelity: 'unknown',
      adapter: 'fal',
      status: 'documented',
      rates: [],
      pricingSource: {
        url: `https://fal.ai/models/${upstream}`,
        checkedAt: '2026-11-14',
        note: 'Megapixel-billed output depends on exact output dimensions; flat per-tier fees are not assumed.',
      },
      source: source(
        `https://fal.ai/models/${upstream}/api`,
        'Explicit fal FLUX 3 queue endpoint schema checked; not live-verified.',
      ),
    });
  }
}

const qwen =
  'https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference';
// All six Alibaba Cloud Model Studio regions explicitly document Qwen Image 2.1 Turbo/Pro and 3.0 Pro with workspace MaAS endpoints.
for (const region of regionalDefinitions) {
  const singapore = region.code === 'ap-southeast-1';
  for (const [modelId, upstream, sgPrices, globalPrices] of [
    ['qwen/image-2.1-turbo', 'qwen-image-2.1-turbo', [16_000, 16_000], [14_133, 14_133]],
    ['alibaba/qwen-image-2.1-pro', 'qwen-image-2.1-pro', [40_000, 40_000], [35_333, 35_333]],
    ['alibaba/qwen-image-3.0-pro', 'qwen-image-3.0-pro', [40_000, 75_000], [34_380, 68_761]],
  ] as const) {
    const prices = singapore ? sgPrices : globalPrices;
    route(
      modelId,
      `alibaba-model-studio-${region.code}`,
      upstream,
      qwen,
      ['text-to-image', 'image-edit'],
      ['1K', '2K'],
      [],
      {
        adapter: 'alibaba',
        rates: ['1K', '2K'].map((resolution, index) => ({
          resolution,
          operation: 'text-to-image',
          unit: 'image',
          usdMicros: prices[index]!,
          note: `${region.name} Model Studio standard output price for text-only generation. Image inputs, edits, exact sizes and thinking modes remain unqualified.`,
        })),
        pricingSource: {
          url: 'https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio',
          checkedAt: '2026-11-13',
          note: singapore
            ? 'Standard Singapore International list prices, excluding account promotions and free quota. Qwen Image 3.0 Pro image inputs cost an additional USD 0.003 each; output-only rates do not price image edits. Actual upstream charges remain unknown until reconciled.'
            : `Standard ${region.name} Model Studio list prices, excluding account promotions and free quota. Qwen Image 3.0 Pro image inputs cost an additional USD 0.00275 each; output-only rates do not price image edits. Actual upstream charges remain unknown until reconciled.`,
        },
      },
    );
  }
}

for (const route of routes) {
  const publishedPricing = publishedPricingFor(route);
  if (publishedPricing) route.publishedPricing = publishedPricing;
}

export const catalog: Catalog = { providers, deployments, models, routes };
