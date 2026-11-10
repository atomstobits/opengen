#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  OpenGen,
  OpenGenAPIError,
  JobWaitError,
  SubmissionUncertainError,
  type RegisteredOperation,
  type SubmitOptions,
} from '@media-router/sdk';
import {
  type Job,
  catalogSearchFiltersSchema,
  operationTargets,
  canonicalModelId,
} from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { browserLogin, savedLogin, logout } from './login.js';
import { runBindingCommand } from './bindings-command.js';
import { jobRecovery, serializeCommandError } from './recovery.js';
export { serializeCommandError } from './recovery.js';

export const help = `OpenGen — discover → inspect → quote → upload → submit → resume

Commands:
  login [--timeout-ms 300000]
  status | doctor (read-only, also the default command)
  logout
  bind preview --client <cursor|claude-code> --config <private.json> --url <gateway-origin>
  bind apply --client <cursor|claude-code> --config <private.json> --url <gateway-origin> --preview-id <previewId>
  bind status --url <gateway-origin>
  catalog search [query] [--modality image|video] [--provider ID] [--region REGION]
      [--family ID] [--operation OPERATION] [--input-role ROLE]
  catalog get <company-series-model-or-route-id>
  deployments
  operations
  quote --input <request.json|->
  generate --input <request.json|-> --idempotency-key <persisted-key>
  upload <file> [--media-type image/png|image/jpeg|image/webp|video/mp4]
  call <registered-operation-id> [--input <private.json|->] [--idempotency-key <persisted-key>]
  job recover --idempotency-key <persisted-key> (read-only lookup)
  job get <id>
  job wait <id> [--timeout-ms 900000] [--poll-interval-ms 2000]
  job resume <id> [--timeout-ms 900000] [--poll-interval-ms 2000]
  job cancel <id>
  balance

MEDIA_ROUTER_URL selects the gateway (default http://127.0.0.1:4310).
MEDIA_ROUTER_TOKEN explicitly overrides browser login. No token or provider-key argv option exists.
Run login to select a paying workspace in your browser; status validates access without refreshing or changing credentials.
Use a private input file or stdin for account/connection payloads. Catalog listing is not live verification.
Persist the original input/key before generation and the returned job ID before waiting.
Timeout/interrupt only stops the client wait. It does not cancel or replace provider work.
Native requests use {modelId, operation, input: {common and model-specific arguments}, ...routing}.
Inline JSON is accepted for quote/generate; private files avoid shell history.
`;

interface CommandOptions {
  client?: OpenGen;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  profilePath?: string;
  openBrowser?: (url: string) => void | Promise<void>;
  onLoginUrl?: (url: string) => void;
  signal?: AbortSignal;
  uploadFetch?: typeof fetch;
  stdin?: AsyncIterable<Uint8Array>;
}
const mediaTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
]);
const uploadLimit = 100 * 1024 * 1024;
async function readBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Input exceeds the permitted size.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
async function jsonInput(
  path: string | undefined,
  inline: string | undefined,
  stdin: AsyncIterable<Uint8Array>,
): Promise<unknown> {
  let text: string;
  if (path)
    text = (
      await readBounded(path === '-' ? stdin : createReadStream(resolve(path)), 1_000_000)
    ).toString();
  else if (inline) text = inline;
  else return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Input must contain valid JSON. The private input was not printed.');
  }
}

export async function runCommand(args: string[], options: CommandOptions = {}): Promise<unknown> {
  if (args[0] === 'bind') return runBindingCommand(args.slice(1));
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args,
        allowPositionals: true,
        options: {
          help: { type: 'boolean' },
          modality: { type: 'string' },
          provider: { type: 'string' },
          region: { type: 'string' },
          family: { type: 'string' },
          operation: { type: 'string' },
          'input-role': { type: 'string' },
          input: { type: 'string' },
          'idempotency-key': { type: 'string' },
          'media-type': { type: 'string' },
          'timeout-ms': { type: 'string' },
          'poll-interval-ms': { type: 'string' },
        },
      });
    } catch {
      throw new Error('Invalid arguments. Run opengen --help; private arguments were not printed.');
    }
  })();
  if (values.help) return help;
  const [command = 'doctor', action, id] = positionals;
  const { signal } = options;
  const env = options.env ?? process.env;
  const baseUrl = env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310';
  const environmentToken = env.MEDIA_ROUTER_TOKEN || undefined;
  const loginOptions = { baseUrl, profilePath: options.profilePath, request: options.request };
  if (command === 'login')
    return browserLogin({
      ...loginOptions,
      signal,
      openBrowser: options.openBrowser,
      onLoginUrl: options.onLoginUrl,
      ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
    });
  if (command === 'logout')
    return {
      ...(await logout({ profilePath: options.profilePath, request: options.request })),
      environmentTokenConfigured: Boolean(environmentToken),
    };
  const diagnosis = command === 'doctor' || command === 'status';
  let profile;
  try {
    profile = environmentToken
      ? undefined
      : await savedLogin({ ...loginOptions, refresh: !diagnosis });
  } catch (error) {
    if (!diagnosis) throw error;
    const nextBlocker = {
      code: 'credential_unusable',
      message:
        'The saved private profile could not be used. Repair its permissions or sign in again; credentials were not printed or modified.',
      nextCommand: 'opengen login',
    };
    return {
      connected: false,
      authenticated: false,
      authorized: false,
      credentialPresent: true,
      authentication: 'browser',
      baseUrl,
      nextBlocker,
      nextCommand: nextBlocker.nextCommand,
    };
  }
  // Saved access tokens remain inside the transport; commands only return safe summaries.
  const client =
    options.client ??
    new OpenGen({
      baseUrl,
      apiKey: environmentToken ?? profile?.accessToken,
      fetch: options.request,
    });
  if (diagnosis) {
    const summary = {
      baseUrl,
      credentialPresent: Boolean(environmentToken || profile),
      authentication: environmentToken ? 'environment' : profile ? 'browser' : 'none',
    };
    try {
      const report = await client.doctor({ signal });
      if (
        report.authenticated !== true ||
        !report.payingWorkspace?.id ||
        !Array.isArray(report.scopes)
      )
        throw new Error('The gateway did not return a supported diagnosis response.');
      return { ...summary, ...report, connected: true, workspaceId: report.payingWorkspace.id };
    } catch (error) {
      const api = error instanceof OpenGenAPIError ? error : undefined;
      const scopeDenied = api?.status === 403 && api.code === 'insufficient_scope';
      const code =
        api?.status === 401
          ? summary.credentialPresent
            ? 'credential_rejected'
            : 'credential_missing'
          : scopeDenied
            ? 'insufficient_scope'
            : (api?.code ?? 'gateway_unavailable');
      const message =
        api?.status === 401
          ? summary.credentialPresent
            ? 'The gateway rejected this credential. Sign in again or replace the environment token.'
            : 'No credential is configured. Sign in to choose the paying workspace and grant scoped access.'
          : scopeDenied
            ? 'The gateway denied diagnosis for this credential. Read scope is required.'
            : 'The gateway could not validate access. Check the selected origin and deployment; configured credentials do not establish authentication.';
      const nextCommand =
        api?.status === 401 || scopeDenied || !summary.credentialPresent
          ? 'opengen login'
          : 'opengen status';
      const nextBlocker = { code, message, nextCommand };
      return {
        ...summary,
        connected: scopeDenied,
        authenticated: scopeDenied,
        authorized: false,
        verification: { status: api?.status ?? null, code },
        account: null,
        payingWorkspace: null,
        scopes: null,
        balance: null,
        executableRoutes: null,
        nextBlocker,
        nextCommand,
      };
    }
  }
  const withRecovery = <T>(value: T): T | (T & { recovery: ReturnType<typeof jobRecovery> }) =>
    value && typeof value === 'object' && 'id' in value && 'status' in value
      ? { ...value, recovery: jobRecovery(value as unknown as Job, baseUrl) }
      : value;
  const input = () =>
    jsonInput(
      values.input,
      command === 'quote' || command === 'generate' ? action : undefined,
      options.stdin ?? process.stdin,
    );
  if (command === 'catalog' && action === 'search')
    return client.search(
      positionals.slice(2).join(' '),
      { signal },
      catalogSearchFiltersSchema.parse({
        modality: values.modality,
        providerId: values.provider,
        region: values.region,
        familyId: values.family,
        operation: values.operation,
        inputRole: values['input-role'],
      }),
    );
  if (command === 'catalog' && action === 'get') {
    if (!id) throw new Error('Supply a catalog identifier.');
    const catalog = await client.catalog({ signal });
    const series = catalog.series.find((entry) => entry.id === id);
    if (series) {
      const [company, slug] = series.id.split('/');
      return client.series(company!, slug!, { signal });
    }
    if (catalog.companies.some((entry) => entry.id === id)) return client.company(id, { signal });
    const result =
      catalog.models.find((entry) => entry.id === canonicalModelId(id)) ??
      catalog.routes.find((entry) => entry.id === id) ??
      catalog.deployments.find((entry) => entry.id === id);
    if (!result) throw new Error('Catalog entry not found.');
    return result;
  }
  if (command === 'deployments') return client.call('deployments.list', {}, { signal });
  if (command === 'operations') return client.operations({ signal });
  if (command === 'quote') return client.quote(parseGenerationRequest(await input()), { signal });
  if (command === 'generate') {
    if (!values['idempotency-key'])
      throw new Error(
        'Supply --idempotency-key. Persist it with the original input before submission.',
      );
    return withRecovery(
      await client.submit(parseGenerationRequest(await input()), {
        idempotencyKey: values['idempotency-key'],
        signal,
      }),
    );
  }
  if (command === 'call') {
    if (!action || !Object.hasOwn(operationTargets, action))
      throw new Error(
        'Unknown registered operation. Run operations; arbitrary URL targets are not accepted.',
      );
    if (positionals.length > 2)
      throw new Error(
        'Read registered-operation input from --input <private.json|->, not inline argv.',
      );
    const requestOptions = { signal, idempotencyKey: values['idempotency-key'] } as SubmitOptions;
    let payload = await input();
    if (action === 'media.generate' || action === 'quotes.single')
      payload = parseGenerationRequest(payload);
    if (action === 'quotes.batch') {
      if (!Array.isArray(payload))
        throw new Error('Batch quote input must be an array of canonical generation requests.');
      payload = payload.map(parseGenerationRequest);
    }
    const result = await client.call(
      action as RegisteredOperation,
      payload as never,
      requestOptions,
    );
    return action === 'media.generate' ? withRecovery(result) : result;
  }
  if (command === 'upload') {
    if (!action) throw new Error('Supply a supported private image, video or audio file.');
    const file = resolve(action);
    const mediaType = values['media-type'] ?? mediaTypes.get(extname(file).toLowerCase());
    if (!mediaType || ![...mediaTypes.values(), 'audio/webm'].includes(mediaType))
      throw new Error(
        'Upload a supported PNG/JPEG/WebP image, MP4/WebM video or MPEG/WAV/Ogg/FLAC/MP4/WebM audio; use --media-type for an exact supported container.',
      );
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > uploadLimit)
      throw new Error('Upload must be a regular nonempty file of at most 100 MiB.');
    const bytes = await readBounded(createReadStream(file), uploadLimit);
    signal?.throwIfAborted();
    const prepared = await client.call(
      'assets.prepare',
      { mediaType, size: bytes.byteLength },
      { signal },
    );
    try {
      const response = await (options.uploadFetch ?? fetch)(prepared.uploadUrl, {
        method: 'PUT',
        headers: prepared.headers,
        body: new Uint8Array(bytes),
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Object storage rejected the upload.');
      const complete = await client.call('assets.complete', { key: prepared.key }, { signal });
      if (
        complete.state !== 'ready' ||
        complete.assetKey !== prepared.key ||
        complete.deletionPending ||
        complete.mediaType !== mediaType ||
        (complete.expiresAt !== null &&
          (!Number.isFinite(Date.parse(complete.expiresAt)) ||
            Date.parse(complete.expiresAt) <= Date.now()))
      )
        throw new Error(
          'Upload is not a ready, retained owned input. Inspect the same asset before generation.',
        );
      return {
        asset: { assetKey: prepared.key },
        mediaType: complete.mediaType,
        byteLength: bytes.byteLength,
      };
    } catch {
      try {
        await client.call('assets.delete', { key: prepared.key });
      } catch {
        /* Best-effort removal; never start generation or repeat the upload. */
      }
      throw new Error(
        'Upload did not complete. No generation was submitted; storage credentials and response details were not printed.',
      );
    }
  }
  if (command === 'job') {
    if (action === 'recover') {
      if (!values['idempotency-key'])
        throw new Error('Supply the original persisted --idempotency-key for read-only lookup.');
      try {
        return withRecovery(await client.lookupJob(values['idempotency-key'], { signal }));
      } catch (error) {
        throw new SubmissionUncertainError(
          values['idempotency-key'],
          error instanceof OpenGenAPIError ? error.status : undefined,
          error,
        );
      }
    }
    if (!id) throw new Error('Supply the existing job ID.');
    if (action === 'get') {
      try {
        return withRecovery(await client.job(id, { signal }));
      } catch (error) {
        throw new JobWaitError(id, undefined, Boolean(signal?.aborted), error);
      }
    }
    if (action === 'cancel') return withRecovery(await client.cancel(id, { signal }));
    if (action === 'wait' || action === 'resume')
      return withRecovery(
        await client.wait(id, {
          signal,
          ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
          ...(values['poll-interval-ms']
            ? { pollIntervalMs: Number(values['poll-interval-ms']) }
            : {}),
        }),
      );
  }
  if (command === 'balance') return client.balance({ signal });
  throw new Error('Unknown command. Run opengen --help.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () =>
    controller.abort(
      new Error('Client interrupted. Existing provider work was not cancelled or replaced.'),
    );
  process.once('SIGINT', stop);
  try {
    const result = await runCommand(process.argv.slice(2), {
      onLoginUrl: (url) => console.error(`Complete OpenGen sign-in in your browser: ${url}`),
      signal: controller.signal,
    });
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        serializeCommandError(error, {
          baseUrl: process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310',
        }),
        null,
        2,
      ),
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
  }
}
