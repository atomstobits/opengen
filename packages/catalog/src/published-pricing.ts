import { canonicalModelId, type Rate, type Route } from '@media-router/contracts';

type PublishedPricing = NonNullable<Route['publishedPricing']>;
type PublishedOutputRate = NonNullable<PublishedPricing['outputRates']>[number];
type PublishedQuality = NonNullable<PublishedOutputRate['quality']>;
const checkedAt = '2026-11-02';
const recheckedAt = '2026-11-14';
const regionUnknown = 'No region-specific tariff or inference/storage residency was verified.';
const tariff = (
  summary: string,
  url: string,
  conditions: string[],
  checkedOn = recheckedAt,
  outputRates?: PublishedPricing['outputRates'],
): PublishedPricing => ({
  summary,
  source: { url, checkedAt: checkedOn },
  conditions: [...conditions, regionUnknown],
  ...(outputRates && { outputRates }),
});
const regionalTariff = (
  summary: string,
  url: string,
  conditions: string[],
  checkedOn = recheckedAt,
  outputRates?: PublishedPricing['outputRates'],
): PublishedPricing => ({
  summary,
  source: { url, checkedAt: checkedOn },
  conditions,
  ...(outputRates && { outputRates }),
});
const outputRates = (unit: Rate['unit'], amounts: [string, number][], note?: string): Rate[] =>
  amounts.map(([resolution, usdMicros]) => ({
    resolution,
    unit,
    usdMicros,
    ...(note ? { note } : {}),
  }));
const approxVideoRates = (
  amounts: [string, number][],
  note = 'Provider worked example without video input. Actual billing follows the published token formula.',
): PublishedPricing['outputRates'] =>
  outputRates('output-second', amounts, note).map((rate) => ({
    ...rate,
    approximate: true,
  }));
const approxImageRates = (
  amounts: [string, number][],
  note: string,
  quality?: PublishedQuality,
): PublishedPricing['outputRates'] =>
  outputRates('image', amounts, note).map((rate) => ({
    ...rate,
    approximate: true,
    ...(quality ? { quality } : {}),
  }));
const qualityImageRates = (
  quality: PublishedQuality,
  amounts: [string, number][],
  note?: string,
): PublishedPricing['outputRates'] =>
  outputRates('image', amounts, note).map((rate) => ({
    ...rate,
    quality,
  }));

const minimax = 'https://platform.minimax.io/docs/pricing/overview#video';
const minimaxImage = 'https://platform.minimax.io/docs/pricing/overview#image';
const xai = 'https://docs.x.ai/developers/pricing#imagine-api';
const google = 'https://aistudio.google.com/docs/pricing';
const byteplusPricing =
  'https://console.byteplus.com/ark/region%3Aap-southeast-1/docs/model-pricing';
const byteplusPricingDocs = 'https://docs.byteplus.com/en/docs/modelark/model-pricing';
const alibabaPricing = 'https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio';
const wanStandard = 'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video';
const wanPrime = 'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video-prime';
const runwayPricing = 'https://docs.dev.runwayml.com/guides/pricing/';

const gptImage2Tokens: [string, number][] = [
  ['1K', 1_756],
  ['2K', 3_568],
  ['4K', 3_336],
];
const gptImage2HighTokens: [string, number][] = [
  ['1K', 7_024],
  ['2K', 14_272],
  ['4K', 13_344],
];
const gptImage25Tokens: [string, number][] = [
  ['1K', 439],
  ['2K', 892],
  ['4K', 865],
];
const gptImage26Tokens: [string, number][] = [
  ['1K', 1_449],
  ['2K', 2_944],
  ['4K', 2_855],
];
const gptImageApproxRates = (
  tokensByResolution: [string, number][],
  usdPerMillionOutputTokens: number,
  note: string,
  quality: PublishedQuality = 'medium',
) =>
  approxImageRates(
    tokensByResolution.map(([resolution, tokens]) => [
      resolution,
      Math.round((tokens * usdPerMillionOutputTokens) / 100) * 100,
    ]),
    note,
    quality,
  );
const gptImageFamilyApproxRates = (
  family: 'gpt-image-2' | 'gpt-image-2.5' | 'gpt-image-2.6',
  usdPerMillionOutputTokens: number,
  mediumNote: string,
  highNote?: string,
  maxNote?: string,
): PublishedPricing['outputRates'] => {
  if (family === 'gpt-image-2.6') {
    return gptImageApproxRates(gptImage26Tokens, usdPerMillionOutputTokens, mediumNote, 'medium');
  }
  if (family === 'gpt-image-2') {
    return [
      ...gptImageApproxRates(gptImage2Tokens, usdPerMillionOutputTokens, mediumNote, 'medium')!,
      ...(highNote
        ? gptImageApproxRates(gptImage2HighTokens, usdPerMillionOutputTokens, highNote, 'high')!
        : []),
    ];
  }
  return [
    ...gptImageApproxRates(gptImage25Tokens, usdPerMillionOutputTokens, mediumNote, 'medium')!,
    ...(highNote
      ? gptImageApproxRates(gptImage2Tokens, usdPerMillionOutputTokens, highNote, 'high')!
      : []),
    ...(maxNote
      ? gptImageApproxRates(gptImage2HighTokens, usdPerMillionOutputTokens, maxNote, 'max')!
      : []),
  ];
};

const openai = (model: string) => {
  const isGpt2 = model === 'gpt-image-2';
  const isGpt26 = model.startsWith('gpt-image-2.6-');
  return tariff(
    'Standard USD per 1M tokens: $5 text input; $8 image input; $30 image output.',
    isGpt2
      ? 'https://developers.openai.com/api/docs/pricing#image-generation-models'
      : `https://developers.openai.com/api/docs/models/${model}`,
    [
      'Cached text and image inputs cost $1.25 and $2 per 1M tokens. Batch has separate rates.',
      'Size, quality and actual token consumption determine the total. Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits remain unpriced.',
    ],
    isGpt26 ? recheckedAt : '2026-11-06',
    gptImageFamilyApproxRates(
      isGpt2 ? 'gpt-image-2' : isGpt26 ? 'gpt-image-2.6' : 'gpt-image-2.5',
      30,
      isGpt2
        ? 'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) from OpenAI’s GptImageTokenCalculator; high quality is ≈$0.2107 / $0.4282 / $0.4003 and prompt/reference tokens add cost.'
        : isGpt26
          ? 'Medium-quality canonical image-output token equivalent (3.3× GPT Image 2.5 medium tokens at $30 / 1M output tokens); quality, complexity and prompt/reference tokens determine total cost.'
          : 'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) from OpenAI’s GptImageTokenCalculator; high quality is ≈$0.0527 / $0.107 / $0.1001, max is ≈$0.2107 / $0.4282 / $0.4003, and prompt/reference tokens add cost.',
      isGpt2
        ? 'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) from OpenAI’s GptImageTokenCalculator at $30 / 1M output tokens; prompt/reference tokens add cost.'
        : isGpt26
          ? undefined
          : 'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) from OpenAI’s GptImageTokenCalculator at $30 / 1M output tokens; prompt/reference tokens add cost.',
      isGpt2 || isGpt26
        ? undefined
        : 'Max-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) from OpenAI’s GptImageTokenCalculator at $30 / 1M output tokens; prompt/reference tokens add cost.',
    ),
  );
};

const falGptImage = (url: string, family: 'gpt-image-2' | 'gpt-image-2.6' | 'gpt-image-2.5') =>
  tariff(
    family === 'gpt-image-2.6'
      ? 'Per 1M tokens: $5 text input; $10 text output; $8 image input; $30 image output.'
      : 'Per 1M tokens: $5 text input ($1.25 cached); $8 image input ($2 cached); $30 image output.',
    url,
    family === 'gpt-image-2.6'
      ? [
          'GPT Image 2.6 increases low/medium output tokens relative to 2.5 (4.2x low, 3.3x medium); totals round up to $0.0001.',
          'Size, quality, prompt length and reference images determine token consumption; no fixed per-image fee applies.',
        ]
      : [
          'Endpoint billing notes also list $10 per 1M text output tokens; totals round up to $0.0001.',
          'Quality (default high on fal, medium in adapter), size, prompt length and reference images determine total cost.',
        ],
    recheckedAt,
    gptImageFamilyApproxRates(
      family,
      30,
      family === 'gpt-image-2'
        ? 'Adapter medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens; upstream high default is ≈$0.2107 / $0.4282 / $0.4003 plus prompt/reference tokens.'
        : family === 'gpt-image-2.6'
          ? 'Adapter medium-quality canonical image-output token equivalent (3.3× GPT Image 2.5 medium tokens at $30 / 1M output tokens); quality, reasoning_effort and prompt/reference tokens add cost.'
          : 'Adapter medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens (fal short-prompt 1K/4K text-to-image examples: $0.0133 / $0.0260); upstream high default is ≈$0.0528 / $0.107 / $0.1003 plus input tokens.',
      family === 'gpt-image-2.6'
        ? undefined
        : 'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens; prompt and reference tokens add cost.',
      family === 'gpt-image-2.5'
        ? 'Max-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens; prompt and reference tokens add cost.'
        : undefined,
    ),
  );

const falSeedance = tariff(
  '$0.014 per 1,000 video tokens at 480p / 720p / 1080p; $0.008 at 4K.',
  'https://fal.ai/models/bytedance/seedance-2.0/text-to-video',
  [
    'With video references, the rate is $0.0086016 per 1,000 tokens at 480p–1080p ($0.0048 at 4K) on combined input and output video tokens.',
    'Token count depends on actual output width × height × duration × 24 ÷ 1,024. Published per-second examples do not apply to every aspect ratio.',
  ],
  recheckedAt,
  approxVideoRates(
    [
      ['480p', 140_600],
      ['720p', 303_400],
      ['1080p', 682_000],
      ['4K', 1_555_200],
    ],
    '16:9 token-formula equivalent without video references (720p/1080p match fal’s worked examples). Actual billing follows generated video tokens.',
  ),
);

const falSeedanceFast = tariff(
  '$0.0112 per 1,000 video tokens ($0.00672 with video inputs) in the endpoint billing field.',
  'https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video',
  [
    'An editorial table on the same page lists $0.014 per 1,000 tokens instead. Preserve this discrepancy; no complete request quote is implied.',
    'With video inputs, the token price is multiplied by 0.6 across combined input and output video tokens (about $0.14515 / second at 720p).',
  ],
  recheckedAt,
  approxVideoRates(
    [
      ['480p', 112_500],
      ['720p', 241_900],
    ],
    '16:9 token-formula equivalent without video references at $0.0112 / 1,000 tokens (720p matches fal’s worked example). Actual billing follows generated video tokens.',
  ),
);

const falSeedanceMini = tariff(
  '$0.007 per 1,000 video tokens at 480p / 720p ($0.0042 with video references).',
  'https://fal.ai/models/bytedance/seedance-2.0/mini/text-to-video',
  [
    'With video references, $0.0042 per 1,000 tokens applies to combined input and output video token usage; image references alone do not reduce the token rate.',
    'Actual frame dimensions and duration determine token consumption.',
  ],
  recheckedAt,
  approxVideoRates([
    ['480p', 72_100],
    ['720p', 154_700],
  ]),
);

const falSeedance25 = tariff(
  '$0.0214 per 1,000 video tokens at 480p / 720p; ≈$0.0234 at 1080p.',
  'https://fal.ai/models/bytedance/seedance-2.5/text-to-video',
  [
    'With video inputs, the token rate is multiplied by 0.6 across combined input and output video duration (roughly $0.2838 / second at 720p).',
    'The source labels per-second figures approximate; exact request pricing depends on actual frame dimensions and token usage.',
  ],
  recheckedAt,
  approxVideoRates([
    ['480p', 220_500],
    ['720p', 473_000],
    ['1080p', 1_164_000],
  ]),
);

const falSeedance1Pro = tariff(
  '$0.0025 per 1,000 video tokens at 480p / 720p / 1080p.',
  'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video',
  [
    'Token count follows (width × height × fps × duration) ÷ 1,024; 5s 1080p 16:9 is approximately $0.62.',
    'Actual output dimensions determine token consumption.',
  ],
  '2026-11-13',
  approxVideoRates(
    [
      ['480p', 25_100],
      ['720p', 56_400],
      ['1080p', 122_400],
    ],
    '24fps token-formula equivalent at $0.0025 / 1,000 video tokens. Actual billing follows generated video tokens.',
  ),
);

const falSeedance1ProFast = tariff(
  '$0.001 per 1,000 video tokens at 480p / 720p / 1080p.',
  'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/fast/text-to-video',
  [
    'Token count follows (width × height × fps × duration) ÷ 1,024; 5s 1080p 16:9 is approximately $0.245.',
    'Actual output dimensions determine token consumption.',
  ],
  '2026-11-13',
  approxVideoRates(
    [
      ['480p', 10_000],
      ['720p', 22_600],
      ['1080p', 49_000],
    ],
    '24fps token-formula equivalent at $0.001 / 1,000 video tokens. Actual billing follows generated video tokens.',
  ),
);

const falSeedream = tariff(
  'Tentative: $0.0675 / output image through 1536² pixels; $0.135 through 2048².',
  'https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image',
  [
    'The provider explicitly says final pricing is not yet confirmed.',
    'Editing includes the first input image, then adds $0.0045 per additional input image per output.',
  ],
  recheckedAt,
  approxImageRates(
    [
      ['1K', 67_500],
      ['1.5K', 67_500],
      ['2K', 135_000],
    ],
    'Tentative output-image rate before multi-image edit surcharges; final provider pricing is unconfirmed.',
  ),
);

const pikaGpt25 = (variant: 'flare' | 'sunburst', op: 'text-to-image' | 'image-to-image') =>
  tariff(
    op === 'image-to-image'
      ? 'Per 1M tokens: $4.75 text input; $7.60 image input; $28.50 image output.'
      : 'Per 1M tokens: $4.75 text input; $28.50 image output.',
    `https://dev.pika.art/models/openai/gpt-image-2.5-${variant}/${op}`,
    [
      'Token consumption depends on prompt length, quality (low through max), output dimensions and reference images.',
    ],
    recheckedAt,
    gptImageFamilyApproxRates(
      'gpt-image-2.5',
      28.5,
      op === 'image-to-image'
        ? 'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; prompt ($4.75/1M) and input-image ($7.60/1M) tokens add cost.'
        : 'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; high is ≈$0.05 / $0.1017 / $0.0951 and prompt tokens ($4.75/1M) add cost.',
      op === 'image-to-image'
        ? 'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; prompt ($4.75/1M) and input-image ($7.60/1M) tokens add cost.'
        : 'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; prompt tokens ($4.75/1M) add cost.',
      op === 'image-to-image'
        ? 'Max-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; prompt ($4.75/1M) and input-image ($7.60/1M) tokens add cost.'
        : 'Max-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $28.50 / 1M output tokens; prompt tokens ($4.75/1M) add cost.',
    ),
  );

// Exact deployment + endpoint/variant keys prevent applying a provider's global tariff to an unqualified regional offering.
const published: Record<string, PublishedPricing> = {
  // BytePlus ModelArk Singapore
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.5': regionalTariff(
    'Without video input, ModelArk charges $10.70 per million tokens at 480p and 720p and $11.70 at 1080p. With video input, the corresponding rates are $6.40 and $7.00.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing#dreamina-seedance-2-5-price-examples',
    [
      'The per-second figures are published examples for five seconds of 16:9 output without video input.',
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-06',
    outputRates('output-second', [
      ['480p', 103_000],
      ['720p', 231_000],
      ['1080p', 569_000],
    ]).map((rate) => ({ ...rate, approximate: true })),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0': regionalTariff(
    'Without video input, ModelArk charges $7.00 per million tokens at 480p/720p, $7.70 at 1080p and $4.00 at 4K. With video input, the rates are $4.30, $4.70 and $2.40.',
    byteplusPricingDocs,
    [
      'Per-second figures are ModelArk 16:9 5-second worked examples without video input ($0.35 / $0.75 / $1.85 / $3.90 divided by 5s).',
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    recheckedAt,
    approxVideoRates([
      ['480p', 70_000],
      ['720p', 150_000],
      ['1080p', 370_000],
      ['4K', 780_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0-fast': regionalTariff(
    'Without video input, ModelArk charges $5.60 per million tokens at 480p/720p ($3.30 with video input).',
    byteplusPricingDocs,
    [
      'Per-second figures are ModelArk 16:9 5-second worked examples without video input ($0.30 at 480p; $0.60 at 720p).',
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    recheckedAt,
    approxVideoRates([
      ['480p', 60_000],
      ['720p', 120_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0-mini': regionalTariff(
    'Without video input, ModelArk charges $3.50 per million tokens at 480p/720p ($2.10 with video input).',
    byteplusPricingDocs,
    [
      'Per-second figures are ModelArk 16:9 5-second worked examples without video input ($0.20 at 480p; $0.40 at 720p).',
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    recheckedAt,
    approxVideoRates([
      ['480p', 40_000],
      ['720p', 80_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-1.0-pro': regionalTariff(
    'ModelArk charges $2.50 per million video tokens across 480p, 720p and 1080p.',
    byteplusPricingDocs,
    [
      'Managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens on completion.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    approxVideoRates(
      [
        ['480p', 25_100],
        ['720p', 56_400],
        ['1080p', 122_400],
      ],
      '24fps ModelArk token-formula equivalent at $2.50 / 1M video tokens. Actual billing follows reported completion_tokens.',
    ),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-1.0-pro-fast': regionalTariff(
    'ModelArk charges $1.00 per million video tokens across 480p, 720p and 1080p.',
    byteplusPricingDocs,
    [
      'Managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens on completion.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    approxVideoRates(
      [
        ['480p', 10_000],
        ['720p', 22_600],
        ['1080p', 49_000],
      ],
      '24fps ModelArk token-formula equivalent at $1.00 / 1M video tokens. Actual billing follows reported completion_tokens.',
    ),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-5.5': regionalTariff(
    'Output image: $0.02 at 1K / 1.5K (up to 2.61MP); $0.035 at 2K. Image editing adds $0.008 per input image.',
    byteplusPricingDocs,
    [
      'Text-to-image has a complete single-output estimate; image editing incurs additional per-input-image charges.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    outputRates(
      'image',
      [
        ['1K', 20_000],
        ['1.5K', 20_000],
        ['2K', 35_000],
      ],
      'Output-image list rate; image edits add $0.008 per input image.',
    ),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-5.0-pro': regionalTariff(
    '$0.045 / output image at 1K and 1.5K; $0.09 at 2K (+$0.003 / input image when editing).',
    byteplusPricing,
    [
      'Text-to-image single-output rates are qualified; multi-image editing (+$0.003 / input image) and layer decomposition ($0.0225 / $0.045 per layer) require separate pricing.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    recheckedAt,
    outputRates(
      'image',
      [
        ['1K', 45_000],
        ['1.5K', 45_000],
        ['2K', 90_000],
      ],
      'Output-image list rate; image edits add $0.003 per input image.',
    ),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-5.0-flash': regionalTariff(
    'Flat $0.018 / output image across 1K, 1.5K and 2K.',
    byteplusPricing,
    [
      'Text-to-image single-output list rate is qualified; image editing input charges remain unqualified.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['1K', 18_000],
      ['1.5K', 18_000],
      ['2K', 18_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-5.0-lite': regionalTariff(
    'Flat $0.035 / output image across 2K, 3K and 4K.',
    byteplusPricing,
    [
      'Text-to-image single-output list rate is qualified; image editing input charges remain unqualified.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['2K', 35_000],
      ['3K', 35_000],
      ['4K', 35_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-4.5': regionalTariff(
    'Flat $0.04 / output image across 2K and 4K.',
    byteplusPricing,
    [
      'Text-to-image single-output list rate is qualified; image editing input charges remain unqualified.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['2K', 40_000],
      ['4K', 40_000],
    ]),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-4.0': regionalTariff(
    'Flat $0.03 / output image across 1K, 2K and 4K.',
    byteplusPricing,
    [
      'Text-to-image single-output list rate is qualified; image editing input charges remain unqualified.',
      'Singapore API endpoint; processing and storage residency commitments remain unqualified.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['1K', 30_000],
      ['2K', 30_000],
      ['4K', 30_000],
    ]),
  ),

  // Alibaba Model Studio regional Wan 3.0 & Qwen Image offerings
  ...Object.fromEntries(
    [
      'cn-beijing',
      'ap-southeast-1',
      'ap-northeast-1',
      'eu-central-1',
      'us-east-1',
      'cn-hongkong',
    ].flatMap((code) => {
      const sg = code === 'ap-southeast-1';
      const std = sg ? [50_000, 100_000, 200_000] : [41_256, 82_513, 165_025];
      const prm = sg ? [68_000, 140_000, 280_000] : [63_600, 127_199, 254_399];
      const qwenTurbo = sg ? 16_000 : 14_133;
      const qwen21Pro = sg ? 40_000 : 35_333;
      const qwen30Pro = sg ? [40_000, 75_000] : [34_380, 68_761];
      const qwen3InputAddon = sg ? '$0.003' : '$0.00275';
      return [
        [
          `alibaba-model-studio-${code}|alibaba/wan-3.0`,
          regionalTariff(
            sg
              ? 'Output video: $0.05 / second at 480p; $0.10 at 720p; $0.20 at 1080p.'
              : 'Output video: $0.041256 / second at 480p; $0.082513 at 720p; $0.165025 at 1080p.',
            wanStandard,
            [
              'Regional list tariff, excluding promotional offers. Reference-video inputs incur additional duration charges and are not priced by the text/image-to-video quote.',
            ],
            '2026-11-06',
            outputRates('output-second', [
              ['480p', std[0]!],
              ['720p', std[1]!],
              ['1080p', std[2]!],
            ]),
          ),
        ],
        [
          `alibaba-model-studio-${code}|alibaba/wan-3.0-prime`,
          regionalTariff(
            sg
              ? 'Output video: $0.068 / second at 480p; $0.14 at 720p; $0.28 at 1080p.'
              : 'Output video: $0.0636 / second at 480p; $0.127199 at 720p; $0.254399 at 1080p.',
            wanPrime,
            [
              'Regional list tariff, excluding promotional offers. Reference-video inputs incur additional duration charges and are not priced by the text/image-to-video quote.',
            ],
            '2026-11-06',
            outputRates('output-second', [
              ['480p', prm[0]!],
              ['720p', prm[1]!],
              ['1080p', prm[2]!],
            ]),
          ),
        ],
        [
          `alibaba-model-studio-${code}|qwen/image-2.1-turbo`,
          regionalTariff(
            sg
              ? 'Singapore International: $0.016 / output image at 1K and 2K.'
              : 'Model Studio regional tariff: $0.014133 / output image at 1K and 2K.',
            alibabaPricing,
            [
              'Text-to-image single-output list rate is qualified; image edits, thinking modes and custom dimensions remain unqualified.',
            ],
            '2026-11-13',
            outputRates('image', [
              ['1K', qwenTurbo],
              ['2K', qwenTurbo],
            ]),
          ),
        ],
        [
          `alibaba-model-studio-${code}|alibaba/qwen-image-2.1-pro`,
          regionalTariff(
            sg
              ? 'Singapore International: $0.04 / output image at 1K and 2K.'
              : 'Model Studio regional tariff: $0.035333 / output image at 1K and 2K.',
            alibabaPricing,
            [
              'Text-to-image single-output list rate is qualified; image edits, thinking modes and custom dimensions remain unqualified.',
            ],
            '2026-11-13',
            outputRates('image', [
              ['1K', qwen21Pro],
              ['2K', qwen21Pro],
            ]),
          ),
        ],
        [
          `alibaba-model-studio-${code}|alibaba/qwen-image-3.0-pro`,
          regionalTariff(
            sg
              ? 'Singapore International: $0.04 / output image at 1K; $0.075 at 2K (+$0.003 / input image).'
              : 'Model Studio regional tariff: $0.03438 / output image at 1K; $0.068761 at 2K (+$0.00275 / input image).',
            alibabaPricing,
            [
              `Text-to-image single-output list rate is qualified; image edits add ${qwen3InputAddon} per input image and remain unqualified.`,
            ],
            '2026-11-13',
            outputRates('image', [
              ['1K', qwen30Pro[0]!],
              ['2K', qwen30Pro[1]!],
            ]),
          ),
        ],
      ];
    }),
  ),

  // MiniMax first-party
  'minimax-undisclosed|minimax/h3': tariff(
    'Output video: $0.08 / second at 768P; $0.13 at 2K.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.04 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['768p', 80_000],
      ['2K', 130_000],
    ]),
  ),
  'minimax-undisclosed|minimax/h3-highspeed': tariff(
    'Output video: $0.04 / second at 480P; $0.06 at 768P.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.03 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 40_000],
      ['768p', 60_000],
    ]),
  ),
  'minimax-undisclosed|minimax/h3-lite': tariff(
    'Output video: $0.025 / second at 480P; $0.04 at 768P.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.02 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 25_000],
      ['768p', 40_000],
    ]),
  ),
  'minimax-undisclosed|minimax/h3-max': tariff(
    'Output video: $0.05 / second at 480P; $0.08 at 768P.',
    minimax,
    [
      'Input video adds $0.0553 / second at 480P or $0.143 at 768P. Two images are free, then $0.074 / image; audio input is free.',
      'Only text-to-video without input media and with prompt expansion disabled has a qualified output-second estimate. Media inputs and other expansion modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 50_000],
      ['768p', 80_000],
    ]),
  ),
  'minimax-undisclosed|minimax/h3-image': tariff(
    'Per 1M tokens: $2.30 text input (including prompt enhancement); $1.50 image input; $3.80 image output.',
    minimaxImage,
    [
      'Limited-time 50% promotional discount on 4K outputs through November 17, 2026 UTC is excluded from managed reservations.',
      'Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits and custom pixel dimensions remain unpriced.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 7_800],
        ['2K', 19_000],
        ['4K', 76_000],
      ],
      'Image-output token ceiling equivalent (2,048 / 5,000 / 20,000 tokens at $3.80 / 1M); text/prompt-enhancement ($2.30/1M) and reference-image ($1.50/1M) tokens add cost.',
    ),
  ),
  'minimax-undisclosed|minimax/h3-image-highspeed': tariff(
    'Per 1M tokens: $2.30 text input (including prompt enhancement); $3.00 image input; $7.60 image output.',
    minimaxImage,
    [
      'Limited-time 50% promotional discount on 4K outputs through November 17, 2026 UTC is excluded from managed reservations.',
      'Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits and custom pixel dimensions remain unpriced.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 15_600],
        ['2K', 38_000],
        ['4K', 152_000],
      ],
      'Image-output token ceiling equivalent (2,048 / 5,000 / 20,000 tokens at $7.60 / 1M); text/prompt-enhancement ($2.30/1M) and reference-image ($3.00/1M) tokens add cost.',
    ),
  ),

  // xAI first-party
  'xai-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.08 / second at 480p; $0.14 at 720p; $0.25 at 1080p.',
    xai,
    [
      'Input images add $0.01 each. Only text-to-video without input media has a qualified output-second estimate; image-to-video and reference-to-video remain unpriced.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 80_000],
      ['720p', 140_000],
      ['1080p', 250_000],
    ]),
  ),
  'xai-undisclosed|xai/grok-imagine-video-1.5-lite': tariff(
    'Output video: $0.02 / second at 480p; $0.03 at 720p; $0.14 at 1080p.',
    xai,
    [
      'Input images add $0.01 each. Only text-to-video without input media has a qualified output-second estimate; Lite 1080p is upscaled, not a native-resolution guarantee.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 20_000],
      ['720p', 30_000],
      ['1080p', 140_000],
    ]),
  ),
  'xai-undisclosed|xai/grok-imagine-video': tariff(
    'Output video: $0.05 / second at 480p and 720p.',
    'https://docs.x.ai/developers/models/grok-imagine-video',
    [
      'Video edit and extension requests may incur input-video charges in addition to output video duration; complete request quotes remain unqualified.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['720p', 50_000],
      ],
      'Published output-video component; source-video edit/extension input charges are not included.',
    ),
  ),
  'xai-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 1.5K $0.05 / 2K $0.06; medium 1K $0.06 / 1.5K $0.07 / 2K $0.08.',
    xai,
    [
      'Input images add $0.01 each. The adapter selects low for text generation and medium for edits.',
      '1.5K has a published tariff ($0.05 low / $0.07 medium) but is not supported by this adapter. The US regional endpoint does not serve media APIs.',
      'Only one text-generated image at absent/low quality and 1K/2K has a qualified estimate. Auto/medium quality, edits and input media remain unpriced by the execution quote.',
    ],
    '2026-11-03',
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 40_000],
          ['1.5K', 50_000],
          ['2K', 60_000],
        ],
        'Low-quality text-to-image output tariff; medium quality is $0.06/$0.07/$0.08 and edits add $0.01 per input image.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 60_000],
          ['1.5K', 70_000],
          ['2K', 80_000],
        ],
        'Medium-quality output tariff; edits add $0.01 per input image.',
      )!,
    ],
  ),

  // Google first-party
  'google-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text/thinking output; $12 video output.',
    google + '#gemini-omni-1.2-flash',
    [
      'Standard processing converts video output at 1,931 / 5,792 / 8,688 / 17,376 tokens per second across 360p / 720p / 1080p / 4K (~$0.023 / $0.070 / $0.104 / $0.209 per video second before input and thinking tokens).',
      'Single-output text-to-video managed quotes reserve a conservative max-token bound and settle exact reported modality usage; frame, reference, edit and continuation operations remain unpriced.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['360p', 23_200],
        ['720p', 69_500],
        ['1080p', 104_300],
        ['4K', 208_500],
      ],
      'Published video-output token equivalent (1,931 / 5,792 / 8,688 / 17,376 tokens/sec at $12 / 1M); input ($1.50/1M) and text/thinking ($9/1M) tokens add cost.',
    ),
  ),
  'google-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text output; $17.50 video output.',
    google + '#gemini-omni-1.1-flash',
    [
      'Standard processing. Published video-output token conversions are 1,931 / 5,792 / 8,688 / 17,376 tokens per second at 360p / 720p / 1080p / 4K; input and text/thinking costs are additional.',
      'The approximate per-second figures are video-output components, not complete generation prices. Single-output text-to-video managed quotes reserve a conservative max-token bound; frame, reference, edit and continuation operations remain unpriced.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['360p', 33_800],
        ['720p', 101_400],
        ['1080p', 152_000],
        ['4K', 304_100],
      ],
      'Published video-output token equivalent (1,931 / 5,792 / 8,688 / 17,376 tokens/sec at $17.50 / 1M); input ($1.50/1M) and text/thinking ($9/1M) tokens add cost.',
    ),
  ),
  'google-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.50 input; $7.50 text/thinking output; $30 image output.',
    google + '#gemini-nano-banana-2.1',
    [
      'Standard image-output components: $0.0336 at 1K, $0.0504 at 2K, approximately $0.113 at 4K. Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Batch and search grounding have separate pricing. This adapter uses standard Interactions without grounding; reference/edit operations remain unpriced.',
    ],
    checkedAt,
    approxImageRates(
      [
        ['1K', 33_600],
        ['2K', 50_400],
        ['4K', 113_000],
      ],
      'Published image-output token equivalent; prompt input and thinking tokens add cost.',
    ),
  ),
  'google-undisclosed|google/nano-banana-pro': tariff(
    'Per 1M tokens: $2.00 input; $12.00 text/thinking output; $120.00 image output.',
    google + '#gemini-3-pro-image',
    [
      'Standard image-output components: 1,120 tokens ($0.1344) at 1K and 2K; 2,000 tokens ($0.24) at 4K. Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Search grounding and reference/edit operations carry separate charges and remain unpriced.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 134_400],
        ['2K', 134_400],
        ['4K', 240_000],
      ],
      'Published image-output token equivalent (1,120 / 1,120 / 2,000 tokens at $120 / 1M); input ($2/1M) and thinking ($12/1M) tokens add cost.',
    ),
  ),
  'google-undisclosed|google/nano-banana-2': tariff(
    'Per 1M tokens: $0.50 input; $3.00 text/thinking output; $60.00 image output.',
    google + '#gemini-3.1-flash-image',
    [
      'Standard image-output components: 747 tokens ($0.0448) at 0.5K, 1,120 ($0.0672) at 1K, 1,680 ($0.1008) at 2K and 2,520 ($0.1512) at 4K. Single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Search grounding and reference/edit operations carry separate charges and remain unpriced.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['0.5K', 44_800],
        ['1K', 67_200],
        ['2K', 100_800],
        ['4K', 151_200],
      ],
      'Published image-output token equivalent (747 / 1,120 / 1,680 / 2,520 tokens at $60 / 1M); input ($0.50/1M) and thinking ($3/1M) tokens add cost.',
    ),
  ),
  'google-undisclosed|google/nano-banana-2-lite': tariff(
    'Per 1M tokens: $0.25 input; $1.50 text/thinking output; $30.00 image output.',
    google + '#gemini-3.1-flash-lite-image',
    [
      'Standard 1K image-output component is 1,120 tokens ($0.0336). Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Reference/edit operations remain unpriced.',
    ],
    recheckedAt,
    approxImageRates(
      [['1K', 33_600]],
      'Published 1K image-output token equivalent (1,120 tokens at $30 / 1M); input ($0.25/1M) and thinking ($1.50/1M) tokens add cost.',
    ),
  ),

  // OpenAI first-party
  'openai-undisclosed|openai/gpt-image-2': openai('gpt-image-2'),
  'openai-undisclosed|openai/gpt-image-2.5-flare': openai('gpt-image-2.5-flare'),
  'openai-undisclosed|openai/gpt-image-2.5-sunburst': openai('gpt-image-2.5-sunburst'),
  'openai-undisclosed|openai/gpt-image-2.6-flare': openai('gpt-image-2.6-flare'),
  'openai-undisclosed|openai/gpt-image-2.6-sunburst': openai('gpt-image-2.6-sunburst'),

  // fal aggregator routes
  'fal-undisclosed|openai/gpt-image-2': falGptImage(
    'https://fal.ai/models/openai/gpt-image-2',
    'gpt-image-2',
  ),
  'fal-undisclosed|openai/gpt-image-2/edit': falGptImage(
    'https://fal.ai/models/openai/gpt-image-2/edit',
    'gpt-image-2',
  ),
  'fal-undisclosed|openai/gpt-image-2.5-flare': falGptImage(
    'https://fal.ai/gpt-image-2.5',
    'gpt-image-2.5',
  ),
  'fal-undisclosed|openai/gpt-image-2.5-sunburst': falGptImage(
    'https://fal.ai/gpt-image-2.5',
    'gpt-image-2.5',
  ),
  'fal-undisclosed|openai/gpt-image-2.6-flare': falGptImage(
    'https://fal.ai/models/openai/gpt-image-2.6/flare/text-to-image',
    'gpt-image-2.6',
  ),
  'fal-undisclosed|openai/gpt-image-2.6-sunburst': falGptImage(
    'https://fal.ai/models/openai/gpt-image-2.6/sunburst/text-to-image',
    'gpt-image-2.6',
  ),
  'fal-undisclosed|bytedance/seedream-5.5': tariff(
    'Output image: $0.03 at 1K / 1.5K (up to 2.61MP); $0.0405 at 2K. Editing adds $0.012 per input image per output.',
    'https://fal.ai/models/bytedance/seedream/v5.5/text-to-image',
    [
      'Text-to-image uses fixed output-tier list estimates; image editing incurs per-input-image charges per generated output and remains unpriced.',
    ],
    '2026-11-13',
    outputRates(
      'image',
      [
        ['1K', 30_000],
        ['1.5K', 30_000],
        ['2K', 40_500],
      ],
      'Output-image list rate; image editing adds $0.012 per input image per output.',
    ),
  ),
  'fal-undisclosed|bytedance/seedream-5.0-pro': falSeedream,
  'fal-undisclosed|bytedance/seedream-5.0-flash': tariff(
    '$0.027 / output image across 1K, 1.5K and 2K.',
    'https://fal.ai/models/bytedance/seedream/v5/flash/text-to-image',
    [
      'Published fal endpoint billing unit price is $0.027 per generated image; multi-reference editing surcharges remain unqualified for managed quotes.',
    ],
    recheckedAt,
    outputRates('image', [
      ['1K', 27_000],
      ['1.5K', 27_000],
      ['2K', 27_000],
    ]),
  ),
  'fal-undisclosed|bytedance/seedream-5.0-lite': tariff(
    '$0.035 / output image across 2K, 3K and 4K.',
    'https://fal.ai/models/bytedance/seedream/v5/lite/text-to-image',
    [
      'Text-to-image uses the $0.035 per-image list tariff; image editing remains unpriced for managed quotes.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['2K', 35_000],
      ['3K', 35_000],
      ['4K', 35_000],
    ]),
  ),
  'fal-undisclosed|bytedance/seedream-4.5': tariff(
    '$0.04 / output image across 2K and 4K.',
    'https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image',
    [
      'Text-to-image uses the $0.04 per-image list tariff; image editing remains unpriced for managed quotes.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['2K', 40_000],
      ['4K', 40_000],
    ]),
  ),
  'fal-undisclosed|bytedance/seedream-4.0': tariff(
    '$0.03 / output image across 1K, 2K and 4K.',
    'https://fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image',
    [
      'Published fal endpoint billing unit price is $0.03 per generated image across 1K, 2K and 4K.',
    ],
    recheckedAt,
    outputRates('image', [
      ['1K', 30_000],
      ['2K', 30_000],
      ['4K', 30_000],
    ]),
  ),
  'fal-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.764 input; $8.823 text/thinking output; $35.294 image output.',
    'https://fal.ai/models/google/nano-banana-2.1',
    [
      'Output resolution, prompt length, reference images and thinking consumption affect the total. Published example totals are not fixed per-image charges.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 40_000],
        ['2K', 59_000],
        ['4K', 134_000],
      ],
      'Representative short-prompt medium-thinking example; actual billing follows token consumption.',
    ),
  ),
  'fal-undisclosed|google/nano-banana-pro': tariff(
    'Output image: $0.15 at 1K and 2K; $0.30 at 4K (+$0.015 with web search grounding).',
    'https://fal.ai/models/fal-ai/nano-banana-pro',
    [
      'Single-output 1K text-to-image without grounding uses the $0.15 list estimate; 4K outputs bill at 2× the standard rate ($0.30), web search adds $0.015, and edits remain unpriced for managed quotes.',
    ],
    recheckedAt,
    outputRates(
      'image',
      [
        ['1K', 150_000],
        ['2K', 150_000],
        ['4K', 300_000],
      ],
      'Base output-image rate without web search grounding (+$0.015).',
    ),
  ),
  'fal-undisclosed|google/nano-banana-2': tariff(
    'Output image: $0.06 at 0.5K; $0.08 at 1K; $0.12 at 2K; $0.16 at 4K (+$0.015 web search; +$0.002 high thinking).',
    'https://fal.ai/models/fal-ai/nano-banana-2',
    [
      '0.5K, 2K and 4K bill at 0.75×, 1.5× and 2× the $0.08 1K base rate; single-output 1K text-to-image without grounding uses the $0.08 list estimate while other tiers, grounding, high thinking and edits remain unpriced for managed quotes.',
    ],
    recheckedAt,
    outputRates(
      'image',
      [
        ['0.5K', 60_000],
        ['1K', 80_000],
        ['2K', 120_000],
        ['4K', 160_000],
      ],
      'Base output-image rate without web search (+$0.015) or high thinking (+$0.002).',
    ),
  ),
  'fal-undisclosed|google/nano-banana-2-lite': tariff(
    'Per 1M tokens: $0.3125 text/image input; $1.875 text/thinking output; $37.50 image output.',
    'https://fal.ai/models/google/nano-banana-2-lite',
    [
      'Prompt and thinking token consumption vary per request; fixed 1K image-output component is 1,120 tokens ($0.042) before input and thinking tokens.',
    ],
    recheckedAt,
    approxImageRates(
      [['1K', 42_000]],
      '1K image-output token equivalent (1,120 tokens at $37.50 / 1M); input ($0.3125/1M) and thinking ($1.875/1M) tokens add cost.',
    ),
  ),
  'fal-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Output video: $0.0273 / second at 360p; $0.0819 at 720p; $0.1229 at 1080p; $0.2457 at 4K, plus $1.50 / 1M input tokens.',
    'https://fal.ai/models/google/gemini-omni-flash/v1.2/text-to-video',
    [
      'Text-to-video managed quotes combine the output-second list rate with a conservative $1.50 / 1M prompt-token bound; frame, reference, edit and extend operations incur media input token charges and remain unpriced.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['360p', 27_300],
        ['720p', 81_900],
        ['1080p', 122_900],
        ['4K', 245_700],
      ],
      'Output-second component before $1.50 / 1M prompt/media input tokens.',
    ),
  ),
  'fal-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Output video: $0.03 / second at 360p; $0.10 at 720p; $0.15 at 1080p; $0.30 at 4K.',
    'https://fal.ai/models/google/gemini-omni-flash/v1.1/text-to-video',
    [
      'Text-to-video and image-to-video have fixed output-second list estimates; reference-to-video and source-derived video editing remain comparison-only.',
    ],
    '2026-11-13',
    outputRates('output-second', [
      ['360p', 30_000],
      ['720p', 100_000],
      ['1080p', 150_000],
      ['4K', 300_000],
    ]),
  ),
  'fal-undisclosed|bytedance/seedance-2.0': falSeedance,
  'fal-undisclosed|bytedance/seedance-2.0-fast': falSeedanceFast,
  'fal-undisclosed|bytedance/seedance-2.0-mini': falSeedanceMini,
  'fal-undisclosed|bytedance/seedance-2.5': falSeedance25,
  'fal-undisclosed|bytedance/seedance-1.0-pro': falSeedance1Pro,
  'fal-undisclosed|bytedance/seedance-1.0-pro-fast': falSeedance1ProFast,
  'fal-seedance-us-account-enabled|bytedance/seedance-2.0': regionalTariff(
    'US-hosted: $0.0168 per 1,000 video tokens at 480p / 720p ($0.01008 with video references).',
    'https://fal.ai/models/bytedance/seedance-2.0/us/text-to-video',
    [
      'Dedicated US-inference tariff is higher than fal’s global Seedance 2.0 rate ($0.014 / 1,000 tokens); approved US-company account onboarding is required.',
      'Token count follows width × height × duration × 24 ÷ 1,024; with video inputs the price is multiplied by 0.6 across combined input and output duration.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['480p', 173_100],
        ['720p', 370_000],
      ],
      'US-hosted worked example without video inputs; requires account-enabled US access.',
    ),
  ),
  'fal-undisclosed|minimax/h3-max': tariff(
    'Standard output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p (Nov 1–15, 2026 promo: $0.035 / $0.056 / $0.112).',
    'https://fal.ai/models/minimax/h3-max/text-to-video',
    [
      'November 1–15, 2026 promotional rates are $0.035/$0.056/$0.112 per second at 480p/768p/1080p; standard rates resume November 16. Quotes conservatively use standard list rates without promotional discounts.',
      'Reference tokens beyond the included quota have additional charges; only text-to-video without input media and with prompt expansion disabled has a qualified estimate.',
      'Billing follows generated video seconds; output can run about 0.7 seconds longer than requested. Requested-duration estimates are not settled charges or guaranteed ceilings.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['768p', 80_000],
        ['1080p', 160_000],
      ],
      'Standard list rate; Nov 1–15, 2026 promotional rate is 30% lower ($0.035/$0.056/$0.112 per second).',
    ),
  ),
  'fal-undisclosed|minimax/h3-max/image-to-video': tariff(
    'Standard output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p (Nov 1–15, 2026 promo: $0.035 / $0.056 / $0.112).',
    'https://fal.ai/models/minimax/h3-max/image-to-video',
    [
      'Active November 1–15, 2026 promotional rates are $0.035/$0.056/$0.112 per second at 480p/768p/1080p; standard rates resume November 16.',
      'Actual generated clip duration determines billing; image-to-video execution quotes remain unqualified.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['768p', 80_000],
        ['1080p', 160_000],
      ],
      'Standard list rate; Nov 1–15, 2026 promotional rate is 30% lower ($0.035/$0.056/$0.112 per second).',
    ),
  ),
  'fal-undisclosed|minimax/h3-max/reference-to-video': tariff(
    'Output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p (+$0.02 / 1,000 reference tokens above 4,096).',
    'https://fal.ai/models/minimax/h3-max/reference-to-video',
    [
      'Includes 4,096 reference tokens per request; additional reference tokens cost $0.02 per 1,000 tokens, prorated.',
      'If reference images are omitted, auto-generated reference images add roughly $0.02–$0.04 each.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['768p', 80_000],
        ['1080p', 160_000],
      ],
      'Output-video component before reference-token usage above 4,096 tokens.',
    ),
  ),
  'fal-undisclosed|fal/h3-max-turbo': tariff(
    'Standard output video: $0.025 / second at 480p; $0.04 at 768p; $0.08 at 1080p (Nov 1–15, 2026 promo: $0.0175 / $0.028 / $0.056).',
    'https://fal.ai/models/minimax/h3-max-turbo/text-to-video',
    [
      'November 1–15, 2026 promotional rates are $0.0175/$0.028/$0.056 per second at 480p/768p/1080p; standard rates resume November 16. Quotes conservatively use standard rates without promotional discounts.',
      'Only text-to-video without input media and with prompt expansion disabled has a qualified estimate. Reference/edit inputs and other expansion modes remain unpriced.',
      'Billing follows generated video seconds; output can run about 0.7 seconds longer than requested. Requested-duration estimates are not settled charges or guaranteed ceilings.',
    ],
    '2026-11-03',
    outputRates('output-second', [
      ['480p', 25_000],
      ['768p', 40_000],
      ['1080p', 80_000],
    ]),
  ),
  'fal-undisclosed|minimax/h3-max-turbo/image-to-video': tariff(
    'Standard output video: $0.025 / second at 480p; $0.04 at 768p; $0.08 at 1080p (Nov 1–15, 2026 promo: $0.0175 / $0.028 / $0.056).',
    'https://fal.ai/models/minimax/h3-max-turbo/image-to-video',
    [
      'November 1–15, 2026 promotional rates are $0.0175/$0.028/$0.056 per second at 480p/768p/1080p; standard rates resume November 16.',
      'Billing follows generated video seconds; image-to-video execution quotes remain unqualified.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 25_000],
        ['768p', 40_000],
        ['1080p', 80_000],
      ],
      'Standard list rate; Nov 1–15, 2026 promotional rate is $0.0175/$0.028/$0.056 per second.',
    ),
  ),
  'fal-undisclosed|minimax/h3-max-turbo/reference-to-video': tariff(
    'Output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p (+$0.016 / 1,000 reference tokens above 4,096).',
    'https://fal.ai/models/minimax/h3-max-turbo/reference-to-video',
    [
      'H3 Max Turbo reference-to-video has a higher per-second base tariff than text/image-to-video and includes 4,096 reference tokens before charging $0.016 per 1,000 additional tokens.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['768p', 80_000],
        ['1080p', 160_000],
      ],
      'Output-video component before reference-token charges beyond 4,096 tokens.',
    ),
  ),
  'fal-undisclosed|minimax/h3': tariff(
    'Output video: $0.05 / second at 480p; $0.06 at 768p; $0.13 at 2K; $0.16 at 4K.',
    'https://fal.ai/models/minimax/h3/text-to-video',
    [
      'Text-to-video and image-to-video with prompt expansion disabled use output-second list estimates; reference-to-video includes up to 5 reference images, then adds $0.08 per additional reference image.',
    ],
    '2026-11-13',
    outputRates('output-second', [
      ['480p', 50_000],
      ['768p', 60_000],
      ['2K', 130_000],
      ['4K', 160_000],
    ]),
  ),
  'fal-undisclosed|minimax/h3-image': tariff(
    'Per 1M tokens: $2.30 text input; $1.50 image input; $3.80 image output.',
    'https://fal.ai/models/minimax/h3-image/text-to-image',
    [
      'Prompt enhancement and actual delivered pixel dimensions determine token charges; no fixed per-image rate applies.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 7_800],
        ['2K', 19_000],
        ['4K', 76_000],
      ],
      'Image-output token ceiling equivalent (2,048 / 5,000 / 20,000 tokens at $3.80 / 1M); prompt/enhancement ($2.30/1M) and reference-image ($1.50/1M) tokens add cost.',
    ),
  ),
  'fal-undisclosed|minimax/h3-image-highspeed': tariff(
    'Per 1M tokens: $2.30 text input (including prompt enhancement); $3.00 image input; $7.60 image output.',
    'https://fal.ai/models/minimax/h3-image/highspeed/text-to-image',
    [
      'Prompt enhancement and actual delivered pixel dimensions determine token charges; no fixed per-image rate applies.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 15_600],
        ['2K', 38_000],
        ['4K', 152_000],
      ],
      'Image-output token ceiling equivalent (2,048 / 5,000 / 20,000 tokens at $7.60 / 1M); prompt/enhancement ($2.30/1M) and reference-image ($3.00/1M) tokens add cost.',
    ),
  ),
  'fal-undisclosed|kling/kling-4.0': tariff(
    'Output video without video input: $0.157 / second at 720p; $0.235 at 1080p. With video input: $0.094 / second at 720p; $0.141 at 1080p across active input and output seconds.',
    'https://fal.ai/models/kling/v4/text-to-video',
    [
      'Text-to-video and image-to-video use output-second list estimates; reference-to-video and video-edit remain unpriced because video references/source duration alter total billing.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['720p', 157_000],
        ['1080p', 235_000],
      ],
      'Output rate without video references; video-reference requests bill $0.094/$0.141 per second across input + output length.',
    ),
  ),
  'fal-undisclosed|kling/kling-4.0-flash': tariff(
    'Output video without video input: $0.094 / second at 720p. With video input: $0.063 / second billed on output duration plus max(input video duration, output duration).',
    'https://fal.ai/models/kling/v4/flash/text-to-video',
    [
      'Text-to-video and image-to-video use the $0.094 / second list estimate; reference-to-video and video-edit remain unpriced.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [['720p', 94_000]],
      'Output rate without video input; video-input requests bill $0.063/sec on output + max(input, output).',
    ),
  ),
  'fal-undisclosed|alibaba/wan-3.0': tariff(
    'Output video: $0.05 / second at 480p; $0.10 at 720p; $0.20 at 1080p.',
    'https://fal.ai/models/alibaba/wan-3.0/text-to-video',
    [
      'Provider states pricing is subject to change. Reference-to-video has separate input considerations and remains unpriced.',
    ],
    '2026-11-13',
    outputRates('output-second', [
      ['480p', 50_000],
      ['720p', 100_000],
      ['1080p', 200_000],
    ]),
  ),
  'fal-undisclosed|alibaba/wan-3.0-prime': tariff(
    'Output video: $0.068 / second at 480p; $0.14 at 720p; $0.28 at 1080p.',
    'https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video',
    ['Provider states pricing is subject to change. Reference-to-video remains unpriced.'],
    '2026-11-13',
    outputRates('output-second', [
      ['480p', 68_000],
      ['720p', 140_000],
      ['1080p', 280_000],
    ]),
  ),
  'fal-undisclosed|alibaba/happy-horse-1.1': tariff(
    'Output video: $0.14 / second across 720p and 1080p.',
    'https://fal.ai/models/alibaba/happy-horse/v1.1/text-to-video',
    [
      'Text-to-video and image-to-video use the $0.14 / second list estimate; reference-to-video remains unpriced for managed quotes.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['720p', 140_000],
      ['1080p', 140_000],
    ]),
  ),
  'fal-undisclosed|fal/qwen-image-3': tariff(
    'Output image: $0.04 at 1K; $0.075 at 2K.',
    'https://fal.ai/models/alibaba/qwen-image-3/text-to-image',
    [
      'Text-to-image has fixed output-tier list estimates; image-edit reference billing remains unpriced.',
    ],
    '2026-11-13',
    outputRates('image', [
      ['1K', 40_000],
      ['2K', 75_000],
    ]),
  ),
  'fal-undisclosed|bfl/flux-3-image': tariff(
    '$0.048 per output megapixel.',
    'https://fal.ai/models/blackforestlabs/flux-3/text-to-image',
    [
      'Actual megapixel count varies with aspect ratio and resolution tier; flat tier fees are not assumed.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['768sq', 28_300],
        ['1K', 50_300],
        ['1.5K', 113_200],
        ['2K', 201_300],
        ['4K', 805_300],
      ],
      '1:1 square megapixel equivalent (768²–4096² at $0.048 / MP); non-square aspect ratios bill exact output megapixels.',
    ),
  ),
  'fal-undisclosed|bfl/flux-3-klein': tariff(
    '$0.009 per output megapixel.',
    'https://fal.ai/models/blackforestlabs/flux-3/klein/text-to-image',
    ['Actual megapixel count varies with image_size dimensions; flat tier fees are not assumed.'],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 9_400],
        ['2K', 37_700],
        ['4K', 151_000],
      ],
      '1:1 square megapixel equivalent (1024² / 2048² / 4096² at $0.009 / MP); non-square aspect ratios bill exact output megapixels.',
    ),
  ),
  'fal-undisclosed|bfl/flux-3-video': tariff(
    'Output video: $0.17 / second at 720p; $0.29 at 1080p; $0.32 at 1440p; $0.47 at 2160p.',
    'https://fal.ai/models/blackforestlabs/flux-3/text-to-video',
    [
      'Text-to-video and image-to-video with fixed numeric duration use regular output-second list rates; auto duration and video-extend remain unpriced.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['720p', 170_000],
      ['1080p', 290_000],
      ['1440p', 320_000],
      ['2160p', 470_000],
    ]),
  ),
  'fal-undisclosed|blackforestlabs/flux-3/edit-video': tariff(
    'Video editing output: $0.03 / second of generated video (720p).',
    'https://fal.ai/models/blackforestlabs/flux-3/edit-video',
    ['Source-derived video editing duration remains unpriced for managed reservations.'],
    recheckedAt,
    outputRates('output-second', [['', 30_000]]),
  ),
  'fal-undisclosed|fal/flux-3-max-video': tariff(
    'Regular output video list rates: $0.17 / second at 720p; $0.29 at 1080p.',
    'https://fal.ai/models/blackforestlabs/flux-3-max/text-to-video',
    [
      'Temporary 50% promotional rates ($0.085/$0.145 through November 22, 2026 UTC; resuming regular list rates November 23) are excluded so managed reservations never under-reserve.',
      '2K and 4K list rates are not explicitly itemized in prose and remain unpriced.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['720p', 170_000],
      ['1080p', 290_000],
    ]),
  ),
  'fal-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.08 / second at 480p; $0.14 at 720p; $0.25 at 1080p (+$0.01 / input or reference image).',
    'https://fal.ai/models/xai/grok-imagine-video/v1.5/text-to-video',
    [
      'Image-to-video and reference-to-video add $0.01 per input image (1–7 supported); reference audio is included at no extra cost. Reference-to-video supports 480p and 720p.',
    ],
    '2026-11-13',
    outputRates(
      'output-second',
      [
        ['480p', 80_000],
        ['720p', 140_000],
        ['1080p', 250_000],
      ],
      'Output-second rate; image/reference inputs add $0.01 per image.',
    ),
  ),
  'fal-undisclosed|xai/grok-imagine-video-1.5-lite': tariff(
    'Output video: $0.02 / second at 480p; $0.03 at 720p; $0.14 at 1080p (+$0.01 / input image).',
    'https://fal.ai/models/xai/grok-imagine-video/v1.5/lite/text-to-video',
    ['Image-to-video adds $0.01 per input image; 1080p uses upscaling.'],
    '2026-11-13',
    outputRates(
      'output-second',
      [
        ['480p', 20_000],
        ['720p', 30_000],
        ['1080p', 140_000],
      ],
      'Output-second rate; image-to-video adds $0.01 per input image.',
    ),
  ),
  'fal-undisclosed|xai/grok-imagine-video': tariff(
    'Output video: $0.05 / second at 480p; $0.07 at 720p (+$0.01 / second of input video).',
    'https://fal.ai/models/xai/grok-imagine-video/edit-video',
    [
      'Video edit and video extension bill output duration by resolution plus $0.01 per second of source input video.',
    ],
    '2026-11-13',
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['720p', 70_000],
      ],
      'Output-video component; source input video adds $0.01 per second.',
    ),
  ),
  'fal-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 1.5K $0.05 / 2K $0.06; medium 1K $0.06 / 1.5K $0.07 / 2K $0.08 (+$0.01 / input image on edit).',
    'https://fal.ai/models/xai/grok-imagine-image/v2.0/text-to-image',
    [
      'Single text-generated images at low/default quality have fixed output-tier estimates; medium/auto quality and image edits (+$0.01 per input image) remain unpriced.',
    ],
    '2026-11-13',
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 40_000],
          ['1.5K', 50_000],
          ['2K', 60_000],
        ],
        'Low-quality output rate; medium quality is $0.06/$0.07/$0.08 and edits add $0.01 per input image.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 60_000],
          ['1.5K', 70_000],
          ['2K', 80_000],
        ],
        'Medium-quality output rate; edits add $0.01 per input image.',
      )!,
    ],
  ),

  // Pika aggregator routes
  'pika-undisclosed|pika/h3-flex': tariff(
    'Output video: $0.01 / second at 480p; $0.02 at 768p; $0.035 at 1080p; $0.04 at 2K; $0.08 at 4K.',
    'https://dev.pika.art/models/pika/pika-h3-flex/text-to-video/pricing',
    [
      'Applies to text-to-video and image-to-video with prompt rewriting ($0.02/request) and audio stems ($0.001/sec) disabled.',
      'Resolutions above 768p use upscaling.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 10_000],
      ['768p', 20_000],
      ['1080p', 35_000],
      ['2K', 40_000],
      ['4K', 80_000],
    ]),
  ),
  'pika-undisclosed|pika/pika-h3-flex/reference-to-video': tariff(
    'Output video: $0.03 / second at 480p; $0.06 at 768p; $0.075 at 1080p; $0.08 at 2K; $0.10 at 4K.',
    'https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/pricing',
    [
      'Image-reference generation output rates with rewriting and audio stems disabled; video inputs add matching per-second video-input charges.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 30_000],
      ['768p', 60_000],
      ['1080p', 75_000],
      ['2K', 80_000],
      ['4K', 100_000],
    ]),
  ),
  'pika-undisclosed|bytedance/seedance-2.5': tariff(
    'Per 1M video output tokens: $11.235 at 480p/720p; $12.285 at 1080p ($5.17 at 4K; with video input: $6.72 / $7.35 / $3.19).',
    'https://dev.pika.art/models/bytedance/seedance-2.5/text-to-video',
    [
      'Billed from actual video output token consumption (width × height × 24 × duration ÷ 1,024); reference-to-video with video input uses the reduced per-token rate across combined video tokens.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['480p', 107_900],
        ['720p', 242_700],
        ['1080p', 597_100],
      ],
      '16:9 token-formula equivalent without video input (width × height × 24 ÷ 1,024). Actual billing follows generated video tokens.',
    ),
  ),
  'pika-undisclosed|bytedance/seedance-2.0': tariff(
    'Per 1M video output tokens: $7.35 at 480p/720p; $8.085 at 1080p; $4.20 at 4K (with video input: $4.515 / $4.935 / $2.52).',
    'https://dev.pika.art/models/bytedance/seedance-2.0/text-to-video',
    [
      'Billed from actual video output token consumption (width × height × 24 × duration ÷ 1,024); reference-to-video with video input uses the reduced per-token rate across combined video tokens.',
    ],
    recheckedAt,
    approxVideoRates(
      [
        ['480p', 73_800],
        ['720p', 158_800],
        ['1080p', 392_900],
        ['4K', 816_500],
      ],
      '16:9 token-formula equivalent without video input (width × height × 24 ÷ 1,024). Actual billing follows generated video tokens.',
    ),
  ),
  'pika-undisclosed|bytedance/seedance-2.0-fast': tariff(
    'Per 1M video output tokens: $5.88 at 480p and 720p ($3.465 with video input).',
    'https://dev.pika.art/models/bytedance/seedance-2.0-fast/text-to-video',
    ['Billed from actual video output token consumption (width × height × 24 × duration ÷ 1,024).'],
    recheckedAt,
    approxVideoRates(
      [
        ['480p', 59_100],
        ['720p', 127_000],
      ],
      '16:9 token-formula equivalent without video input (width × height × 24 ÷ 1,024). Actual billing follows generated video tokens.',
    ),
  ),
  'pika-undisclosed|bytedance/seedance-2.0-mini': tariff(
    'Per 1M video output tokens: $3.675 at 480p and 720p ($2.205 with video input).',
    'https://dev.pika.art/models/bytedance/seedance-2.0-mini/text-to-video',
    ['Billed from actual video output token consumption (width × height × 24 × duration ÷ 1,024).'],
    recheckedAt,
    approxVideoRates(
      [
        ['480p', 36_900],
        ['720p', 79_400],
      ],
      '16:9 token-formula equivalent without video input (width × height × 24 ÷ 1,024). Actual billing follows generated video tokens.',
    ),
  ),
  'pika-undisclosed|bytedance/seedream-5.0-pro': tariff(
    '$0.03825 / output image at 1K and 1.5K; $0.0765 at 2K (+$0.00255 / input image on edit).',
    'https://dev.pika.art/models/bytedance/seedream-5.0-pro/text-to-image',
    [
      'Image-to-image editing adds $0.00255 per input image; layer decomposition is a separate endpoint ($0.019125 / $0.03825).',
    ],
    recheckedAt,
    outputRates(
      'image',
      [
        ['1K', 38_250],
        ['1.5K', 38_250],
        ['2K', 76_500],
      ],
      'Output-image rate; image editing adds $0.00255 per input image.',
    ),
  ),
  'pika-undisclosed|alibaba/wan-3.0': tariff(
    'Output video: $0.0325 / second at 480p; $0.065 at 720p; $0.13 at 1080p.',
    'https://dev.pika.art/models/alibaba/wan3.0-video/text-to-video',
    [
      'Omni reference-to-video adds matching per-second video-input charges ($0.0325 / $0.065 / $0.13 per input second).',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 32_500],
        ['720p', 65_000],
        ['1080p', 130_000],
      ],
      'Output-second rate; omni reference-to-video adds matching per-second video-input billing.',
    ),
  ),
  'pika-undisclosed|alibaba/wan-3.0-prime': tariff(
    'Output video: $0.051 / second at 480p; $0.105 at 720p; $0.21 at 1080p.',
    'https://dev.pika.art/models/alibaba/wan3.0-video-prime/text-to-video',
    [
      'Omni reference-to-video adds matching per-second video-input charges ($0.051 / $0.105 / $0.21 per input second).',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 51_000],
        ['720p', 105_000],
        ['1080p', 210_000],
      ],
      'Output-second rate; omni reference-to-video adds matching per-second video-input billing.',
    ),
  ),
  'pika-undisclosed|kling/kling-4.0': tariff(
    'Without video input: $0.157 / second at 720p; $0.235 at 1080p (omni video input: $0.094 / $0.141).',
    'https://dev.pika.art/models/kling/kling-4.0/text-to-video',
    [
      'Omni-video requests with video input charge $0.094/$0.141 per second across input and output billing rules.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['720p', 157_000],
        ['1080p', 235_000],
      ],
      'Output rate without video input; omni-video with video input bills $0.094/$0.141 per second.',
    ),
  ),
  'pika-undisclosed|minimax/h3': tariff(
    'Output video: $0.08 / second at 768p; $0.13 at 2K.',
    'https://dev.pika.art/models/minimax/h3/text-to-video',
    [
      'Reference-to-video adds matching per-second video-input charges plus $0.04 per input image beyond 5 included images.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['768p', 80_000],
        ['2K', 130_000],
      ],
      'Output-second rate; reference-to-video adds video-input duration and >5 image charges.',
    ),
  ),
  'pika-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text output; $17.50 video output.',
    'https://dev.pika.art/models/google/gemini-omni-1.1-flash/text-to-video',
    ['Token-based billing across prompt input, text/thinking output and generated video tokens.'],
    recheckedAt,
    approxVideoRates(
      [
        ['360p', 33_800],
        ['720p', 101_400],
        ['1080p', 152_000],
        ['4K', 304_100],
      ],
      'Video-output token equivalent at $17.50 / 1M tokens (1,931 / 5,792 / 8,688 / 17,376 tokens/sec); input ($1.50/1M) and text/thinking ($9/1M) tokens add cost.',
    ),
  ),
  'pika-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.50 input; $7.50 text output; $30 image output.',
    'https://dev.pika.art/models/google/gemini-nano-banana-2.1/text-to-image',
    ['Token-based billing depends on prompt, thinking and output resolution token usage.'],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 33_600],
        ['2K', 50_400],
        ['4K', 113_000],
      ],
      'Image-output token equivalent at $30 / 1M tokens; prompt input ($1.50/1M) and text/thinking ($7.50/1M) tokens add cost.',
    ),
  ),
  'pika-undisclosed|openai/gpt-image-2.5-flare/text-to-image': pikaGpt25('flare', 'text-to-image'),
  'pika-undisclosed|openai/gpt-image-2.5-flare/image-to-image': pikaGpt25(
    'flare',
    'image-to-image',
  ),
  'pika-undisclosed|openai/gpt-image-2.5-sunburst/text-to-image': pikaGpt25(
    'sunburst',
    'text-to-image',
  ),
  'pika-undisclosed|openai/gpt-image-2.5-sunburst/image-to-image': pikaGpt25(
    'sunburst',
    'image-to-image',
  ),
  'pika-undisclosed|openai/gpt-image-2/text-to-image': tariff(
    'Per 1M tokens: $3.75 text input; $22.50 image output.',
    'https://dev.pika.art/models/openai/gpt-image-2/text-to-image',
    [
      'Token consumption varies with output dimensions, quality (low/medium/high) and prompt length.',
    ],
    recheckedAt,
    gptImageFamilyApproxRates(
      'gpt-image-2',
      22.5,
      'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $22.50 / 1M output tokens; high is ≈$0.158 / $0.3211 / $0.3002 and prompt tokens ($3.75/1M) add cost.',
      'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $22.50 / 1M output tokens; prompt tokens ($3.75/1M) add cost.',
    ),
  ),
  'pika-undisclosed|openai/gpt-image-2/image-to-image': tariff(
    'Per 1M tokens: $5.00 text input; $8.00 image input; $30.00 image output.',
    'https://dev.pika.art/models/openai/gpt-image-2/image-to-image',
    ['Image editing on Pika uses higher per-token input/output tiers than text-to-image.'],
    recheckedAt,
    gptImageFamilyApproxRates(
      'gpt-image-2',
      30,
      'Medium-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens; prompt ($5/1M) and input-image ($8/1M) tokens add cost.',
      'High-quality canonical image-output token equivalent (1024×1024, 2048×2048, 3840×2160) at $30 / 1M output tokens; prompt ($5/1M) and input-image ($8/1M) tokens add cost.',
    ),
  ),
  'pika-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.042 / 2K $0.063; medium 1K $0.063 / 2K $0.084 (+$0.0105 / input image on edit).',
    'https://dev.pika.art/models/x-ai/grok-imagine-image-2.0/text-to-image',
    [
      'Quality tier (low/medium/auto) and input-image count (+$0.0105 each on edit) determine cost.',
    ],
    recheckedAt,
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 42_000],
          ['2K', 63_000],
        ],
        'Low-quality output rate; medium quality is $0.063/$0.084 and edits add $0.0105 per input image.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 63_000],
          ['2K', 84_000],
        ],
        'Medium-quality output rate; edits add $0.0105 per input image.',
      )!,
    ],
  ),
  'pika-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.084 / second at 480p; $0.147 at 720p (+$0.0105 / input image).',
    'https://dev.pika.art/models/x-ai/grok-imagine-video-1.5/image-to-video',
    ['Image-to-video adds $0.0105 per input image in addition to output-second billing.'],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 84_000],
        ['720p', 147_000],
      ],
      'Output-second component; each input image adds $0.0105.',
    ),
  ),
  'pika-undisclosed|xai/grok-imagine-video': tariff(
    'Video editing output: $0.084 / second at 480p and 720p.',
    'https://dev.pika.art/models/x-ai/grok-imagine-video/video-to-video',
    ['Applies to Pika’s Grok Imagine video-to-video editing endpoint.'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 84_000],
      ['720p', 84_000],
    ]),
  ),

  // Replicate aggregator routes
  'replicate-undisclosed|bytedance/seedream-5.0-pro': tariff(
    '$0.045 / output image at 1K; $0.09 at 2K.',
    'https://replicate.com/bytedance/seedream-5-pro#pricing',
    ['Standard image-generation output pricing; layer decomposition is a separate operation.'],
    checkedAt,
    outputRates('image', [
      ['1K', 45_000],
      ['2K', 90_000],
    ]),
  ),
  'replicate-undisclosed|bytedance/seedance-2.5': tariff(
    'Without input video: $0.1028 / output second at 480p; $0.2312 at 720p.',
    'https://replicate.com/bytedance/seedance-2.5',
    [
      'The source has a separate video-input category: $0.4304 / output second at 480p or $0.9676 at 720p.',
      'Do not use the page’s generic hardware price or cached median as this conditional output tariff.',
    ],
    checkedAt,
    outputRates('output-second', [
      ['480p', 102_800],
      ['720p', 231_200],
    ]),
  ),
  'replicate-undisclosed|bytedance/seedance-2.0': tariff(
    'Without input video: $0.08 / second at 480p; $0.18 at 720p; $0.45 at 1080p; $1.00 at 4K.',
    'https://replicate.com/bytedance/seedance-2.0',
    [
      'With video input (reference_videos), output-second rates are $0.10 at 480p, $0.22 at 720p, $0.55 at 1080p and $1.25 at 4K.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 80_000],
        ['720p', 180_000],
        ['1080p', 450_000],
        ['4K', 1_000_000],
      ],
      'Non-video-input rate; with reference video input: $0.10 / $0.22 / $0.55 / $1.25 per second.',
    ),
  ),
  'replicate-undisclosed|bytedance/seedance-2.0-fast': tariff(
    'Without input video: $0.07 / second at 480p; $0.15 at 720p (with video input: $0.08 / $0.17).',
    'https://replicate.com/bytedance/seedance-2.0-fast',
    ['With reference video input, output-second rates are $0.08 at 480p and $0.17 at 720p.'],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 70_000],
        ['720p', 150_000],
      ],
      'Non-video-input rate; with reference video input: $0.08 / $0.17 per second.',
    ),
  ),
  'replicate-undisclosed|bytedance/seedance-2.0-mini': tariff(
    'Without input video: $0.04 / second at 480p; $0.09 at 720p (with video input: $0.05 / $0.11).',
    'https://replicate.com/bytedance/seedance-2.0-mini',
    ['With reference video input, output-second rates are $0.05 at 480p and $0.11 at 720p.'],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 40_000],
        ['720p', 90_000],
      ],
      'Non-video-input rate; with reference video input: $0.05 / $0.11 per second.',
    ),
  ),
  'replicate-undisclosed|kling/kling-4.0': tariff(
    'Without video input: $0.157 / second at 720p; $0.235 at 1080p (with video input: $0.094 / $0.141).',
    'https://replicate.com/kwaivgi/kling-v4.0',
    [
      'With video input (base_video or reference_videos), billed seconds equal output duration plus max(input duration, output duration) at $0.094/$0.141 per second.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['720p', 157_000],
        ['1080p', 235_000],
      ],
      'Text/image/reference-image rate; video input bills $0.094/$0.141 per second on output + max(input, output).',
    ),
  ),
  'replicate-undisclosed|alibaba/wan-3.0': tariff(
    'Output video: $0.035 / second at 480p; $0.07 at 720p; $0.14 at 1080p.',
    'https://replicate.com/alibaba/wan-3',
    ['Supports text-to-video and starting-image generation from 2 through 30 seconds.'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 35_000],
      ['720p', 70_000],
      ['1080p', 140_000],
    ]),
  ),
  'replicate-undisclosed|alibaba/wan-3.0-prime': tariff(
    'Output video: $0.068 / second at 480p; $0.14 at 720p; $0.28 at 1080p.',
    'https://replicate.com/alibaba/wan-3-prime',
    ['Supports text-to-video and starting-image generation from 2 through 30 seconds.'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 68_000],
      ['720p', 140_000],
      ['1080p', 280_000],
    ]),
  ),
  'replicate-undisclosed|alibaba/qwen-image-3.0-pro': tariff(
    '$0.04 / output image at 1K and 2K.',
    'https://replicate.com/alibaba/qwen-image-3-pro',
    ['Flat per-output-image billing tier on Replicate’s official Qwen Image 3.0 Pro deployment.'],
    recheckedAt,
    outputRates('image', [
      ['1K', 40_000],
      ['2K', 40_000],
    ]),
  ),
  'replicate-undisclosed|minimax/h3': tariff(
    'Output video: $0.08 / second at 768p; $0.13 at 2K (+reference video at output rate).',
    'https://replicate.com/minimax/h3',
    [
      'Reference video inputs are billed per second at the same rate as the selected output resolution.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['768p', 80_000],
        ['2K', 130_000],
      ],
      'Output-second rate; reference video input adds the same per-second rate.',
    ),
  ),
  'replicate-undisclosed|minimax/h3-highspeed': tariff(
    'Output video: $0.03 / second at 768p (+reference video at output rate).',
    'https://replicate.com/minimax/h3-highspeed',
    [
      'Replicate serves MiniMax H3 Highspeed at 768P; reference video input bills at the same per-second rate.',
    ],
    recheckedAt,
    outputRates('output-second', [['768p', 30_000]]),
  ),
  'replicate-undisclosed|minimax/h3-lite': tariff(
    'Output video: $0.0125 / second at 480p; $0.02 at 768p (+reference video at output rate).',
    'https://replicate.com/minimax/h3-lite',
    [
      'Reference video inputs are billed per second at the same rate as the selected output resolution.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 12_500],
      ['768p', 20_000],
    ]),
  ),
  'replicate-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Output video: $0.05 / second at 360p; $0.15 at 720p; $0.23 at 1080p; $0.45 at 4K.',
    'https://replicate.com/google/gemini-omni-1.1',
    ['Billed per second of output video by target resolution on Replicate.'],
    recheckedAt,
    outputRates('output-second', [
      ['360p', 50_000],
      ['720p', 150_000],
      ['1080p', 230_000],
      ['4K', 450_000],
    ]),
  ),
  'replicate-undisclosed|google/nano-banana-2.1': tariff(
    '$0.0336 / output image at 1K; $0.0504 at 2K; $0.1134 at 4K.',
    'https://replicate.com/google/nano-banana-2.1',
    ['Billed per output image by target resolution on Replicate.'],
    recheckedAt,
    outputRates('image', [
      ['1K', 33_600],
      ['2K', 50_400],
      ['4K', 113_400],
    ]),
  ),
  'replicate-undisclosed|openai/gpt-image-2': tariff(
    'Per output image by quality: low $0.012; medium $0.047; high/auto $0.128.',
    'https://replicate.com/openai/gpt-image-2',
    [
      'Priced per output image by quality tier rather than resolution; default quality is auto ($0.128).',
    ],
    recheckedAt,
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 12_000],
          ['2K', 12_000],
          ['4K', 12_000],
        ],
        'Low-quality output rate ($0.012/image across 1K–4K); medium is $0.047 and high/auto is $0.128.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 47_000],
          ['2K', 47_000],
          ['4K', 47_000],
        ],
        'Medium-quality output rate ($0.047/image across 1K–4K); Replicate auto/high is $0.128 and low is $0.012.',
      )!,
      ...qualityImageRates(
        'high',
        [
          ['1K', 128_000],
          ['2K', 128_000],
          ['4K', 128_000],
        ],
        'High-quality output rate ($0.128/image across 1K–4K); medium is $0.047 and low is $0.012.',
      )!,
      ...qualityImageRates(
        'auto',
        [
          ['1K', 128_000],
          ['2K', 128_000],
          ['4K', 128_000],
        ],
        'Auto-quality output rate ($0.128/image across 1K–4K); medium is $0.047 and low is $0.012.',
      )!,
    ],
  ),
  'replicate-undisclosed|openai/gpt-image-2.5-flare': tariff(
    'Per output image by quality: low $0.012; medium $0.047; high $0.128; xhigh/auto $0.25; max $0.50.',
    'https://replicate.com/openai/gpt-image-2.5-flare',
    [
      'Priced per output image by quality tier rather than resolution; default quality is auto ($0.25).',
    ],
    recheckedAt,
    (
      [
        ['low', 12_000, 'Low-quality output rate ($0.012/image across 1K–4K).'],
        [
          'medium',
          47_000,
          'Medium-quality output rate ($0.047/image across 1K–4K); Replicate auto/xhigh default is $0.25.',
        ],
        ['high', 128_000, 'High-quality output rate ($0.128/image across 1K–4K).'],
        ['xhigh', 250_000, 'Extra-high quality output rate ($0.25/image across 1K–4K).'],
        ['auto', 250_000, 'Auto-quality output rate ($0.25/image across 1K–4K).'],
        ['max', 500_000, 'Max-quality output rate ($0.50/image across 1K–4K).'],
      ] as const
    ).flatMap(([quality, usdMicros, note]) =>
      qualityImageRates(
        quality,
        [
          ['1K', usdMicros],
          ['2K', usdMicros],
          ['4K', usdMicros],
        ],
        note,
      )!,
    ),
  ),
  'replicate-undisclosed|openai/gpt-image-2.5-sunburst': tariff(
    'Per output image by quality: low $0.012; medium $0.047; high $0.128; xhigh/auto $0.25; max $0.50.',
    'https://replicate.com/openai/gpt-image-2.5-sunburst',
    [
      'Priced per output image by quality tier rather than resolution; default quality is auto ($0.25).',
    ],
    recheckedAt,
    (
      [
        ['low', 12_000, 'Low-quality output rate ($0.012/image across 1K–4K).'],
        [
          'medium',
          47_000,
          'Medium-quality output rate ($0.047/image across 1K–4K); Replicate auto/xhigh default is $0.25.',
        ],
        ['high', 128_000, 'High-quality output rate ($0.128/image across 1K–4K).'],
        ['xhigh', 250_000, 'Extra-high quality output rate ($0.25/image across 1K–4K).'],
        ['auto', 250_000, 'Auto-quality output rate ($0.25/image across 1K–4K).'],
        ['max', 500_000, 'Max-quality output rate ($0.50/image across 1K–4K).'],
      ] as const
    ).flatMap(([quality, usdMicros, note]) =>
      qualityImageRates(
        quality,
        [
          ['1K', usdMicros],
          ['2K', usdMicros],
          ['4K', usdMicros],
        ],
        note,
      )!,
    ),
  ),
  'replicate-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 2K $0.06; medium (default) 1K $0.06 / 2K $0.08 (+$0.01 / input MP).',
    'https://replicate.com/xai/grok-imagine-image-2',
    [
      'Replicate defaults to medium quality ($0.06 at 1K, $0.08 at 2K) and adds $0.01 per input image megapixel when editing.',
    ],
    recheckedAt,
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 40_000],
          ['2K', 60_000],
        ],
        'Low-quality output rate; Replicate default is medium ($0.06/$0.08) and edits add $0.01 per input MP.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 60_000],
          ['2K', 80_000],
        ],
        'Default medium-quality output rate; low quality is $0.04/$0.06 and edits add $0.01 per input MP.',
      )!,
    ],
  ),
  'replicate-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Image-to-video output: $0.08 / second at 480p and 720p.',
    'https://replicate.com/xai/grok-imagine-video-1.5',
    [
      'Replicate’s Grok Imagine Video 1.5 deployment requires a starting image and bills $0.08 per output second.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 80_000],
      ['720p', 80_000],
    ]),
  ),
  'replicate-undisclosed|xai/grok-imagine-video': tariff(
    'Video edit output: $0.05 / second ($0.07 / second for 720p generation).',
    'https://replicate.com/xai/grok-imagine-video',
    [
      'Replicate’s billing tier charges $0.05 / output second for video edits and 480p, or $0.07 at 720p generation.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['720p', 50_000],
      ],
      'Video-edit output rate ($0.05/sec); non-edit 720p generation is $0.07/sec.',
    ),
  ),
  'replicate-undisclosed|xai/grok-imagine-video-extension': tariff(
    'Video extension output: $0.05 / second at 480p and 720p.',
    'https://replicate.com/xai/grok-imagine-video-extension',
    ['Billed per second of stitched output video (source clip plus 2–10s extension).'],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 50_000],
        ['720p', 50_000],
      ],
      'Billed on total stitched output video duration (source video plus extension).',
    ),
  ),

  // Runway aggregator routes ($0.01 per credit)
  'runway-undisclosed|bytedance/seedance-2.5': tariff(
    'Output video: $0.20 / second at 480p; $0.30 at 720p; $0.68 at 1080p ($1.10 at 4K; $0.80 minimum).',
    runwayPricing,
    [
      'Runway credits equal $0.01 USD (20 / 30 / 68 / 110 credits per second; 80-credit minimum per task).',
      'Input or reference videos add $0.10 / $0.15 / $0.34 / $0.57 per input second by target resolution.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 200_000],
        ['720p', 300_000],
        ['1080p', 680_000],
      ],
      '20 / 30 / 68 Runway credits ($0.01/credit) per output second, subject to an 80-credit ($0.80) minimum and input-video charges.',
    ),
  ),
  'runway-undisclosed|bytedance/seedance-2.0': tariff(
    'Output video: $0.14 / second at 480p; $0.30 at 720p; $0.40 at 1080p; $1.50 at 4K ($0.56 minimum).',
    runwayPricing,
    [
      '14 / 30 / 40 / 150 Runway credits ($0.01/credit) per output second, with a 56-credit ($0.56) minimum.',
      'Reference videos add $0.09 / $0.18 / $0.25 / $0.90 per input second by target resolution.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 140_000],
        ['720p', 300_000],
        ['1080p', 400_000],
        ['4K', 1_500_000],
      ],
      'Output-second credit equivalent ($0.01/credit); 56-credit ($0.56) task minimum.',
    ),
  ),
  'runway-undisclosed|bytedance/seedance-2.0-fast': tariff(
    'Output video: $0.11 / second at 480p; $0.24 at 720p ($0.44 minimum).',
    runwayPricing,
    [
      '11 / 24 Runway credits ($0.01/credit) per output second, with a 44-credit ($0.44) minimum.',
      'Reference videos add $0.07 / $0.14 per input second at 480p / 720p.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 110_000],
        ['720p', 240_000],
      ],
      'Output-second credit equivalent ($0.01/credit); 44-credit ($0.44) task minimum.',
    ),
  ),
  'runway-undisclosed|bytedance/seedance-2.0-mini': tariff(
    'Output video: $0.07 / second at 480p; $0.15 at 720p ($0.28 minimum).',
    runwayPricing,
    [
      '7 / 15 Runway credits ($0.01/credit) per output second, with a 28-credit ($0.28) minimum.',
      'Reference videos add $0.04 / $0.09 per input second at 480p / 720p.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 70_000],
        ['720p', 150_000],
      ],
      'Output-second credit equivalent ($0.01/credit); 28-credit ($0.28) task minimum.',
    ),
  ),
  'runway-undisclosed|kling/kling-4.0': tariff(
    'Standard: $0.157 / second at 720p; $0.235 at 1080p (promo through Nov 30, 2026 UTC: $0.1256 / $0.188).',
    runwayPricing,
    [
      'Active 20% off promotional rates through November 30, 2026 UTC are 12.56 / 18.8 credits ($0.1256 / $0.188) per second without video input, or 7.52 / 11.28 credits ($0.0752 / $0.1128) per second on output duration plus max(input video duration, output duration) with video input.',
      'Execution quotes conservatively reserve standard list rates ($0.157 / $0.235 per second) for text/image-to-video.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['720p', 157_000],
      ['1080p', 235_000],
    ]),
  ),
  'runway-undisclosed|kling/kling-4.0-flash': tariff(
    'Without input video: 9.4 credits ($0.094) / second at 720p, rounded up to the next whole credit with a 29-credit ($0.29) minimum.',
    runwayPricing,
    [
      'With input video, Runway charges 6.3 credits/s of output plus 6.3 credits/s of max(input video duration, output duration).',
      'Whole-credit rounding and the 29-credit minimum make linear per-second multiplication non-exact at short durations; managed quotes remain unpriced.',
    ],
    recheckedAt,
    outputRates('output-second', [['720p', 94_000]]),
  ),
  'runway-undisclosed|alibaba/wan-3.0': tariff(
    'Output video: $0.05 / second at 480p; $0.10 at 720p; $0.20 at 1080p.',
    runwayPricing,
    ['5 / 10 / 20 Runway credits ($0.01/credit) per output second.'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 50_000],
      ['720p', 100_000],
      ['1080p', 200_000],
    ]),
  ),
  'runway-undisclosed|alibaba/wan-3.0-prime': tariff(
    'Output video: $0.068 / second at 480p; $0.14 at 720p; $0.28 at 1080p.',
    runwayPricing,
    ['6.8 / 14 / 28 Runway credits ($0.01/credit) per output second.'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 68_000],
      ['720p', 140_000],
      ['1080p', 280_000],
    ]),
  ),
  'runway-undisclosed|minimax/h3': tariff(
    'Output video: $0.10 / second at 768p; $0.15 at 2K (+$0.02 / start or reference image).',
    runwayPricing,
    [
      '10 / 15 Runway credits ($0.01/credit) per output second; start/end/reference images add 2 credits ($0.02) each and reference videos bill at the output rate.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['768p', 100_000],
        ['2K', 150_000],
      ],
      '10 / 15 Runway credits ($0.01/credit) per output second; start/reference images add $0.02 each.',
    ),
  ),
  'runway-undisclosed|minimax/h3-max': tariff(
    'Output video: $0.05 / second at 480p; $0.08 at 768p.',
    runwayPricing,
    ['5 / 8 Runway credits ($0.01/credit) per output second on Runway (`h3_max`).'],
    recheckedAt,
    outputRates('output-second', [
      ['480p', 50_000],
      ['768p', 80_000],
    ]),
  ),
  'runway-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Output video: $0.02 / second at 360p; $0.07 at 720p; $0.10 at 1080p; $0.21 at 4K, plus $0.01 per reference image/keyframe and $0.01 per input-video second.',
    runwayPricing,
    [
      'Runway enforces a 6-credit ($0.06) minimum per generation; route remains documented comparison-only.',
    ],
    recheckedAt,
    outputRates('output-second', [
      ['360p', 20_000],
      ['720p', 70_000],
      ['1080p', 100_000],
      ['4K', 210_000],
    ]),
  ),
  'runway-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Output video: $0.034 / second at 360p; $0.10 at 720p; $0.15 at 1080p; $0.30 at 4K.',
    runwayPricing,
    [
      '3.4 / 10 / 15 / 30 Runway credits ($0.01/credit) per output second; start/end/reference images add $0.01 each and input video adds $0.01 per second.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['360p', 34_000],
        ['720p', 100_000],
        ['1080p', 150_000],
        ['4K', 300_000],
      ],
      'Output-second credit equivalent ($0.01/credit); image inputs add $0.01 each and input video adds $0.01/sec.',
    ),
  ),
  'runway-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.10 / second at 480p; $0.16 at 720p; $0.29 at 1080p (+$0.01 / image or audio input).',
    runwayPricing,
    [
      '10 / 16 / 29 Runway credits ($0.01/credit) per output second; start/end/reference images or reference audio add 1 credit ($0.01) each.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 100_000],
        ['720p', 160_000],
        ['1080p', 290_000],
      ],
      'Output-second credit equivalent ($0.01/credit); image or audio inputs add $0.01 each.',
    ),
  ),
  'runway-undisclosed|xai/grok-imagine-video-1.5-lite': tariff(
    'Output video: $0.02 / second at 480p; $0.03 at 720p; $0.14 at 1080p (+$0.01 / start or end image).',
    runwayPricing,
    [
      '2 / 3 / 14 Runway credits ($0.01/credit) per output second; start/end images add 1 credit ($0.01) each.',
    ],
    recheckedAt,
    outputRates(
      'output-second',
      [
        ['480p', 20_000],
        ['720p', 30_000],
        ['1080p', 140_000],
      ],
      'Output-second credit equivalent ($0.01/credit); start/end images add $0.01 each.',
    ),
  ),
  'runway-undisclosed|bytedance/seedream-5.0-pro': tariff(
    '$0.05 / output image at 1K; $0.09 at 2K.',
    runwayPricing,
    ['5 / 9 Runway credits ($0.01/credit) per generated or edited image.'],
    recheckedAt,
    outputRates('image', [
      ['1K', 50_000],
      ['2K', 90_000],
    ]),
  ),
  'runway-undisclosed|google/nano-banana-2.1': tariff(
    '$0.04 / output image at 1K; $0.06 at 2K; $0.12 at 4K.',
    runwayPricing,
    ['4 / 6 / 12 Runway credits ($0.01/credit) per output image.'],
    recheckedAt,
    outputRates('image', [
      ['1K', 40_000],
      ['2K', 60_000],
      ['4K', 120_000],
    ]),
  ),
  'runway-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 2K $0.06; medium (default) 1K $0.06 / 2K $0.08 (+$0.01 / reference image).',
    runwayPricing,
    [
      'Runway defaults to medium quality (6 / 8 credits = $0.06 / $0.08) and adds 1 credit ($0.01) per reference image.',
    ],
    recheckedAt,
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 40_000],
          ['2K', 60_000],
        ],
        'Low-quality output rate; Runway default is medium ($0.06/$0.08) and reference images add $0.01 each.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 60_000],
          ['2K', 80_000],
        ],
        'Default medium-quality output rate; low quality is $0.04/$0.06 and reference images add $0.01 each.',
      )!,
    ],
  ),
  'runway-undisclosed|openai/gpt-image-2': tariff(
    'Per output image by quality & size: low $0.01–$0.02; medium $0.05–$0.11; high (default) $0.20 at 1K/2K, $0.41 at 4K.',
    runwayPricing,
    [
      '1–41 Runway credits ($0.01/credit) per output image depending on quality (low/medium/high) and resolution.',
    ],
    recheckedAt,
    [
      ...qualityImageRates(
        'low',
        [
          ['1K', 10_000],
          ['2K', 10_000],
          ['4K', 20_000],
        ],
        'Low-quality output rate (1 / 1 / 2 Runway credits at $0.01/credit); medium is $0.05/$0.05/$0.11 and high/auto is $0.20/$0.20/$0.41.',
      )!,
      ...qualityImageRates(
        'medium',
        [
          ['1K', 50_000],
          ['2K', 50_000],
          ['4K', 110_000],
        ],
        'Medium-quality output rate (5 / 5 / 11 Runway credits at $0.01/credit); Runway high/auto default is $0.20/$0.20/$0.41.',
      )!,
      ...qualityImageRates(
        'high',
        [
          ['1K', 200_000],
          ['2K', 200_000],
          ['4K', 410_000],
        ],
        'High-quality output rate (20 / 20 / 41 Runway credits at $0.01/credit); medium is $0.05/$0.05/$0.11 and low is $0.01/$0.01/$0.02.',
      )!,
      ...qualityImageRates(
        'auto',
        [
          ['1K', 200_000],
          ['2K', 200_000],
          ['4K', 410_000],
        ],
        'Auto-quality output rate (20 / 20 / 41 Runway credits at $0.01/credit); medium is $0.05/$0.05/$0.11 and low is $0.01/$0.01/$0.02.',
      )!,
    ],
  ),
  'runway-undisclosed|openai/gpt-image-2.5-flare': tariff(
    'Per output image: $0.01–$0.75 by quality, resolution and aspect ratio (1:1 high default: $0.11 / $0.16 / $0.19 at 1K / 2K / 4K; +$0.01 / ref image).',
    runwayPricing,
    [
      '1–75 Runway credits ($0.01/credit) per output image across low/medium/high/xhigh/max quality and aspect ratio, plus 1 credit ($0.01) per reference image per output.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 110_000],
        ['2K', 160_000],
        ['4K', 190_000],
      ],
      'Default high-quality 1:1 rate (11 / 16 / 19 Runway credits at $0.01/credit); non-square ratios cost $0.04–$0.15 at high, quality spans $0.01–$0.75, and reference images add $0.01 per output.',
      'high',
    ),
  ),
  'runway-undisclosed|openai/gpt-image-2.5-sunburst': tariff(
    'Per output image: $0.01–$0.75 by quality, resolution and aspect ratio (1:1 high default: $0.11 / $0.16 / $0.19 at 1K / 2K / 4K; +$0.01 / ref image).',
    runwayPricing,
    [
      '1–75 Runway credits ($0.01/credit) per output image across low/medium/high/xhigh/max quality and aspect ratio, plus 1 credit ($0.01) per reference image per output.',
    ],
    recheckedAt,
    approxImageRates(
      [
        ['1K', 110_000],
        ['2K', 160_000],
        ['4K', 190_000],
      ],
      'Default high-quality 1:1 rate (11 / 16 / 19 Runway credits at $0.01/credit); non-square ratios cost $0.04–$0.15 at high, quality spans $0.01–$0.75, and reference images add $0.01 per output.',
      'high',
    ),
  ),
};

/** Exact route-ID overrides take highest priority for feature- or endpoint-specific tariffs. */
const publishedByRoute: Record<string, PublishedPricing> = {};

/** Operation-scoped overrides (`deploymentId|modelId|operation`) take priority over deployment-wide tariffs. */
const publishedByOperation: Record<string, PublishedPricing> = {};

export function scopePublishedPricing(
  entry: PublishedPricing | undefined,
  operations?: readonly Route['operations'][number][],
): Route['publishedPricing'] {
  if (!entry || !operations?.length || !entry.outputRates?.length) return entry;
  const scopedRates = entry.outputRates.filter(
    (rate) => !rate.operation || operations.includes(rate.operation),
  );
  if (scopedRates.length === entry.outputRates.length) return entry;
  const { outputRates: _omitted, ...rest } = entry;
  return scopedRates.length ? { ...rest, outputRates: scopedRates } : rest;
}

export function publishedPricingFor(
  route: Pick<Route, 'modelId' | 'deploymentId'> &
    Partial<Pick<Route, 'id' | 'operations' | 'upstreamModelId'>>,
): Route['publishedPricing'] {
  const modelId = canonicalModelId(route.modelId);
  if (route.id && Object.hasOwn(publishedByRoute, route.id))
    return scopePublishedPricing(publishedByRoute[route.id], route.operations);
  if (route.operations?.length === 1) {
    const opKey = `${route.deploymentId}|${modelId}|${route.operations[0]}`;
    if (Object.hasOwn(publishedByOperation, opKey))
      return scopePublishedPricing(publishedByOperation[opKey], route.operations);
  }
  const upstreamKey = route.upstreamModelId
    ? `${route.deploymentId}|${route.upstreamModelId}`
    : undefined;
  const entry =
    (upstreamKey && Object.hasOwn(published, upstreamKey) ? published[upstreamKey] : undefined) ??
    published[`${route.deploymentId}|${modelId}`];
  return scopePublishedPricing(entry, route.operations);
}
