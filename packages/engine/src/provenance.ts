import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';

import type { C2paVerification } from '@media-router/contracts';
export type { C2paVerification } from '@media-router/contracts';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const entries = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
const safeText = (value: unknown) =>
  typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f]/.test(value)
    ? value
    : undefined;

/** Only the verifier's explicit state establishes validity; missing errors never do. */
export function parseC2paReport(
  report: unknown,
  trustConfigured = false,
): Pick<C2paVerification, 'status' | 'validationCodes' | 'manifestLabel' | 'signer' | 'reason'> {
  const root = object(report);
  const label = safeText(root.active_manifest);
  const manifest = label ? object(object(root.manifests)[label]) : {};
  const results = object(root.validation_results);
  const active = object(results.activeManifest);
  const failures = entries(active.failure);
  const statuses = [
    ...entries(active.success),
    ...entries(active.informational),
    ...failures,
    ...entries(root.validation_status),
  ];
  const validationCodes = [
    ...new Set(
      statuses
        .map((value) => value.code)
        .filter(
          (code): code is string =>
            typeof code === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(code),
        ),
    ),
  ].slice(0, 50);
  const state = root.validation_state;
  if (state === 'Invalid') return { status: 'invalid', validationCodes, manifestLabel: label };
  // An untrusted signer does not by itself invalidate cryptographic integrity.
  const integrityFailures = failures.filter(
    (value) => !['signingCredential.untrusted', 'timeStamp.untrusted'].includes(String(value.code)),
  );
  if (integrityFailures.length) return { status: 'invalid', validationCodes, manifestLabel: label };
  if (!label || !Object.keys(manifest).length || !['Trusted', 'Valid'].includes(String(state)))
    return { status: 'unknown', validationCodes, reason: 'unrecognized_validation_report' };
  return {
    status:
      state === 'Trusted' &&
      trustConfigured &&
      !validationCodes.some((code) => code.endsWith('.untrusted'))
        ? 'trusted'
        : 'valid',
    validationCodes,
    manifestLabel: label,
    signer: safeText(object(manifest.signature_info).issuer),
  };
}

interface ToolOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | string;
  killed?: boolean;
}
export type ProvenanceRunner = (
  executable: string,
  args: string[],
  options: ToolOptions,
) => Promise<ToolResult>;
const runTool: ProvenanceRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      args,
      { ...options, encoding: 'utf8', shell: false, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({ stdout, stderr, exitCode: failure?.code ?? 0, killed: failure?.killed });
      },
    );
  });
export interface ProvenanceOptions {
  toolPath?: string;
  networkIsolated?: boolean;
  trustAnchorsPath?: string;
  tsaTrustAnchorsPath?: string;
  run?: ProvenanceRunner;
}

export async function verifyC2pa(
  bytes: Uint8Array,
  mediaType: string,
  options: ProvenanceOptions = {},
): Promise<C2paVerification> {
  const base = {
    checkedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tool: 'c2patool' as const,
    validationCodes: [],
  };
  const toolPath = options.toolPath ?? process.env.C2PA_TOOL_PATH;
  const isolated = options.networkIsolated ?? process.env.C2PA_TOOL_NETWORK_ISOLATED === 'true';
  if (!toolPath) return { ...base, status: 'unavailable', reason: 'tool_not_configured' };
  if (!isAbsolute(toolPath))
    return { ...base, status: 'unavailable', reason: 'absolute_tool_path_required' };
  // Current SDK docs flag CAWG fetches that bypass the host allowlist. Deployment
  // must also block network egress for this trusted executable; settings alone are insufficient.
  if (!isolated) return { ...base, status: 'unavailable', reason: 'network_isolation_required' };
  const extension = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['video/mp4', 'mp4'],
  ]).get(mediaType);
  if (!extension || !bytes.byteLength || bytes.byteLength > 100 * 1024 * 1024)
    return { ...base, status: 'unknown', reason: 'unsupported_asset' };
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'opengen-c2pa-'));
    const anchors: { trust_kind: string; trust_anchors: string }[] = [];
    for (const [kind, path] of [
      ['manifest', options.trustAnchorsPath ?? process.env.C2PA_TRUST_ANCHORS_PATH],
      ['tsa', options.tsaTrustAnchorsPath ?? process.env.C2PA_TSA_TRUST_ANCHORS_PATH],
    ] as const) {
      if (!path) continue;
      if (!isAbsolute(path) || (await stat(path)).size > 1024 * 1024)
        throw new Error('Invalid local trust configuration.');
      const pem = await readFile(path, 'utf8');
      if (!pem.includes('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY'))
        throw new Error('Invalid trust anchors.');
      anchors.push({ trust_kind: kind, trust_anchors: pem });
    }
    const asset = join(directory, `asset.${extension}`),
      settings = join(directory, 'settings.json');
    await writeFile(asset, bytes, { mode: 0o600 });
    await writeFile(
      settings,
      JSON.stringify({
        version: 1,
        core: {
          allowed_network_hosts: [],
          allow_redirects: false,
          decode_identity_assertions: false,
          max_decompressed_manifest_size_in_mb: 16,
        },
        verify: {
          remote_manifest_fetch: false,
          ocsp_fetch: false,
          verify_after_reading: true,
          verify_trust: true,
          verify_timestamp_trust: true,
        },
        trust: { anchors },
      }),
      { mode: 0o600 },
    );
    const result = await (options.run ?? runTool)(toolPath, [asset, '--settings', settings], {
      cwd: directory,
      env: {
        NODE_ENV: 'production',
        PATH: dirname(toolPath),
        HOME: directory,
        TMPDIR: directory,
        C2PATOOL_SETTINGS: settings,
      },
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.killed || result.exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ...base, status: 'unknown', reason: 'verifier_resource_limit' };
    if (result.exitCode === 'ENOENT' || result.exitCode === 'EACCES')
      return { ...base, status: 'unavailable', reason: 'tool_unavailable' };
    if (result.exitCode !== 0) {
      if (
        !result.stdout.trim() &&
        /^Error: (?:No claim found|NoClaimFound|JumbfNotFound)\s*$/m.test(result.stderr)
      )
        return { ...base, status: 'absent', reason: 'no_embedded_manifest' };
      try {
        const parsed = parseC2paReport(
          JSON.parse(result.stdout),
          anchors.some((value) => value.trust_kind === 'manifest'),
        );
        if (parsed.status === 'invalid')
          return {
            ...base,
            ...parsed,
            reportSha256: createHash('sha256').update(result.stdout).digest('hex'),
          };
      } catch {
        /* No verifiable report. */
      }
      return { ...base, status: 'unknown', reason: 'verifier_failed' };
    }
    const report = parseC2paReport(
      JSON.parse(result.stdout),
      anchors.some((value) => value.trust_kind === 'manifest'),
    );
    return {
      ...base,
      ...report,
      reportSha256: createHash('sha256').update(result.stdout).digest('hex'),
    };
  } catch {
    return { ...base, status: 'unknown', reason: 'verification_unavailable' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
