import type { RoutingPolicy } from '@media-router/contracts';

/** Local form shape until the shared contract checkpoint exports these fields. */
export interface GovernanceRoutingPolicy extends RoutingPolicy {
  modelIds?: string[];
  modelProviderExceptions?: { modelId: string; providerIds: string[] }[];
  authorOnly?: boolean;
}

/** Parse dollars exactly. Empty removes the cap; zero is a deliberate zero cap. */
export function usdInputToMicros(value: string): number | null {
  const input = value.trim();
  if (!input) return null;
  if (input.length > 32) throw new Error('This USD amount is too large.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(input))
    throw new Error('Enter USD with up to six decimal places, for example 25.00.');
  const [whole = '0', fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This USD amount is too large.');
  return Number(amount);
}

export function microsToUsdInput(value: number | null): string {
  if (value === null) return '';
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid micro-USD amount.');
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export function governanceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('Use a name of 1–80 characters without control characters.');
  return name;
}

export function policyFromForm(
  original: GovernanceRoutingPolicy,
  values: {
    modelRestriction: 'any' | 'selected' | 'none';
    modelIds: string[];
    authorOnly: boolean;
    modelProviderExceptions: { modelId: string; providerIds: string[] }[];
  },
): GovernanceRoutingPolicy {
  const unique = (items: string[]) => [...new Set(items)];
  if (values.modelRestriction === 'selected' && !values.modelIds.length)
    throw new Error('Select an exact model, or choose “Block all models”.');
  const models = values.modelProviderExceptions.map((item) => item.modelId);
  if (unique(models).length !== models.length)
    throw new Error('Use one provider exception per exact model.');
  if (models.some((id) => !id.trim())) throw new Error('Choose an exact model for each exception.');
  // Copy all existing constraints. Editing a model rule cannot erase region,
  // deployment, processing, fidelity, preference, fallback or future fields.
  const policy: GovernanceRoutingPolicy = {
    ...original,
    authorOnly: values.authorOnly,
    modelProviderExceptions: values.modelProviderExceptions.map((item) => ({
      modelId: item.modelId,
      providerIds: unique(item.providerIds),
    })),
  };
  if (values.modelRestriction === 'any') delete policy.modelIds;
  else policy.modelIds = values.modelRestriction === 'none' ? [] : unique(values.modelIds);
  return policy;
}
