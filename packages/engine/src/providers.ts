import type { CaptureProviderOutputs } from './adapter-output.js';
import { createAlibabaAdapter, type ProviderAdapter } from './adapters.js';
import { createBytePlusAdapter } from './byteplus.js';
import { createFalAdapter } from './fal.js';
import {
  createOpenAIAdapter,
  type StoreProviderImage,
  type StoreProviderOutput,
} from './openai.js';
import { createXaiAdapter } from './xai.js';
import { createMiniMaxAdapter } from './minimax.js';
import { createGoogleImageAdapter } from './google.js';
import { createQwenImageAdapter, isQwenImageModel } from './qwen.js';
import { createReplicateAdapter } from './replicate.js';
import { createGoogleVideoAdapter } from './google-video.js';
import { createRunwayAdapter } from './runway.js';
import { createPikaAdapter } from './pika.js';

export {
  createFalAdapter,
  createOpenAIAdapter,
  createXaiAdapter,
  createMiniMaxAdapter,
  createGoogleImageAdapter,
  createQwenImageAdapter,
  createReplicateAdapter,
  createGoogleVideoAdapter,
  createRunwayAdapter,
  createPikaAdapter,
};
export { openAIImageSize, type StoreProviderImage, type StoreProviderOutput } from './openai.js';

/** One public Alibaba adapter ID, with explicit Wan-video and Qwen-image protocol branches. */
export function createAlibabaMediaAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const wan = createAlibabaAdapter(options);
  const qwen = createQwenImageAdapter(options);
  const forRoute = (route: Parameters<ProviderAdapter['isConfigured']>[0]) =>
    isQwenImageModel(route.upstreamModelId) ? qwen : wan;
  return {
    id: 'alibaba',
    supportedOperations: [
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'text-to-image',
      'image-edit',
    ],
    isConfigured: (route, deployment) => forRoute(route).isConfigured(route, deployment),
    inputFields: (context) => forRoute(context.route).inputFields?.(context) ?? [],
    preflight: (context) => forRoute(context.route).preflight!(context),
    submit: (context) => forRoute(context.route).submit(context),
    poll: (context) => forRoute(context.route).poll(context),
  };
}

export function createGoogleMediaAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storeOutput?: StoreProviderOutput;
    captureOutputs?: CaptureProviderOutputs;
  } = {},
): ProviderAdapter {
  const image = createGoogleImageAdapter(options);
  const video = createGoogleVideoAdapter(options);
  const forRoute = (route: Parameters<ProviderAdapter['isConfigured']>[0]) =>
    route.upstreamModelId === 'gemini-omni-1.1-flash' ? video : image;
  return {
    id: 'google',
    supportedOperations: [
      'text-to-image',
      'image-edit',
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'video-edit',
      'video-extend',
    ],
    isConfigured: (route, deployment) => forRoute(route).isConfigured(route, deployment),
    inputFields: (context) => forRoute(context.route).inputFields?.(context) ?? [],
    preflight: (context) => forRoute(context.route).preflight!(context),
    submit: (context) => forRoute(context.route).submit(context),
    poll: (context) => forRoute(context.route).poll(context),
  };
}

export function createDefaultAdapters(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storeOutput?: StoreProviderImage;
    captureOutputs?: CaptureProviderOutputs;
  } = {},
): ProviderAdapter[] {
  return [
    createAlibabaMediaAdapter(options),
    createBytePlusAdapter(options),
    createFalAdapter(options),
    createOpenAIAdapter(options),
    createXaiAdapter(options),
    createMiniMaxAdapter(options),
    createGoogleMediaAdapter(options),
    createReplicateAdapter(options),
    createRunwayAdapter(options),
    createPikaAdapter(options),
  ];
}
