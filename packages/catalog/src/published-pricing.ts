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
      'Size, quality and actual token consumption determine the total.',
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

// Exact deployment + variant keys prevent applying a provider's global tariff to an unqualified regional offering.
const published: Record<string, PublishedPricing> = {
  'byteplus-modelark-ap-southeast-1|bytedance/seedance-2.5': tariff(
    'Without video input, ModelArk charges $10.70 per million tokens at 480p and 720p and $11.70 at 1080p. With video input, the corresponding rates are $6.40 and $7.00.',
    'https://docs.byteplus.com/en/docs/modelark/model-pricing#dreamina-seedance-2-5-price-examples',
    [
      'The per-second figures are published examples for five seconds of 16:9 output without video input.',
      'Video input changes token consumption and the minimum billable token count. The provider bills from the actual token usage.',
    ],
    '2026-11-06',
    outputRates('output-second', [
      ['480p', 103_000],
      ['720p', 231_000],
      ['1080p', 569_000],
    ]).map((rate) => ({ ...rate, approximate: true })),
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
      'Input images add $0.01 each. This output tariff is not a complete reference/edit quote.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    checkedAt,
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
      'Input images add $0.01 each. Lite 1080p is upscaled, not a native-resolution guarantee.',
      'The US regional endpoint does not serve image/video APIs; these prices describe the global media API.',
    ],
    checkedAt,
    outputRates('output-second', [
      ['480p', 20_000],
      ['720p', 30_000],
      ['1080p', 140_000],
    ]),
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
  'google-undisclosed|google/gemini-omni-1.1-flash': tariff(
    'Per 1M tokens: $1.50 input; $9 text output; $17.50 video output.',
    google + '#gemini-omni-1.1-flash',
    [
      'Standard processing. At 720p, the source converts video output using 5,792 tokens / second; input and text/thinking costs are additional.',
      'The approximate $0.10 / video second is an output component, not a complete generation price.',
    ],
  ),
  'google-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.50 input; $7.50 text/thinking output; $30 image output.',
    google + '#gemini-nano-banana-2.1',
    [
      'Standard image-output components: $0.0336 at 1K, $0.0504 at 2K, approximately $0.113 at 4K. Input and thinking add cost.',
      'Batch and search grounding have separate pricing. This adapter uses standard Interactions without grounding.',
    ],
  ),
  'openai-undisclosed|openai/gpt-image-2': openai('gpt-image-2'),
  'openai-undisclosed|openai/gpt-image-2.5-flare': openai('gpt-image-2.5-flare'),
  'openai-undisclosed|openai/gpt-image-2.5-sunburst': openai('gpt-image-2.5-sunburst'),
  'fal-undisclosed|openai/gpt-image-2.5-flare': falImage,
  'fal-undisclosed|openai/gpt-image-2.5-sunburst': falImage,
  'fal-undisclosed|bytedance/seedream-5.0-pro': falSeedream,
  'fal-undisclosed|google/nano-banana-2.1': tariff(
    'Per 1M tokens: $1.764 input; $8.823 text/thinking output; $35.294 image output.',
    'https://fal.ai/models/google/nano-banana-2.1',
    [
      'Output resolution, prompt length, reference images and thinking consumption affect the total. Published example totals are not fixed per-image charges.',
    ],
  ),
  'fal-undisclosed|bytedance/seedance-2.0': falSeedance,
  'fal-undisclosed|bytedance/seedance-2.0-fast': falSeedanceFast,
  'fal-undisclosed|bytedance/seedance-2.5': falSeedance25,
  'fal-undisclosed|minimax/h3-max': tariff(
    'Standard output video: $0.05 / second at 480p; $0.08 at 768p; $0.16 at 1080p.',
    'https://fal.ai/models/minimax/h3-max/text-to-video',
    [
      'Standard list rates, without promotional discounts. The checked source separately describes a November 1–15, 2026 promotion and standard pricing from November 16; recheck the source for current/account terms.',
      'Reference tokens beyond the included quota have additional charges; this summary is not an arbitrary-reference quote.',
    ],
    checkedAt,
    outputRates('output-second', [
      ['480p', 50_000],
      ['768p', 80_000],
      ['1080p', 160_000],
    ]),
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
