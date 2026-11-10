/** Raw HTTP feature examples. No SDK, provider credentials or automatic paid retries. */
import { pathToFileURL } from 'node:url';

export const fixtureAssetKey = 'inputs/fixture/00000000-0000-4000-8000-000000000001.png';

export function featureRequest(kind, { assetKey = fixtureAssetKey, capMicros = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(capMicros) || capMicros < 0)
    throw new Error('capMicros must be a nonnegative safe integer in micro-USD.');
  const requests = {
    'text-to-image': {
      modelId: 'bytedance/seedream-5.0-pro',
      operation: 'text-to-image',
      input: { prompt: 'A paper lighthouse on a plain blue background.', resolution: '1K' },
    },
    'image-to-video': {
      modelId: 'kling/kling-4.0',
      operation: 'image-to-video',
      input: {
        prompt: 'A slow push-in toward the paper lighthouse.',
        firstFrame: { assetKey },
        duration: 5,
        resolution: '720p',
        aspectRatio: 'source',
      },
    },
    'image-edit': {
      modelId: 'bytedance/seedream-5.0-pro',
      operation: 'image-edit',
      input: {
        prompt: 'Change the paper lighthouse roof to orange; preserve the composition.',
        references: [{ type: 'image', asset: { assetKey } }],
        resolution: '1K',
      },
    },
  };
  const input = requests[kind];
  if (!input) throw new Error('Choose text-to-image, image-to-video or image-edit.');
  return { ...input, billing: 'managed', maxCostMicros: capMicros };
}

export function schemaPath(input) {
  return (
    '/v1/models/schema?' +
    new URLSearchParams({ modelId: input.modelId, operation: input.operation })
  );
}

export function mcpCall(id, operationId, input, idempotencyKey) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'call',
      arguments: {
        operationId,
        input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    },
  };
}

/** Injectable fetch keeps the exact example executable against local HTTP fixtures in tests. */
export function httpClient({ apiUrl = 'https://opengen.dev', token, fetchImpl = fetch }) {
  const origin = new URL(apiUrl);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('Use an HTTP(S) API origin without embedded credentials.');
  return async (method, path, body, idempotencyKey) => {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('Use an API-relative path.');
    const target = new URL(path, origin);
    if (target.origin !== origin.origin)
      throw new Error('Use an API-relative path on the configured origin.');
    const response = await fetchImpl(target, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error?.message ?? `HTTP ${response.status}`), {
        status: response.status,
        code: value.error?.code,
        response: value,
      });
    return value;
  };
}

/** A transport interruption exits with its key intact. There is exactly one submit attempt. */
export async function runFeatureExample({
  request,
  send,
  submit = false,
  idempotencyKey,
  onAccepted,
}) {
  const profile = await send('GET', schemaPath(request));
  const routes = await send(
    'GET',
    '/v1/routes?' + new URLSearchParams({ modelId: request.modelId }),
  );
  const quote = await send('POST', '/v1/quotes', request);
  if (!submit) return { profile, routes, quote };
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new Error('Persist an Idempotency-Key of 1–200 characters before submission.');
  if (
    !quote.selectedRouteId ||
    !quote.candidates.some((item) => item.routeId === quote.selectedRouteId && item.executable)
  )
    throw new Error(
      'No executable quote. Inspect candidate issues, pricing and configuration before spending.',
    );
  let job;
  try {
    job = await send('POST', '/v1/generations', request, idempotencyKey);
  } catch (cause) {
    throw Object.assign(
      new Error(
        'Submission returned no receipt. Preserve the original request and key; do not create a replacement generation.',
        { cause },
      ),
      {
        stage: 'submission',
        idempotencyKey,
      },
    );
  }
  const receipt = Object.freeze({
    jobId: job.id,
    idempotencyKey,
    resumePath: `/v1/generations/${encodeURIComponent(job.id)}`,
  });
  let stage = 'receipt';
  try {
    // Persist/emit accepted identity before any optional post-admission read can fail.
    await onAccepted?.(receipt);
    stage = 'read';
    // A single read demonstrates recovery. It never starts replacement paid work.
    return { profile, routes, quote, job, current: await resumeJob(send, job.id) };
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Generation accepted; ${stage === 'receipt' ? 'receipt persistence' : 'the first job read'} failed. Resume the existing job.`,
        { cause },
      ),
      {
        stage,
        ...receipt,
      },
    );
  }
}

/** Safe recovery output: never serialize a failed response, cause, prompt or media. */
export function featureFailure(error) {
  const result = { error: error instanceof Error ? error.message : 'Feature request failed.' };
  if (typeof error?.idempotencyKey === 'string') result.idempotencyKey = error.idempotencyKey;
  if (typeof error?.jobId === 'string') {
    result.jobId = error.jobId;
    result.recovery = {
      method: 'GET',
      path: error.resumePath,
      command: `node examples/http-feature-contracts.mjs --resume ${JSON.stringify(error.jobId)}`,
    };
  } else if (error?.stage === 'submission') {
    result.recovery = {
      method: 'GET',
      path: lookupPath(error.idempotencyKey),
      command: 'node examples/http-feature-contracts.mjs --lookup',
      action:
        'Retain the original request and OPENGEN_IDEMPOTENCY_KEY. Repeat read-only lookup; a 404 does not establish rejection. Ask the operator to reconcile rather than creating a replacement submission.',
    };
  }
  return result;
}

export function lookupPath(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200)
    throw new Error('Use the original Idempotency-Key of 1–200 characters.');
  return '/v1/generations/lookup?' + new URLSearchParams({ idempotencyKey });
}

export async function lookupSubmission(send, idempotencyKey) {
  return send('GET', lookupPath(idempotencyKey));
}

export async function resumeJob(send, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id))
    throw new Error('Use a gateway job ID.');
  return send('GET', `/v1/generations/${encodeURIComponent(id)}`);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const kind = args[0] ?? 'image-to-video';
  if (args.includes('--lookup')) {
    const send = httpClient({ apiUrl: env.OPENGEN_API_URL, token: env.OPENGEN_TOKEN });
    console.log(JSON.stringify(await lookupSubmission(send, env.OPENGEN_IDEMPOTENCY_KEY), null, 2));
    return;
  }
  if (args.includes('--resume')) {
    const send = httpClient({ apiUrl: env.OPENGEN_API_URL, token: env.OPENGEN_TOKEN });
    console.log(JSON.stringify(await resumeJob(send, option('--resume')), null, 2));
    return;
  }
  const request = featureRequest(kind, {
    assetKey: env.OPENGEN_ASSET_KEY,
    capMicros: env.OPENGEN_CAP_MICROS === undefined ? undefined : Number(env.OPENGEN_CAP_MICROS),
  });
  if (!args.includes('--inspect') && !args.includes('--submit')) {
    console.log(
      JSON.stringify(
        {
          schema: schemaPath(request),
          quote: { method: 'POST', path: '/v1/quotes', body: request },
          submit: {
            method: 'POST',
            path: '/v1/generations',
            body: request,
            requires: 'Explicit --submit plus OPENGEN_TOKEN and persistent OPENGEN_IDEMPOTENCY_KEY',
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  const submit = args.includes('--submit');
  if (submit && (!env.OPENGEN_TOKEN || !env.OPENGEN_IDEMPOTENCY_KEY))
    throw new Error('--submit requires OPENGEN_TOKEN and a persisted OPENGEN_IDEMPOTENCY_KEY.');
  if (kind !== 'text-to-image' && !env.OPENGEN_ASSET_KEY)
    throw new Error(
      'Set OPENGEN_ASSET_KEY to a ready upload belonging to the authenticated workspace.',
    );
  const result = await runFeatureExample({
    request,
    send: httpClient({ apiUrl: env.OPENGEN_API_URL, token: env.OPENGEN_TOKEN }),
    submit,
    idempotencyKey: env.OPENGEN_IDEMPOTENCY_KEY,
    onAccepted: async (receipt) => {
      // Redirect stdout to a private receipt log if durable local recovery is required.
      console.log(JSON.stringify({ accepted: receipt }));
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(JSON.stringify(featureFailure(error), null, 2));
    process.exitCode = 1;
  });
