import { canonicalModelId, type Rate, type Route } from '@media-router/contracts';

type PublishedPricing = NonNullable<Route['publishedPricing']>;
const checkedAt = '2026-11-02';
const regionUnknown = 'No region-specific tariff or inference/storage residency was verified.';
const tariff = (
  summary: string,
  url: string,
  conditions: string[],
  checkedOn = checkedAt,
  outputRates?: PublishedPricing['outputRates'],
): PublishedPricing => ({
  summary,
  source: { url, checkedAt: checkedOn },
  conditions: [...conditions, regionUnknown],
  ...(outputRates && { outputRates }),
});
const outputRates = (unit: Rate['unit'], amounts: [string, number][]): Rate[] =>
  amounts.map(([resolution, usdMicros]) => ({ resolution, unit, usdMicros }));
const falTextVideoExamples = (amounts: [string, number][]): PublishedPricing['outputRates'] =>
  outputRates('output-second', amounts).map((rate) => ({
    ...rate,
    operation: 'text-to-video',
    approximate: true,
    note: 'Provider example for 16:9 text-to-video. The actual price follows the token calculation.',
  }));
const minimax = 'https://platform.minimax.io/docs/pricing/overview#video';
const xai = 'https://docs.x.ai/developers/pricing#imagine-api';
const google = 'https://aistudio.google.com/docs/pricing';
const openai = (model: string) =>
  tariff(
    'Standard USD per 1M tokens: $5 text input; $8 image input; $30 image output.',
    model === 'gpt-image-2'
      ? 'https://developers.openai.com/api/docs/pricing#image-generation-models'
      : `https://developers.openai.com/api/docs/models/${model}`,
    [
      'Cached text and image inputs cost $1.25 and $2 per 1M tokens. Batch has separate rates.',
      'Size, quality and actual token consumption determine the total. Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits remain unpriced.',
    ],
    '2026-11-06',
  );
const falImage = tariff(
  'Per 1M tokens: $5 text input; $8 image input; $30 image output.',
  'https://fal.ai/gpt-image-2.5',
  [
    'Flare and Sunburst share token rates. Size, quality, prompt length and reference images affect cost; short-prompt examples are not fixed image fees.',
    'Cached text/image input is $1.25/$2 per 1M tokens; totals round up to $0.0001.',
    'Provider descriptions disagree about text-output charging. A complete request quote has not been qualified.',
  ],
);
const falSeedance = tariff(
  '$0.014 per 1,000 video tokens at 480p / 720p / 1080p.',
  'https://fal.ai/models/bytedance/seedance-2.0/text-to-video',
  [
    'Token count depends on actual output width × height × duration × 24 ÷ 1,024. Published per-second examples do not apply to every aspect ratio.',
    'Reference inputs and exact output dimensions require configuration-specific qualification.',
  ],
  checkedAt,
  falTextVideoExamples([
    ['720p', 303_400],
    ['1080p', 682_000],
  ]),
);
const falSeedanceFast = tariff(
  '$0.0112 per 1,000 video tokens in the endpoint billing field.',
  'https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video',
  [
    'An editorial table on the same page lists $0.014 per 1,000 tokens instead. Preserve this discrepancy; no complete request quote is implied.',
    'Actual frame dimensions and duration determine token consumption.',
  ],
  checkedAt,
  falTextVideoExamples([['720p', 241_900]]),
);
const falSeedance25 = tariff(
  '$0.0214 per 1,000 video tokens at 480p / 720p.',
  'https://fal.ai/models/bytedance/seedance-2.5/text-to-video',
  [
    'Token count depends on actual frame area, duration and frame rate, with input-video duration included where applicable.',
    'The source labels per-second figures approximate; some worked examples differ from its token formula. Exact request pricing remains unqualified.',
  ],
  checkedAt,
  falTextVideoExamples([
    ['480p', 220_500],
    ['720p', 473_000],
  ]),
);
const falSeedream = tariff(
  'Tentative: $0.0675 / output image through 1536² pixels; $0.135 through 2048².',
  'https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image',
  [
    'The provider explicitly says final pricing is not confirmed.',
    'Editing has additional input-image charges and needs a separate complete formula.',
  ],
);
const falSeedanceMini = tariff(
  '$0.007 per 1,000 video tokens at 480p / 720p.',
  'https://fal.ai/models/bytedance/seedance-2.0/mini/text-to-video',
  [
    'Token count depends on actual output width × height × duration × 24 ÷ 1,024.',
    'Reference inputs and exact output dimensions require configuration-specific qualification.',
  ],
  '2026-11-13',
  falTextVideoExamples([
    ['480p', 67_500],
    ['720p', 151_700],
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
);
const falSeedance1ProFast = tariff(
  '$0.001 per 1,000 video tokens at 480p / 720p / 1080p.',
  'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/fast/text-to-video',
  [
    'Token count follows (width × height × fps × duration) ÷ 1,024; 5s 1080p 16:9 is approximately $0.245.',
    'Actual output dimensions determine token consumption.',
  ],
  '2026-11-13',
);

// Exact deployment + variant keys prevent applying a provider's global tariff to an unqualified regional offering.
const published: Record<string, PublishedPricing> = {
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.5': tariff(
    'Without video input, ModelArk charges $10.70 per million tokens at 480p and 720p and $11.70 at 1080p. With video input, the corresponding rates are $6.40 and $7.00.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing#dreamina-seedance-2-5-price-examples',
    [
      'The per-second figures are published examples for five seconds of 16:9 output without video input.',
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
    ],
    '2026-11-06',
    outputRates('output-second', [
      ['480p', 103_000],
      ['720p', 231_000],
      ['1080p', 569_000],
    ]).map((rate) => ({ ...rate, approximate: true })),
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0': tariff(
    'Without video input, ModelArk charges $7.00 per million tokens at 480p/720p, $7.70 at 1080p and $4.00 at 4K. With video input, the rates are $4.30, $4.70 and $2.40.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
    ],
    '2026-11-13',
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0-fast': tariff(
    'Without video input, ModelArk charges $5.60 per million tokens at 480p/720p ($3.30 with video input).',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
    ],
    '2026-11-13',
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.0-mini': tariff(
    'Without video input, ModelArk charges $3.50 per million tokens at 480p/720p ($2.10 with video input).',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Non-video-input managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens; video-reference tasks remain unpriced.',
    ],
    '2026-11-13',
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-1.0-pro': tariff(
    'ModelArk charges $2.50 per million video tokens across 480p, 720p and 1080p.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens on completion.',
    ],
    '2026-11-13',
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-1.0-pro-fast': tariff(
    'ModelArk charges $1.00 per million video tokens across 480p, 720p and 1080p.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Managed quotes reserve a conservative max-token bound and settle exact reported completion_tokens on completion.',
    ],
    '2026-11-13',
  ),
  'byteplus-modelark-ap-southeast-1|bytedance/seedream-5.5': tariff(
    'Output image: $0.02 at 1K / 1.5K (up to 2.61MP); $0.035 at 2K. Image editing adds $0.008 per input image.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing',
    [
      'Text-to-image has a complete single-output estimate; image editing incurs additional per-input-image charges.',
    ],
    '2026-11-13',
  ),
  'minimax-undisclosed|minimax/h3': tariff(
    'Output video: $0.08 / second at 768P; $0.13 at 2K.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.04 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
  ),
  'minimax-undisclosed|minimax/h3-highspeed': tariff(
    'Output video: $0.04 / second at 480P; $0.06 at 768P.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.03 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
  ),
  'minimax-undisclosed|minimax/h3-lite': tariff(
    'Output video: $0.025 / second at 480P; $0.04 at 768P.',
    minimax,
    [
      'Input video adds the matching per-second rate. Five input images are free, then $0.02 / image; audio input is free.',
      'Only text-to-video without input media has a qualified output-second estimate. Media inputs and special modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
  ),
  'minimax-undisclosed|minimax/h3-max': tariff(
    'Output video: $0.05 / second at 480P; $0.08 at 768P.',
    minimax,
    [
      'Input video adds $0.0553 / second at 480P or $0.143 at 768P. Two images are free, then $0.074 / image; audio input is free.',
      'Only text-to-video without input media and with prompt expansion disabled has a qualified output-second estimate. Media inputs and other expansion modes require separate pricing; list estimates are not settled charges or provider ceilings.',
    ],
    '2026-11-03',
  ),
  'xai-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.08 / second at 480p; $0.14 at 720p; $0.25 at 1080p.',
    xai,
    [
      'Input images add $0.01 each. Only text-to-video without input media has a qualified output-second estimate; image-to-video and reference-to-video remain unpriced.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    '2026-11-03',
  ),
  'xai-undisclosed|xai/grok-imagine-video-1.5-lite': tariff(
    'Output video: $0.02 / second at 480p; $0.03 at 720p; $0.14 at 1080p.',
    xai,
    [
      'Input images add $0.01 each. Only text-to-video without input media has a qualified output-second estimate; Lite 1080p is upscaled, not a native-resolution guarantee.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    '2026-11-03',
  ),
  'xai-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 2K $0.06; medium 1K $0.06 / 2K $0.08.',
    xai,
    [
      'Input images add $0.01 each. The adapter selects low for text generation and medium for edits.',
      '1.5K has a published tariff but is not supported by this adapter. The US regional endpoint does not serve media APIs.',
      'Only one text-generated image at absent/low quality and 1K/2K has a qualified estimate. Auto/medium quality, edits and input media remain unpriced by the execution quote.',
    ],
    '2026-11-03',
  ),
  'google-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text/thinking output; $12 video output.',
    google + '#gemini-omni-1.2-flash',
    [
      'Standard processing converts video output at 1,931 / 5,792 / 8,688 / 17,376 tokens per second across 360p / 720p / 1080p / 4K (~$0.023 / $0.070 / $0.104 / $0.209 per video second before input and thinking tokens).',
      'Single-output text-to-video managed quotes reserve a conservative max-token bound and settle exact reported modality usage; frame, reference, edit and continuation operations remain unpriced.',
    ],
    '2026-11-14',
  ),
  'google-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text output; $17.50 video output.',
    google + '#gemini-omni-1.1-flash',
    [
      'Standard processing. At 720p, the source converts video output using 5,792 tokens / second; input and text/thinking costs are additional.',
      'The approximate $0.10 / video second is an output component, not a complete generation price. Single-output text-to-video managed quotes reserve a conservative max-token bound; frame, reference, edit and continuation operations remain unpriced.',
    ],
  ),
  'google-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.50 input; $7.50 text/thinking output; $30 image output.',
    google + '#gemini-nano-banana-2.1',
    [
      'Standard image-output components: $0.0336 at 1K, $0.0504 at 2K, approximately $0.113 at 4K. Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Batch and search grounding have separate pricing. This adapter uses standard Interactions without grounding; reference/edit operations remain unpriced.',
    ],
  ),
  'google-undisclosed|google/nano-banana-pro': tariff(
    'Per 1M tokens: $2.00 input; $12.00 text/thinking output; $120.00 image output.',
    google + '#gemini-3-pro-image',
    [
      'Standard image-output components: 1,120 tokens ($0.1344) at 1K and 2K; 2,000 tokens ($0.24) at 4K. Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Search grounding and reference/edit operations carry separate charges and remain unpriced.',
    ],
    '2026-11-14',
  ),
  'google-undisclosed|google/nano-banana-2': tariff(
    'Per 1M tokens: $0.50 input; $3.00 text/thinking output; $60.00 image output.',
    google + '#gemini-3.1-flash-image',
    [
      'Standard image-output components: 747 tokens ($0.0448) at 0.5K, 1,120 ($0.0672) at 1K, 1,680 ($0.1008) at 2K and 2,520 ($0.1512) at 4K. Single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Search grounding and reference/edit operations carry separate charges and remain unpriced.',
    ],
    '2026-11-14',
  ),
  'google-undisclosed|google/nano-banana-2-lite': tariff(
    'Per 1M tokens: $0.25 input; $1.50 text/thinking output; $30.00 image output.',
    google + '#gemini-3.1-flash-lite-image',
    [
      'Standard 1K image-output component is 1,120 tokens ($0.0336). Input and thinking add cost; single-output text-to-image managed quotes reserve a conservative max-token bound.',
      'Reference/edit operations remain unpriced.',
    ],
    '2026-11-14',
  ),
  'minimax-undisclosed|minimax/h3-image': tariff(
    'Per 1M tokens: $2.30 text input (including prompt enhancement); $1.50 image input; $3.80 image output.',
    'https://platform.minimax.io/docs/pricing/overview#image',
    [
      'Limited-time 50% promotional discount on 4K outputs through November 17, 2026 UTC is excluded from managed reservations.',
      'Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits and custom pixel dimensions remain unpriced.',
    ],
    '2026-11-14',
  ),
  'minimax-undisclosed|minimax/h3-image-highspeed': tariff(
    'Per 1M tokens: $2.30 text input (including prompt enhancement); $3.00 image input; $7.60 image output.',
    'https://platform.minimax.io/docs/pricing/overview#image',
    [
      'Limited-time 50% promotional discount on 4K outputs through November 17, 2026 UTC is excluded from managed reservations.',
      'Text-to-image managed quotes reserve a conservative max-token bound and settle exact reported token usage on completion; image edits and custom pixel dimensions remain unpriced.',
    ],
    '2026-11-14',
  ),
  'openai-undisclosed|openai/gpt-image-2': openai('gpt-image-2'),
  'openai-undisclosed|openai/gpt-image-2.5-flare': openai('gpt-image-2.5-flare'),
  'openai-undisclosed|openai/gpt-image-2.5-sunburst': openai('gpt-image-2.5-sunburst'),
  'openai-undisclosed|openai/gpt-image-2.6-flare': openai('gpt-image-2.6-flare'),
  'openai-undisclosed|openai/gpt-image-2.6-sunburst': openai('gpt-image-2.6-sunburst'),
  'fal-undisclosed|openai/gpt-image-2': tariff(
    'Per 1M tokens: $5 text input; $8 image input; $30 image output.',
    'https://fal.ai/models/openai/gpt-image-2',
    [
      'Size, quality, prompt length and reference images affect token consumption; published per-image examples are not fixed fees.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|openai/gpt-image-2.5-flare': falImage,
  'fal-undisclosed|openai/gpt-image-2.5-sunburst': falImage,
  'fal-undisclosed|openai/gpt-image-2.6-flare': tariff(
    'Per 1M tokens: $5 text input; $10 text output; $8 image input; $30 image output.',
    'https://fal.ai/models/openai/gpt-image-2.6/flare/text-to-image',
    [
      'GPT Image 2.6 increases low/medium output tokens relative to 2.5 (4.2x low, 3.3x medium); totals round up to $0.0001.',
      'Size, quality, prompt length and reference images determine token consumption; no fixed per-image fee applies.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|openai/gpt-image-2.6-sunburst': tariff(
    'Per 1M tokens: $5 text input; $10 text output; $8 image input; $30 image output.',
    'https://fal.ai/models/openai/gpt-image-2.6/sunburst/text-to-image',
    [
      'GPT Image 2.6 increases low/medium output tokens relative to 2.5 (4.2x low, 3.3x medium); totals round up to $0.0001.',
      'Size, quality, prompt length and reference images determine token consumption; no fixed per-image fee applies.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|google/nano-banana-pro': tariff(
    'Base output image: $0.15 at 1K; higher resolution tiers and grounding add cost.',
    'https://fal.ai/models/fal-ai/nano-banana-pro',
    [
      'Single-output 1K text-to-image without grounding uses the $0.15 list estimate; 2K/4K, grounding and edits remain unpriced.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|google/nano-banana-2': tariff(
    'Base output image: $0.08 at 1K; other resolution tiers and grounding vary.',
    'https://fal.ai/models/fal-ai/nano-banana-2',
    [
      'Single-output 1K text-to-image without grounding uses the $0.08 list estimate; 0.5K/2K/4K, grounding and edits remain unpriced.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|google/nano-banana-2-lite': tariff(
    'Token-billed Gemini 3.1 Flash Lite Image pass-through on fal.',
    'https://fal.ai/models/google/nano-banana-2-lite',
    [
      'Prompt and thinking token consumption vary per request; no fixed per-image fee is published.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Output video: $0.0273 / second at 360p; $0.0819 at 720p; $0.1229 at 1080p; $0.2457 at 4K, plus $1.50 / 1M input tokens.',
    'https://fal.ai/models/google/gemini-omni-flash/v1.2/text-to-video',
    [
      'Text-to-video managed quotes combine the output-second list rate with a conservative $1.50 / 1M prompt-token bound; frame, reference, edit and extend operations incur media input token charges and remain unpriced.',
    ],
    '2026-11-14',
  ),
  'runway-undisclosed|google/gemini-omni-1.2-flash': tariff(
    'Output video: $0.02 / second at 360p; $0.07 at 720p; $0.10 at 1080p; $0.21 at 4K, plus $0.01 per reference image/keyframe and $0.01 per input-video second.',
    'https://docs.dev.runwayml.com/guides/pricing/',
    [
      'Runway enforces a 6-credit ($0.06) minimum per generation; route remains documented comparison-only.',
    ],
    '2026-11-14',
    outputRates('output-second', [
      ['360p', 20_000],
      ['720p', 70_000],
      ['1080p', 100_000],
      ['4K', 210_000],
    ]),
  ),
  'fal-undisclosed|minimax/h3-image': tariff(
    'Per 1M tokens: $2.30 text input; $1.50 image input; $3.80 image output.',
    'https://fal.ai/models/minimax/h3-image/text-to-image',
    [
      'Prompt enhancement and actual delivered pixel dimensions determine token charges; no fixed per-image rate applies.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|minimax/h3-image-highspeed': tariff(
    'Token-billed MiniMax H3 Image Highspeed pass-through on fal.',
    'https://fal.ai/models/minimax/h3-image/highspeed/text-to-image',
    [
      'fal editorial prose displays base H3 Image rates while MiniMax lists $2.30 text / $3.00 image input / $7.60 image output per 1M tokens for Highspeed; preserve discrepancy without assuming a flat fee.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|kling/kling-4.0': tariff(
    'Output video without video input: $0.157 / second at 720p; $0.235 at 1080p. With video input: $0.094 / second at 720p; $0.141 at 1080p across active input and output seconds.',
    'https://fal.ai/models/kling/v4/text-to-video',
    [
      'Text-to-video and image-to-video use output-second list estimates; reference-to-video and video-edit remain unpriced because video references/source duration alter total billing.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|kling/kling-4.0-flash': tariff(
    'Output video without video input: $0.094 / second at 720p. With video input: $0.063 / second billed on output duration plus max(input video duration, output duration).',
    'https://fal.ai/models/kling/v4/flash/text-to-video',
    [
      'Text-to-video and image-to-video use the $0.094 / second list estimate; reference-to-video and video-edit remain unpriced.',
    ],
    '2026-11-14',
  ),
  'runway-undisclosed|kling/kling-4.0-flash': tariff(
    'Without input video: 9.4 credits ($0.094) / second at 720p, rounded up to the next whole credit with a 29-credit ($0.29) minimum.',
    'https://docs.dev.runwayml.com/guides/pricing/',
    [
      'With input video, Runway charges 6.3 credits/s of output plus 6.3 credits/s of max(input video duration, output duration).',
      'Whole-credit rounding and the 29-credit minimum make linear per-second multiplication non-exact at short durations; managed quotes remain unpriced.',
    ],
    '2026-11-14',
    outputRates('output-second', [['720p', 94_000]]),
  ),
  'fal-undisclosed|bfl/flux-3-image': tariff(
    '$0.048 per output megapixel.',
    'https://fal.ai/models/blackforestlabs/flux-3/text-to-image',
    [
      'Actual megapixel count varies with aspect ratio and resolution tier; flat tier fees are not assumed.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|bfl/flux-3-klein': tariff(
    '$0.009 per output megapixel.',
    'https://fal.ai/models/blackforestlabs/flux-3/klein/text-to-image',
    ['Actual megapixel count varies with image_size dimensions; flat tier fees are not assumed.'],
    '2026-11-14',
  ),
  'fal-undisclosed|bfl/flux-3-video': tariff(
    'Output video: $0.17 / second at 720p; $0.29 at 1080p; $0.32 at 1440p; $0.47 at 2160p.',
    'https://fal.ai/models/blackforestlabs/flux-3/text-to-video',
    [
      'Text-to-video and image-to-video with fixed numeric duration use regular output-second list rates; auto duration, video-edit ($0.03/s source-derived length) and video-extend remain unpriced.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|fal/flux-3-max-video': tariff(
    'Regular output video list rates: $0.17 / second at 720p; $0.29 at 1080p.',
    'https://fal.ai/models/blackforestlabs/flux-3-max/text-to-video',
    [
      'Temporary 50% promotional rates ($0.085/$0.145 through November 22, 2026 UTC; resuming regular list rates November 23) are excluded so managed reservations never under-reserve.',
      '2K and 4K list rates are not explicitly itemized in prose and remain unpriced.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|alibaba/happy-horse-1.1': tariff(
    'Output video: $0.14 / second across 720p and 1080p.',
    'https://fal.ai/models/alibaba/happy-horse/v1.1/text-to-video',
    [
      'Text-to-video and image-to-video use the $0.14 / second list estimate; reference-to-video remains unpriced for managed quotes.',
    ],
    '2026-11-14',
  ),
  'fal-undisclosed|bytedance/seedream-5.5': tariff(
    'Output image: $0.03 at 1K / 1.5K (up to 2.61MP); $0.0405 at 2K. Editing adds $0.012 per input image per output.',
    'https://fal.ai/models/bytedance/seedream/v5.5/text-to-image',
    [
      'Text-to-image uses fixed output-tier list estimates; image editing incurs per-input-image charges per generated output and remains unpriced.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|bytedance/seedream-5.0-pro': falSeedream,
  'fal-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.764 input; $8.823 text/thinking output; $35.294 image output.',
    'https://fal.ai/models/google/nano-banana-2.1',
    [
      'Output resolution, prompt length, reference images and thinking consumption affect the total. Published example totals are not fixed per-image charges.',
    ],
  ),
  'fal-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Output video: $0.03 / second at 360p; $0.10 at 720p; $0.15 at 1080p; $0.30 at 4K.',
    'https://fal.ai/models/google/gemini-omni-flash/v1.1/text-to-video',
    [
      'Text-to-video and image-to-video have fixed output-second list estimates; reference-to-video and source-derived video editing remain comparison-only.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|bytedance/seedance-2.0': falSeedance,
  'fal-undisclosed|bytedance/seedance-2.0-fast': falSeedanceFast,
  'fal-undisclosed|bytedance/seedance-2.0-mini': falSeedanceMini,
  'fal-undisclosed|bytedance/seedance-2.5': falSeedance25,
  'fal-undisclosed|bytedance/seedance-1.0-pro': falSeedance1Pro,
  'fal-undisclosed|bytedance/seedance-1.0-pro-fast': falSeedance1ProFast,
  'fal-undisclosed|alibaba/wan-3.0': tariff(
    'Output video: $0.05 / second at 480p; $0.10 at 720p; $0.20 at 1080p.',
    'https://fal.ai/models/alibaba/wan-3.0/text-to-video',
    [
      'Provider states pricing is subject to change. Reference-to-video has separate input considerations and remains unpriced.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|alibaba/wan-3.0-prime': tariff(
    'Output video: $0.068 / second at 480p; $0.14 at 720p; $0.28 at 1080p.',
    'https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video',
    ['Provider states pricing is subject to change. Reference-to-video remains unpriced.'],
    '2026-11-13',
  ),
  'fal-undisclosed|fal/qwen-image-3': tariff(
    'Output image: $0.04 at 1K; $0.075 at 2K.',
    'https://fal.ai/models/alibaba/qwen-image-3/text-to-image',
    [
      'Text-to-image has fixed output-tier list estimates; image-edit reference billing remains unpriced.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|xai/grok-imagine-video-1.5': tariff(
    'Output video: $0.08 / second at 480p; $0.14 at 720p; $0.25 at 1080p. Input images add $0.01 each.',
    'https://fal.ai/models/xai/grok-imagine-video/v1.5/text-to-video',
    [
      'Only text-to-video without input media has a fixed output-second estimate; image-to-video and reference-to-video incur per-image input charges.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|xai/grok-imagine-video-1.5-lite': tariff(
    'Output video: $0.02 / second at 480p; $0.03 at 720p; $0.14 at 1080p. Input images add $0.01 each.',
    'https://fal.ai/models/xai/grok-imagine-video/v1.5/lite/text-to-video',
    [
      'Only text-to-video without input media has a fixed output-second estimate; image-to-video incurs an input-image charge.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|xai/grok-imagine-video': tariff(
    'Output video: $0.05 / second at 480p; $0.07 at 720p, plus $0.01 per input-video second.',
    'https://fal.ai/models/xai/grok-imagine-video/edit-video',
    [
      'Source-video duration determines input billing; edit and extend routes remain comparison-only for managed quotes.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|xai/grok-imagine-image-2.0': tariff(
    'Per output image: low 1K $0.04 / 1.5K $0.05 / 2K $0.06; medium 1K $0.06 / 1.5K $0.07 / 2K $0.08. Input images add $0.01 each.',
    'https://fal.ai/models/xai/grok-imagine-image/v2.0/text-to-image',
    [
      'Single text-generated images at low/default quality have fixed output-tier estimates; medium/auto quality and image edits remain unpriced.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|minimax/h3': tariff(
    'Output video: $0.05 / second at 480p; $0.06 at 768p; $0.13 at 2K; $0.16 at 4K.',
    'https://fal.ai/models/minimax/h3/text-to-video',
    [
      'Text-to-video and image-to-video with prompt expansion disabled use output-second list estimates; reference-to-video adds $0.08 per image beyond five and remains unpriced.',
    ],
    '2026-11-13',
  ),
  'fal-undisclosed|minimax/h3-max': tariff(
    'Standard output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p.',
    'https://fal.ai/models/minimax/h3-max/text-to-video',
    [
      'November 1–15, 2026 promotional rates are $0.035/$0.056/$0.112 per second at 480p/768p/1080p; standard rates resume November 16. Quotes conservatively use standard list rates without promotional discounts.',
      'Reference tokens beyond the included quota have additional charges; only text-to-video without input media and with prompt expansion disabled has a qualified estimate.',
      'Billing follows generated video seconds; output can run about 0.7 seconds longer than requested. Requested-duration estimates are not settled charges or guaranteed ceilings.',
    ],
    '2026-11-03',
  ),
  'fal-undisclosed|fal/h3-max-turbo': tariff(
    'Standard output video: $0.025 / second at 480p; $0.04 at 768p; $0.08 at 1080p.',
    'https://fal.ai/models/minimax/h3-max-turbo/text-to-video',
    [
      'November 1–15, 2026 promotional rates are $0.0175/$0.028/$0.056 per second at 480p/768p/1080p; standard rates resume November 16. Quotes conservatively use standard rates without promotional discounts.',
      'Only text-to-video without input media and with prompt expansion disabled has a qualified estimate. Reference/edit inputs and other expansion modes remain unpriced.',
      'Billing follows generated video seconds; output can run about 0.7 seconds longer than requested. Requested-duration estimates are not settled charges or guaranteed ceilings.',
    ],
    '2026-11-03',
  ),
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
};

export function publishedPricingFor(
  route: Pick<Route, 'modelId' | 'deploymentId'>,
): Route['publishedPricing'] {
  return published[`${route.deploymentId}|${canonicalModelId(route.modelId)}`];
}
