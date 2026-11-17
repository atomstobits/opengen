import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  createEngine,
  readExecutionScopeConfiguration,
  type EngineOptions,
} from '@media-router/engine';
import { inspectOutput, type InspectionRunner } from '../../../packages/engine/src/inspection.js';
import { operationalError } from './operational-error.js';
import { workServerOnce } from './worker-turn.js';
import { readProviderExecutionConfiguration } from './provider-execution.js';

const defaultFfprobePath = '/usr/bin/ffprobe';

export async function verifyTrustedWorkerBinary(
  candidatePath: string,
  required = false,
): Promise<string | undefined> {
  if (
    typeof candidatePath !== 'string' ||
    !candidatePath ||
    !isAbsolute(candidatePath) ||
    /[\u0000-\u001f\u007f]/.test(candidatePath)
  ) {
    if (required)
      throw new Error('Configured worker media binary path must be a canonical absolute path.');
    return undefined;
  }
  try {
    const resolved = await realpath(candidatePath);
    if (!isAbsolute(resolved)) return undefined;
    const facts = await stat(resolved);
    if (!facts.isFile() || (facts.mode & 0o002) !== 0) {
      if (required)
        throw new Error(
          'Configured worker media binary must be a non-world-writable regular file.',
        );
      return undefined;
    }
    await access(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    if (required)
      throw error instanceof Error && error.message.startsWith('Configured worker media')
        ? error
        : new Error('Configured worker media binary is missing or not executable.');
    return undefined;
  }
}

export const runScrubbedInspectionBinary: InspectionRunner = (executable, args, options) =>
  new Promise((resolve) => {
    const whitelistIndex = args.indexOf('-protocol_whitelist');
    if (!isAbsolute(executable) || whitelistIndex < 0 || args[whitelistIndex + 1] !== 'file,pipe') {
      resolve({ stdout: '', stderr: 'protocol_whitelist_required', exitCode: 'EACCES' });
      return;
    }
    const scrubbedEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      PATH: dirname(executable),
      HOME: options.cwd,
      TMPDIR: options.cwd,
      LANG: 'C',
    };
    const child = execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        env: scrubbedEnv,
        timeout: Math.min(options.timeout, 15_000),
        maxBuffer: Math.min(options.maxBuffer, 512 * 1024),
        encoding: 'utf8',
        shell: false,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & { code?: number | string | null; killed?: boolean; signal?: string | null })
          | null;
        resolve({
          stdout,
          stderr,
          exitCode: failure
            ? failure.signal
              ? `signal:${failure.signal}`
              : (failure.code ?? 'process_failed')
            : 0,
          killed: failure?.killed || Boolean(failure?.signal),
        });
      },
    );
    child.stdin?.end();
  });

export async function resolveWorkerDeliveryOptions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NonNullable<EngineOptions['delivery']>> {
  if (
    env.OPENGEN_FFPROBE_NETWORK_ISOLATED !== undefined &&
    env.OPENGEN_FFPROBE_NETWORK_ISOLATED !== 'true' &&
    env.OPENGEN_FFPROBE_NETWORK_ISOLATED !== 'false'
  ) {
    throw new Error('OPENGEN_FFPROBE_NETWORK_ISOLATED must be true or false when set.');
  }
  const rawProbePath = env.OPENGEN_FFPROBE_PATH?.trim();
  const probeDisabled =
    rawProbePath !== undefined &&
    ['disabled', 'false', 'none'].includes(rawProbePath.toLowerCase());
  let probePath: string | undefined;
  if (probeDisabled) {
    probePath = undefined;
  } else if (rawProbePath) {
    probePath = await verifyTrustedWorkerBinary(rawProbePath, true);
  } else {
    probePath = await verifyTrustedWorkerBinary(defaultFfprobePath, false);
  }

  let decodePath: string | undefined;
  if (probePath) {
    const rawDecodePath = env.OPENGEN_FFMPEG_PATH?.trim();
    const decodeDisabled =
      rawDecodePath !== undefined &&
      ['disabled', 'false', 'none'].includes(rawDecodePath.toLowerCase());
    if (decodeDisabled) {
      decodePath = undefined;
    } else if (rawDecodePath) {
      decodePath = await verifyTrustedWorkerBinary(rawDecodePath, true);
    } else {
      decodePath =
        (await verifyTrustedWorkerBinary(join(dirname(probePath), 'ffmpeg'), false)) ??
        (await verifyTrustedWorkerBinary('/usr/bin/ffmpeg', false));
    }
  }

  const ffprobeNetworkIsolated = env.OPENGEN_FFPROBE_NETWORK_ISOLATED === 'true';

  // Keep absent or non-isolated c2patool truthfully unavailable/unknown unless explicitly configured and verified.
  let verifiedC2paPath: string | undefined;
  if (env.C2PA_TOOL_PATH && env.C2PA_TOOL_NETWORK_ISOLATED === 'true') {
    verifiedC2paPath = await verifyTrustedWorkerBinary(env.C2PA_TOOL_PATH, false);
  }
  const provenance = verifiedC2paPath
    ? {
        toolPath: verifiedC2paPath,
        networkIsolated: true,
        ...(env.C2PA_TRUST_ANCHORS_PATH ? { trustAnchorsPath: env.C2PA_TRUST_ANCHORS_PATH } : {}),
        ...(env.C2PA_TSA_TRUST_ANCHORS_PATH
          ? { tsaTrustAnchorsPath: env.C2PA_TSA_TRUST_ANCHORS_PATH }
          : {}),
      }
    : {
        toolPath: '',
        networkIsolated: false,
      };

  return {
    ...(probePath
      ? {
          inspect: (bytes, mediaType) =>
            inspectOutput(bytes, mediaType, {
              probePath,
              decodePath,
              networkIsolated: ffprobeNetworkIsolated,
              run: runScrubbedInspectionBinary,
            }),
        }
      : {}),
    provenance,
  };
}

async function runWorker() {
  const providerExecutionEnabled = readProviderExecutionConfiguration(process.env);
  const executionScope = readExecutionScopeConfiguration(process.env);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the worker.');
  const delivery = await resolveWorkerDeliveryOptions(process.env);
  const engine = createEngine({
    databaseUrl: process.env.DATABASE_URL,
    providerExecutionEnabled,
    executionScope,
    delivery,
  });
  await engine.initialize();
  let stopping = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      await workServerOnce(engine);
    } catch (error) {
      console.error('Worker iteration failed:', operationalError(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await engine.close();
}

if (process.env.OPENGEN_WORKER_NO_AUTOSTART !== '1') {
  await runWorker();
}
