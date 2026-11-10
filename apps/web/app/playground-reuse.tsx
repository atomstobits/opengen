'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  Catalog,
  GenerateInput,
  GenerationArguments,
  Operation,
  OutputAsset,
  Route,
} from '@media-router/contracts';
import { getGenerationDefinition } from '@media-router/contracts/generation';
import { eligibleReuseRoutes, initialPlaygroundRequest } from './playground-request';
import styles from './private-playground.module.css';

type Destination = {
  operation: Operation;
  field: 'firstFrame' | 'lastFrame' | 'sourceVideo' | 'mask' | 'references' | 'targetAudio';
  label: string;
  type: 'image' | 'video' | 'audio';
};
export function reuseDestinations(
  modelId: string,
  routes: Route[],
  mediaType: string,
): Destination[] {
  const type = mediaType.startsWith('image/')
    ? 'image'
    : mediaType.startsWith('video/')
      ? 'video'
      : mediaType.startsWith('audio/')
        ? 'audio'
        : undefined;
  if (!type) return [];
  return [...new Set(routes.flatMap((route) => route.operations))].flatMap((operation) => {
    const definition = getGenerationDefinition(modelId, operation);
    if (!definition) return [];
    const fields = new Set([...definition.commonArguments, ...definition.modelSpecificArguments]);
    const destinations: Destination[] = [];
    if (type === 'image') {
      if (fields.has('firstFrame') && definition.capabilities.frames.first)
        destinations.push({
          operation,
          field: 'firstFrame',
          label: `${operation} · first frame`,
          type,
        });
      if (fields.has('lastFrame') && definition.capabilities.frames.last)
        destinations.push({
          operation,
          field: 'lastFrame',
          label: `${operation} · last frame`,
          type,
        });
      if (fields.has('mask'))
        destinations.push({ operation, field: 'mask', label: `${operation} · mask`, type });
    }
    if (type === 'video' && fields.has('sourceVideo'))
      destinations.push({
        operation,
        field: 'sourceVideo',
        label: `${operation} · source video`,
        type,
      });
    if (type === 'audio' && fields.has('targetAudio'))
      destinations.push({
        operation,
        field: 'targetAudio',
        label: `${operation} · target audio`,
        type,
      });
    if (fields.has('references') && definition.capabilities.references.types.includes(type))
      destinations.push({
        operation,
        field: 'references',
        label: `${operation} · ${type} reference`,
        type,
      });
    return destinations;
  });
}

/** Output URLs and storage keys never enter this registration request or canonical inputs. */
export function OutputReuse({
  sourceJobId,
  outputIndex,
  output,
  draft,
  catalog,
  recoveryNamespace,
  expectedHeaders,
  allowModelTransfer,
  onApply,
}: {
  sourceJobId: string;
  outputIndex: number;
  output: OutputAsset;
  draft: GenerateInput;
  catalog: Catalog;
  recoveryNamespace: string;
  expectedHeaders: Record<string, string>;
  allowModelTransfer: boolean;
  onApply: (
    request: GenerateInput,
    lineage: string,
    asset: { assetKey: string; expiresAt: string | null },
  ) => void;
}) {
  const options = catalog.models
    .filter((model) => allowModelTransfer || model.id === draft.modelId)
    .map((model) => {
      const routes = catalog.routes.filter(
        (route) => route.modelId === model.id && route.status !== 'retired',
      );
      return { model, routes, destinations: reuseDestinations(model.id, routes, output.mediaType) };
    })
    .filter(({ destinations }) => destinations.length);
  const [modelId, setModelId] = useState(
    options.find(({ model }) => model.id === draft.modelId)?.model.id ?? options[0]?.model.id,
  );
  const selected = options.find(({ model }) => model.id === modelId);
  if (!selected)
    return (
      <p className={styles.scope}>
        No compatible Playground input role is available for this output type.
      </p>
    );

  return (
    <div className={styles.reuse}>
      {options.length > 1 && (
        <label>
          Destination model
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {options.map(({ model }) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ReuseAction
        key={selected.model.id}
        sourceJobId={sourceJobId}
        outputIndex={outputIndex}
        output={output}
        draft={draft}
        {...selected}
        deployments={catalog.deployments}
        recoveryNamespace={recoveryNamespace}
        expectedHeaders={expectedHeaders}
        onApply={onApply}
      />
    </div>
  );
}

function ReuseAction({
  sourceJobId,
  outputIndex,
  draft,
  model,
  routes,
  destinations,
  deployments,
  recoveryNamespace,
  expectedHeaders,
  onApply,
}: {
  sourceJobId: string;
  outputIndex: number;
  output: OutputAsset;
  draft: GenerateInput;
  model: Catalog['models'][number];
  routes: Route[];
  destinations: Destination[];
  deployments: Catalog['deployments'];
  recoveryNamespace: string;
  expectedHeaders: Record<string, string>;
  onApply: (
    request: GenerateInput,
    lineage: string,
    asset: { assetKey: string; expiresAt: string | null },
  ) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [selectedRoute, setSelectedRoute] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const target = destinations[selected]!;
  const sameModel = model.id === draft.modelId;
  const candidates = eligibleReuseRoutes(model, routes, deployments, draft, target.operation);
  const routeId =
    (selectedRoute && candidates.some((route) => route.id === selectedRoute)
      ? selectedRoute
      : sameModel && candidates.some((route) => route.id === draft.routeId)
        ? draft.routeId
        : '') ?? '';
  const definition = getGenerationDefinition(model.id, target.operation)!;
  const caps = definition.capabilities.references;
  const references = sameModel ? (draft.input.references ?? []) : [];
  const full =
    target.field === 'references' &&
    (references.length >= (caps.totalMaximum ?? 50) ||
      references.filter((reference) => reference.type === target.type).length >=
        (caps.maximum[target.type] ?? 50));
  async function reuse() {
    if (full || !candidates.length) return;
    setBusy(true);
    setError('');
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([recoveryNamespace, sourceJobId, outputIndex])),
      );
      const key = `browser-reuse-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const response = await fetch('/api/assets/reuse', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...expectedHeaders },
        body: JSON.stringify({ sourceJobId, outputIndex }),
      });
      const body = await response.json();
      if (!active.current) return;
      if (!response.ok)
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : (body.error?.message ?? 'This output is unavailable for owned input reuse.'),
        );
      const asset = body.data ?? body;
      if (
        asset.state !== 'ready' ||
        typeof asset.assetKey !== 'string' ||
        !asset.assetKey ||
        asset.assetKey.length > 300 ||
        typeof asset.mediaType !== 'string' ||
        !asset.mediaType.startsWith(`${target.type}/`) ||
        asset.deletionPending !== false ||
        (asset.expiresAt !== null &&
          (typeof asset.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(asset.expiresAt)) ||
            Date.parse(asset.expiresAt) <= Date.now()))
      )
        throw new Error(
          `Owned input is ${asset.state ?? 'unverified'}. It cannot be used until ready and unexpired.`,
        );
      const { routeId: previousRoute, ...base } = sameModel
        ? draft
        : initialPlaygroundRequest(model, candidates, routeId || undefined, target.operation);
      const sameOperation = sameModel && draft.operation === target.operation;
      // Preserve explicit settings in the same model; a different model starts from its own defaults.
      const input: GenerationArguments = {
        ...base.input,
        ...(!sameModel && draft.input.prompt !== undefined ? { prompt: draft.input.prompt } : {}),
      };
      const ref = { assetKey: asset.assetKey };
      if (target.field === 'references')
        input.references = [...references, { type: target.type, asset: ref }];
      else input[target.field] = ref;
      const next: GenerateInput = {
        ...base,
        // Attaching another input cannot silently replace an existing execution pin.
        ...(sameOperation && previousRoute
          ? { routeId: previousRoute }
          : routeId
            ? { routeId }
            : {}),
        operation: target.operation,
        input,
        billing: draft.billing,
        maxCostMicros: draft.maxCostMicros,
        routing: { ...(draft.routing ?? base.routing), fallback: false },
      };
      if (!sameOperation) delete next.previousJobId;
      onApply(
        next,
        `Private parent job ${sourceJobId}, output ${outputIndex + 1}. Owned input ${asset.assetKey}${asset.expiresAt ? ` expires ${asset.expiresAt}` : ''}.`,
        { assetKey: asset.assetKey, expiresAt: asset.expiresAt },
      );
    } catch (cause) {
      if (active.current) setError((cause as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <label>
        Reuse output as
        <select
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(Number(event.target.value));
            setSelectedRoute(undefined);
          }}
        >
          {destinations.map((destination, index) => (
            <option value={index} key={`${destination.operation}:${destination.field}`}>
              {destination.label}
            </option>
          ))}
        </select>
      </label>
      {(!sameModel || target.operation !== draft.operation) && (
        <label>
          Destination provider route
          <select
            value={routeId}
            disabled={busy}
            onChange={(event) => setSelectedRoute(event.target.value)}
          >
            <option value="">Cheapest eligible route</option>
            {candidates.map((route) => (
              <option key={route.id} value={route.id}>
                {deployments.find((deployment) => deployment.id === route.deploymentId)?.name ??
                  route.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="button button-outline"
        disabled={busy || full || !candidates.length}
        onClick={() => void reuse()}
      >
        {busy ? 'Registering owned input…' : 'Use output as input'}
      </button>
      <p className={styles.scope}>
        {!candidates.length
          ? 'No destination route satisfies the draft’s routing and fidelity requirements. Review its routing settings before reusing this output.'
          : full
            ? 'Remove a reference from the draft before adding this output.'
            : sameModel
              ? 'Attaches a private input to the draft. Review retained settings and quote separately.'
              : 'Starts a draft with the destination inputs, current prompt and retained routing requirements. Review settings and quote separately.'}
      </p>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
