import {
  operationOrder,
  sortOperations,
  type Operation,
  type Rate,
  type Route,
  type RouteAlias,
  type RouteOperationCapabilities,
  type RoutePublishedPricing,
  type Source,
} from '@media-router/contracts';

type PublishedOutputRate = NonNullable<RoutePublishedPricing['outputRates']>[number];

function primaryOperationRank(route: Pick<Route, 'operations'>): number {
  const first = sortOperations(route.operations)[0];
  return first ? operationOrder.indexOf(first) : operationOrder.length;
}

function canonicalUnifiedRouteId(route: Pick<Route, 'id' | 'modelId' | 'deploymentId'>): string {
  // Official Alibaba Wan 3.0 routes already have canonical regional shorthand IDs (alibaba/<region>/wan-3.0*).
  if (route.id.startsWith('alibaba/') && route.deploymentId.startsWith('alibaba-model-studio-')) {
    return route.id;
  }
  return `${route.deploymentId}/${route.modelId.replace('/', '-')}`;
}

function commonUpstreamModelId(endpoints: readonly string[]): string {
  if (endpoints.length === 0) return '';
  if (endpoints.length === 1) {
    // Strip trailing single-operation suffix on single-endpoint provider paths (e.g. Pika '.../image-to-video').
    const single = endpoints[0]!;
    const stripped = single.replace(
      /\/(text-to-video|image-to-video|reference-to-video|video-to-video|text-to-image|image-to-image|edit|edit-video|extend-video|edit-image|omni-video)$/,
      '',
    );
    return stripped.includes('/') ? stripped : single;
  }
  const split = endpoints.map((item) => item.split('/'));
  const minLen = Math.min(...split.map((parts) => parts.length));
  const shared: string[] = [];
  for (let index = 0; index < minLen; index++) {
    const segment = split[0]![index]!;
    if (split.every((parts) => parts[index] === segment)) shared.push(segment);
    else break;
  }
  if (shared.length >= 2) return shared.join('/');
  // Fall back to the shortest member ID (e.g. Replicate 'xai/grok-imagine-video' + 'xai/grok-imagine-video-extension').
  return [...endpoints].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameNumberArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSource(a: Source, b: Source): boolean {
  return a.url === b.url && a.checkedAt === b.checkedAt && (a.note ?? '') === (b.note ?? '');
}

function samePublishedMetadata(
  a: RoutePublishedPricing | undefined,
  b: RoutePublishedPricing | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.summary === b.summary &&
    sameSource(a.source, b.source) &&
    sameStringArray(a.conditions, b.conditions)
  );
}

function mergeQualifiedRates(
  members: readonly Route[],
  allOperations: readonly Operation[],
): Rate[] {
  const bySignature = new Map<
    string,
    { base: Omit<Rate, 'operation'>; operations: Set<Operation> }
  >();
  for (const member of members) {
    for (const rate of member.rates) {
      const targetOps = rate.operation ? [rate.operation] : member.operations;
      const { operation: _omitted, ...base } = rate;
      const signature = JSON.stringify([
        base.resolution,
        base.unit,
        base.usdMicros,
        base.note ?? '',
      ]);
      let entry = bySignature.get(signature);
      if (!entry) {
        entry = { base, operations: new Set<Operation>() };
        bySignature.set(signature, entry);
      }
      for (const op of targetOps) entry.operations.add(op);
    }
  }
  const merged: Rate[] = [];
  for (const { base, operations } of bySignature.values()) {
    if (allOperations.every((op) => operations.has(op))) {
      merged.push({ ...base });
    } else {
      for (const op of sortOperations([...operations])) {
        merged.push({ ...base, operation: op });
      }
    }
  }
  return merged;
}

function mergePublishedOutputRates(
  members: readonly Route[],
  allOperations: readonly Operation[],
): PublishedOutputRate[] | undefined {
  const bySignature = new Map<
    string,
    { base: Omit<PublishedOutputRate, 'operation'>; operations: Set<Operation> }
  >();
  let anyRates = false;
  for (const member of members) {
    const rates = member.publishedPricing?.outputRates;
    if (!rates?.length) continue;
    anyRates = true;
    for (const rate of rates) {
      const targetOps = rate.operation ? [rate.operation] : member.operations;
      const { operation: _omitted, ...base } = rate;
      const signature = JSON.stringify([
        base.resolution,
        base.unit,
        base.usdMicros,
        base.quality ?? '',
        Boolean(base.approximate),
        base.note ?? '',
      ]);
      let entry = bySignature.get(signature);
      if (!entry) {
        entry = { base, operations: new Set<Operation>() };
        bySignature.set(signature, entry);
      }
      for (const op of targetOps) entry.operations.add(op);
    }
  }
  if (!anyRates) return undefined;
  const merged: PublishedOutputRate[] = [];
  for (const { base, operations } of bySignature.values()) {
    if (allOperations.every((op) => operations.has(op))) {
      merged.push({ ...base });
    } else {
      for (const op of sortOperations([...operations])) {
        merged.push({ ...base, operation: op });
      }
    }
  }
  return merged;
}

/**
 * Collapses operation-split provider endpoints sharing the same (modelId, deploymentId) into one
 * canonical unified Route matching the model's official route shape, emitting dedicated RouteAlias
 * entries for every retired split or provider-endpoint route ID.
 */
export function unifyRoutes(rawRoutes: readonly Route[]): {
  routes: Route[];
  routeAliases: RouteAlias[];
} {
  const groups = new Map<string, Route[]>();
  for (const entry of rawRoutes) {
    const key = `${entry.modelId}|${entry.deploymentId}`;
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }

  const unifiedRoutes: Route[] = [];
  const routeAliases: RouteAlias[] = [];

  for (const group of groups.values()) {
    const members = [...group].sort(
      (a, b) => primaryOperationRank(a) - primaryOperationRank(b) || a.id.localeCompare(b.id),
    );
    const primary = members[0]!;
    const canonicalId = canonicalUnifiedRouteId(primary);

    if (members.length === 1) {
      if (primary.id === canonicalId) {
        unifiedRoutes.push(primary);
        continue;
      }
      const singleOp = primary.operations.length === 1 ? primary.operations[0] : undefined;
      const upstreamEndpoints: Partial<Record<Operation, string>> = {};
      for (const op of primary.operations) upstreamEndpoints[op] = primary.upstreamModelId;
      unifiedRoutes.push({
        ...primary,
        id: canonicalId,
        upstreamModelId: commonUpstreamModelId([primary.upstreamModelId]),
        upstreamEndpoints,
      });
      routeAliases.push({
        id: primary.id,
        routeId: canonicalId,
        ...(singleOp ? { operation: singleOp } : {}),
      });
      continue;
    }

    const operations = sortOperations(members.flatMap((member) => member.operations));
    const resolutions = Array.from(new Set(members.flatMap((member) => member.resolutions)));
    const durations = Array.from(new Set(members.flatMap((member) => member.durations))).sort(
      (a, b) => a - b,
    );

    const upstreamEndpoints: Partial<Record<Operation, string>> = {};
    for (const member of members) {
      for (const op of member.operations) {
        if (upstreamEndpoints[op] && upstreamEndpoints[op] !== member.upstreamModelId) {
          throw new Error(
            `Conflicting upstream endpoints for ${primary.modelId} on ${primary.deploymentId} (${op}): ${upstreamEndpoints[op]} vs ${member.upstreamModelId}`,
          );
        }
        upstreamEndpoints[op] = member.upstreamModelId;
      }
    }

    const endpointList = Object.values(upstreamEndpoints).filter((value): value is string =>
      Boolean(value),
    );
    const upstreamModelId = commonUpstreamModelId(endpointList);
    const rates = mergeQualifiedRates(members, operations);
    const basePublishedMember = members.find((member) => member.publishedPricing !== undefined);
    const mergedOutputRates = mergePublishedOutputRates(members, operations);
    const publishedPricing: RoutePublishedPricing | undefined =
      basePublishedMember?.publishedPricing
        ? {
            ...basePublishedMember.publishedPricing,
            ...(mergedOutputRates ? { outputRates: mergedOutputRates } : {}),
          }
        : undefined;

    const operationCapabilities: Partial<Record<Operation, RouteOperationCapabilities>> = {};
    for (const member of members) {
      for (const op of member.operations) {
        const cap: RouteOperationCapabilities = {};
        if (!sameStringArray(member.resolutions, resolutions)) cap.resolutions = member.resolutions;
        if (!sameNumberArray(member.durations, durations)) cap.durations = member.durations;
        if (!sameSource(member.pricingSource, primary.pricingSource))
          cap.pricingSource = member.pricingSource;
        if (!sameSource(member.source, primary.source)) cap.source = member.source;
        if (
          member.publishedPricing &&
          !samePublishedMetadata(member.publishedPricing, publishedPricing)
        ) {
          cap.publishedPricing = member.publishedPricing;
        }
        if (Object.keys(cap).length > 0) operationCapabilities[op] = cap;
      }
    }

    const providerModelName = members.find((member) => member.providerModelName)?.providerModelName;
    const liveVerification = members.find((member) => member.liveVerification)?.liveVerification;

    unifiedRoutes.push({
      id: canonicalId,
      modelId: primary.modelId,
      deploymentId: primary.deploymentId,
      upstreamModelId,
      upstreamEndpoints,
      ...(providerModelName ? { providerModelName } : {}),
      operations,
      resolutions,
      durations,
      ...(Object.keys(operationCapabilities).length > 0 ? { operationCapabilities } : {}),
      fidelity: primary.fidelity,
      adapter: primary.adapter,
      status: primary.status,
      ...(liveVerification ? { liveVerification } : {}),
      rates,
      ...(publishedPricing ? { publishedPricing } : {}),
      pricingSource: primary.pricingSource,
      source: primary.source,
    });

    for (const member of members) {
      if (member.id === canonicalId) continue;
      routeAliases.push({
        id: member.id,
        routeId: canonicalId,
        ...(member.operations.length === 1 ? { operation: member.operations[0] } : {}),
      });
    }
  }

  return { routes: unifiedRoutes, routeAliases };
}
