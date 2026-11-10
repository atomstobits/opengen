import {
  canonicalModelId,
  type Company,
  type Model,
  type ModelSeries,
} from '@media-router/contracts';
import { catalog } from './data';

export const companies: Company[] = [
  {
    id: 'bytedance',
    name: 'ByteDance',
    website: 'https://www.bytedance.com/',
    description: 'The original publisher of the Seedance video and Seedream image model series.',
  },
  {
    id: 'kling',
    name: 'Kling AI',
    website: 'https://kling.ai/',
    description: 'Video generation and editing models from Kling AI.',
  },
  {
    id: 'alibaba',
    name: 'Alibaba',
    website: 'https://www.alibabacloud.com/',
    description:
      'Wan video models and the Qwen image model brand, with separately documented regional offerings.',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    website: 'https://www.minimax.io/',
    description:
      'The original publisher of H3. Its model series also includes separately attributed derivatives from other teams.',
  },
  {
    id: 'google',
    name: 'Google',
    website: 'https://ai.google.dev/',
    description: 'Gemini Omni video and Nano Banana image models.',
  },
  {
    id: 'xai',
    name: 'xAI',
    website: 'https://x.ai/',
    description: 'Grok Imagine image and video model series.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    website: 'https://openai.com/',
    description: 'GPT Image generation and editing model series.',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    website: 'https://qwen.ai/',
    parentCompanyId: 'alibaba',
    description:
      'Alibaba’s Qwen model brand, including published image checkpoints and distinct hosted offerings.',
  },
];

export const modelSeries: ModelSeries[] = [
  {
    id: 'bytedance/seedance-2.5',
    companyId: 'bytedance',
    name: 'Seedance 2.5',
    description: 'Compare serving providers for ByteDance’s Seedance 2.5 release.',
    modelIds: ['bytedance/seedance-2.5'],
  },
  {
    id: 'bytedance/seedance-2.0',
    companyId: 'bytedance',
    name: 'Seedance 2.0',
    description: 'Standard, Fast and Mini are separate variants in the Seedance 2.0 series.',
    modelIds: [
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
    ],
  },
  {
    id: 'kling/kling-4.0',
    companyId: 'kling',
    name: 'Kling 4.0',
    description: 'Video generation and editing, compared across documented serving routes.',
    modelIds: ['kling/kling-4.0'],
  },
  {
    id: 'alibaba/wan-3.0',
    companyId: 'alibaba',
    name: 'Wan 3.0',
    description:
      'Standard and Prime variants, each with independently listed regional provider routes.',
    modelIds: ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime'],
  },
  {
    id: 'minimax/h3',
    companyId: 'minimax',
    name: 'MiniMax H3',
    description:
      'MiniMax’s H3 series, with H3 Max served by MiniMax and fal, plus separately attributed Turbo and Pika Flex variants.',
    modelIds: [
      'minimax/h3',
      'minimax/h3-highspeed',
      'minimax/h3-lite',
      'minimax/h3-max',
      'fal/h3-max-turbo',
      'pika/h3-flex',
    ],
  },
  {
    id: 'google/gemini-omni-1.1-flash',
    companyId: 'google',
    name: 'Gemini Omni 1.1 Flash',
    description:
      'The current stable Gemini Omni Flash release and its documented serving providers.',
    modelIds: ['google/gemini-omni-1.1-flash'],
  },
  {
    id: 'xai/grok-imagine-video',
    companyId: 'xai',
    name: 'Grok Imagine Video',
    description:
      'Video 1.5, Lite and the distinct editing/extension model retain their own execution identities.',
    modelIds: [
      'xai/grok-imagine-video-1.5',
      'xai/grok-imagine-video-1.5-lite',
      'xai/grok-imagine-video',
    ],
  },
  {
    id: 'openai/gpt-image-2.5',
    companyId: 'openai',
    name: 'GPT Image 2.5',
    description: 'Sunburst and Flare are separate image generation and editing variants.',
    modelIds: ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'],
  },
  {
    id: 'openai/gpt-image-2',
    companyId: 'openai',
    name: 'GPT Image 2',
    description: 'GPT Image 2, also discoverable as GPT Image 2.0, with its serving providers.',
    modelIds: ['openai/gpt-image-2'],
  },
  {
    id: 'google/nano-banana-2.1',
    companyId: 'google',
    name: 'Nano Banana 2.1',
    description: 'Google’s Nano Banana 2.1 image generation and editing release.',
    modelIds: ['google/nano-banana-2.1'],
  },
  {
    id: 'xai/grok-imagine-image-2.0',
    companyId: 'xai',
    name: 'Grok Imagine Image 2.0',
    description: 'Grok Imagine Image 2.0 generation and editing routes.',
    modelIds: ['xai/grok-imagine-image-2.0'],
  },
  {
    id: 'bytedance/seedream-5.0-pro',
    companyId: 'bytedance',
    name: 'Seedream 5.0 Pro',
    description:
      'ByteDance’s Pro image generation and editing release, with separate serving-provider routes.',
    modelIds: ['bytedance/seedream-5.0-pro'],
  },
  {
    id: 'qwen/image-2.1',
    companyId: 'qwen',
    name: 'Qwen Image 2.1',
    description:
      'Base and Turbo checkpoints alongside the distinct hosted Pro offering; licenses remain variant-specific.',
    modelIds: ['qwen/image-2.1', 'qwen/image-2.1-turbo', 'alibaba/qwen-image-2.1-pro'],
  },
  {
    id: 'qwen/image-3.0-pro',
    companyId: 'qwen',
    name: 'Qwen Image 3.0 Pro',
    description: 'The hosted Qwen Image 3.0 Pro generation and editing model.',
    modelIds: ['alibaba/qwen-image-3.0-pro'],
  },
];

export function getCompany(id: string): Company | undefined {
  return companies.find((company) => company.id === id);
}

export function getSeries(id: string): ModelSeries | undefined {
  return modelSeries.find((series) => series.id === id);
}

export function getSeriesForModel(modelId: string): ModelSeries | undefined {
  modelId = canonicalModelId(modelId);
  return modelSeries.find((series) => series.modelIds.includes(modelId));
}

/** Parent company pages include their explicitly registered creator brands. */
export function getCompanySeries(companyId: string): ModelSeries[] {
  if (!getCompany(companyId)) return [];
  return modelSeries.filter((series) => {
    let company = getCompany(series.companyId);
    const visited = new Set<string>();
    while (company && !visited.has(company.id)) {
      if (company.id === companyId) return true;
      visited.add(company.id);
      company = company.parentCompanyId ? getCompany(company.parentCompanyId) : undefined;
    }
    return false;
  });
}

export function getCompanyModels(companyId: string): Model[] {
  const ids = new Set(getCompanySeries(companyId).flatMap((series) => series.modelIds));
  return catalog.models.filter((model) => ids.has(model.id));
}

/** One public series projection, shared by REST and MCP discovery. */
export function getSeriesDetail(id: string) {
  const series = getSeries(id);
  if (!series) return undefined;
  const modelIds = new Set(series.modelIds);
  const models = catalog.models.filter((model) => modelIds.has(model.id));
  const routes = catalog.routes.filter((route) => modelIds.has(route.modelId));
  const deploymentIds = new Set(routes.map((route) => route.deploymentId));
  const deployments = catalog.deployments.filter((deployment) => deploymentIds.has(deployment.id));
  const providerIds = new Set(deployments.map((deployment) => deployment.providerId));
  return {
    series,
    company: getCompany(series.companyId)!,
    models,
    routes,
    deployments,
    providers: catalog.providers.filter((provider) => providerIds.has(provider.id)),
  };
}

export function getCompanyDetail(id: string) {
  const company = getCompany(id);
  return company
    ? { company, series: getCompanySeries(id), models: getCompanyModels(id) }
    : undefined;
}

export function seriesHref(modelId: string): string | undefined {
  modelId = canonicalModelId(modelId);
  const series = getSeriesForModel(modelId);
  if (!series) return undefined;
  return `/${series.id}${series.modelIds[0] === modelId ? '' : `?variant=${encodeURIComponent(modelId)}`}`;
}

export function validateSeriesCatalog(): string[] {
  const errors: string[] = [];
  const companyIds = new Set<string>();
  for (const company of companies) {
    if (companyIds.has(company.id)) errors.push(`Duplicate company ID ${company.id}`);
    companyIds.add(company.id);
    if (!/^[a-z0-9-]+$/.test(company.id)) errors.push(`Invalid company slug ${company.id}`);
    if (!company.website.startsWith('https://'))
      errors.push(`Missing company website for ${company.id}`);
  }
  for (const company of companies) {
    let current: Company | undefined = company;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) {
        errors.push(`Company parent cycle at ${company.id}`);
        break;
      }
      visited.add(current.id);
      if (!current.parentCompanyId) break;
      const parent = getCompany(current.parentCompanyId);
      if (!parent) {
        errors.push(`Unknown parent company for ${current.id}`);
        break;
      }
      current = parent;
    }
  }
  const seriesIds = new Set<string>();
  const membership = new Map<string, string>();
  for (const series of modelSeries) {
    if (seriesIds.has(series.id)) errors.push(`Duplicate series ID ${series.id}`);
    seriesIds.add(series.id);
    if (!getCompany(series.companyId)) errors.push(`Unknown company for ${series.id}`);
    if (!series.id.startsWith(`${series.companyId}/`) || series.id.split('/').length !== 2)
      errors.push(`Series slug does not match its company: ${series.id}`);
    if (!series.modelIds.length) errors.push(`Empty series ${series.id}`);
    for (const modelId of series.modelIds) {
      if (!catalog.models.some((model) => model.id === modelId))
        errors.push(`Unknown model ${modelId} in ${series.id}`);
      if (membership.has(modelId)) errors.push(`Model ${modelId} belongs to multiple series`);
      membership.set(modelId, series.id);
    }
  }
  for (const model of catalog.models) {
    if (!membership.has(model.id)) errors.push(`Model ${model.id} has no public series`);
  }
  return errors;
}
