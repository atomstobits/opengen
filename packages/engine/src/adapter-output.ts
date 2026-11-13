import type { OutputAsset } from '@media-router/contracts';
import type { AdapterContext, ProviderResult } from './adapters.js';
import type { DeliverySource } from './delivery.js';

/** Private checkpoint: persist every descriptor/inline byte before downloads or output PUTs. */
export type CaptureProviderOutputs = (
  context: AdapterContext & { upstreamId?: string },
  sources: DeliverySource[],
) => Promise<OutputAsset[]>;

/** A delivery outage cannot turn a known successful render into permission to render again. */
export async function captureProviderResult(
  capture: CaptureProviderOutputs,
  context: AdapterContext & { upstreamId?: string },
  sources: DeliverySource[],
  billedCostMicros: number | null = null,
): Promise<ProviderResult & { status: 'succeeded' }> {
  try {
    return {
      status: 'succeeded',
      billedCostMicros,
      outputs: await capture(context, sources),
    };
  } catch {
    return {
      status: 'succeeded',
      billedCostMicros,
      outputs: [],
      error: context.upstreamId
        ? 'The provider completed this generation but output delivery is unavailable. Recover the same job; do not submit another generation.'
        : 'The provider generated inline image data but delivery could not be confirmed. Bytes lost before durable staging may be unrecoverable. No render was retried.',
    };
  }
}
