import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export const driftLimits = Object.freeze({
  manifestBytes: 131_072,
  artifactBytes: 262_144,
  totalArtifactBytes: 8_388_608,
  endpoints: 32,
  depth: 24,
  nodes: 20_000,
});

export interface EndpointIdentity {
  providerId: string;
  endpointId: string;
  modelId: string;
  deploymentId: string;
}
export interface SourceEvidence {
  url: string;
  checkedAt: string;
  sha256: string;
}
export interface EndpointObservation {
  identity: EndpointIdentity;
  source: SourceEvidence;
  factsHash: string;
  facts: Obj;
}
export interface DriftSnapshot {
  version: 1;
  evidenceKind: 'synthetic' | 'documented';
  manifestHash: string;
  scope: EndpointIdentity[];
  observations: EndpointObservation[];
}
export interface DriftChange {
  identity: EndpointIdentity;
  kind: 'added' | 'removed' | 'changed';
  category:
    | 'endpoint'
    | 'schema'
    | 'default'
    | 'bound'
    | 'deprecation'
    | 'capability'
    | 'region'
    | 'tariff'
    | 'unit'
    | 'rounding'
    | 'account-scope'
    | 'source';
  path: string;
  before: Json;
  after: Json;
  beforePresent: boolean;
  afterPresent: boolean;
}
export interface DriftReport {
  version: 1;
  disposition: 'review-required' | 'no-change';
  baseline: Pick<DriftSnapshot, 'evidenceKind' | 'manifestHash'>;
  candidate: Pick<DriftSnapshot, 'evidenceKind' | 'manifestHash'>;
  observations: {
    identity: EndpointIdentity;
    before: SourceEvidence | null;
    after: SourceEvidence | null;
    beforeFactsHash: string | null;
    afterFactsHash: string | null;
  }[];
  changes: DriftChange[];
  notices: string[];
}

function fail(message: string): never {
  throw new Error(`Catalog drift: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail(`${label} contains unsupported fields`);
}
function string(value: unknown, label: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(`invalid ${label}`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}
function isoDate(value: unknown, label: string): string {
  const date = string(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail(`${label} must be a valid ISO date`);
  return date;
}
function json(value: unknown): Json {
  let nodes = 0;
  function visit(item: unknown, depth: number): Json {
    if (++nodes > driftLimits.nodes || depth > driftLimits.depth)
      fail('JSON complexity limit exceeded');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 16_384) return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      if (
        entries.some(
          ([key]) => key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key),
        )
      )
        fail('unsafe JSON key');
      return Object.fromEntries(entries.map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    fail('invalid JSON value');
  }
  return visit(value, 0);
}
function identity(value: unknown): EndpointIdentity {
  const v = object(value, 'identity');
  keys(v, ['providerId', 'endpointId', 'modelId', 'deploymentId'], 'identity');
  const result = Object.fromEntries(
    ['providerId', 'endpointId', 'modelId', 'deploymentId'].map((key) => [
      key,
      string(v[key], key),
    ]),
  ) as unknown as EndpointIdentity;
  for (const id of [result.providerId, result.endpointId, result.modelId, result.deploymentId])
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id) ||
      id.split('/').some((part) => part === '..' || !part)
    )
      fail('invalid exact identity');
  return result;
}
export function endpointKey(v: EndpointIdentity): string {
  return JSON.stringify([v.providerId, v.endpointId, v.modelId, v.deploymentId]);
}
function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(v[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) fail('file size/type limit exceeded');
    const data = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await file.read(data, count, data.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) fail('file size limit exceeded');
    return data.subarray(0, count);
  } finally {
    await file.close();
  }
}
function parse(data: Buffer): unknown {
  try {
    return json(JSON.parse(data.toString('utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Catalog drift:')) throw error;
    fail('invalid JSON document');
  }
}
function pointer(document: Json, value: unknown): Json {
  const path = string(value, 'inputSchemaPointer');
  if (!path.startsWith('/') || /~(?![01])/.test(path))
    fail('inputSchemaPointer must be a local JSON pointer');
  let current: Json = document;
  for (const token of path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, token))
      fail('inputSchemaPointer is missing');
    current = (current as Obj)[token]!;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current))
    fail('input schema must be an object');
  return current;
}
function source(value: unknown): SourceEvidence & { path: string } {
  const v = object(value, 'source');
  keys(v, ['url', 'checkedAt', 'sha256', 'path'], 'source');
  const url = string(v.url, 'source URL', 2048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('invalid source URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some((key) => key !== 'endpoint_id')
  )
    fail('source requires credential-free HTTPS documentation URL');
  const checkedAt = isoDate(v.checkedAt, 'checkedAt');
  const hash = string(v.sha256, 'source hash');
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid SHA-256');
  return { url, checkedAt, sha256: hash, path: string(v.path, 'artifact path') };
}
function facts(value: unknown, inputSchema: Json): Obj {
  const v = object(value, 'facts');
  keys(v, ['capabilities', 'retirement', 'region', 'tariff'], 'facts');
  if (v.capabilities !== null) object(v.capabilities, 'capabilities');
  const retirement = object(v.retirement, 'retirement');
  keys(retirement, ['deprecated', 'retirementAt', 'replacementEndpointId'], 'retirement');
  if (retirement.deprecated !== null && typeof retirement.deprecated !== 'boolean')
    fail('deprecated must be boolean or null');
  if (retirement.retirementAt !== null) isoDate(retirement.retirementAt, 'retirementAt');
  nullableString(retirement.replacementEndpointId, 'replacementEndpointId');
  const region = object(v.region, 'region');
  keys(region, ['endpointRegion', 'inferenceScope', 'residency'], 'region');
  for (const key of ['endpointRegion', 'inferenceScope', 'residency'])
    nullableString(region[key], key);
  if (v.tariff !== null) {
    const tariff = object(v.tariff, 'tariff');
    keys(
      tariff,
      ['currency', 'rate', 'unit', 'rounding', 'formulaStatus', 'accountScope', 'accountRef'],
      'tariff',
    );
    for (const key of ['currency', 'rate', 'unit', 'rounding', 'accountRef'])
      nullableString(tariff[key], `tariff ${key}`);
    if (tariff.currency !== null && !/^[A-Z]{3}$/.test(tariff.currency as string))
      fail('invalid tariff currency');
    if (tariff.rate !== null && !/^(0|[1-9]\d*)(\.\d+)?$/.test(tariff.rate as string))
      fail('invalid decimal tariff rate');
    if (
      tariff.accountRef !== null &&
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(tariff.accountRef as string)
    )
      fail('account reference must be opaque');
    if (![null, 'unknown', 'unqualified', 'qualified'].includes(tariff.formulaStatus as null))
      fail('invalid formulaStatus');
    if (
      ![null, 'public-list', 'operator-contract', 'private-byok'].includes(
        tariff.accountScope as null,
      )
    )
      fail('invalid accountScope');
    if (
      (tariff.accountScope === 'public-list' || tariff.accountScope === null) &&
      tariff.accountRef !== null
    )
      fail('public-list or unknown scope cannot have an account reference');
    if (
      ['operator-contract', 'private-byok'].includes(tariff.accountScope as string) &&
      tariff.accountRef === null
    )
      fail('private/account pricing requires an opaque account reference');
  }
  return json({ inputSchema, ...v }) as Obj;
}

/** Imports only local, bounded evidence. No fetch, catalog write or runtime admission. */
export async function importDriftSnapshot(manifestPath: string): Promise<DriftSnapshot> {
  const path = await realpath(manifestPath);
  const data = await boundedRead(path, driftLimits.manifestBytes);
  const manifest = object(parse(data), 'manifest');
  keys(manifest, ['version', 'evidenceKind', 'scope', 'entries'], 'manifest');
  if (
    manifest.version !== 1 ||
    !['synthetic', 'documented'].includes(manifest.evidenceKind as string)
  )
    fail('unsupported manifest version/evidenceKind');
  if (
    !Array.isArray(manifest.scope) ||
    !manifest.scope.length ||
    manifest.scope.length > driftLimits.endpoints
  )
    fail('scope must contain 1..32 explicit endpoints');
  const scope = manifest.scope
    .map(identity)
    .sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
  const allowed = new Set(scope.map(endpointKey));
  if (allowed.size !== scope.length) fail('duplicate endpoint scope');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > driftLimits.endpoints)
    fail('entries limit exceeded');
  const observations: EndpointObservation[] = [];
  const seen = new Set<string>();
  let total = 0;
  const base = dirname(path);
  for (const entry of manifest.entries) {
    const v = object(entry, 'entry');
    keys(v, ['identity', 'source', 'inputSchemaPointer', 'facts'], 'entry');
    const id = identity(v.identity);
    const key = endpointKey(id);
    if (!allowed.has(key) || seen.has(key)) fail('unscoped or duplicate endpoint observation');
    seen.add(key);
    const { path: artifactPath, ...evidence } = source(v.source);
    const sourceEndpointIds = new URL(evidence.url).searchParams.getAll('endpoint_id');
    if (
      sourceEndpointIds.length &&
      (sourceEndpointIds.length !== 1 || sourceEndpointIds[0] !== id.endpointId)
    )
      fail('source endpoint_id must match exact endpoint once');
    if (isAbsolute(artifactPath)) fail('artifact must be relative to manifest');
    const resolved = await realpath(resolve(base, artifactPath));
    const rel = relative(base, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      fail('artifact escapes evidence directory');
    const raw = await boundedRead(resolved, driftLimits.artifactBytes);
    total += raw.length;
    if (total > driftLimits.totalArtifactBytes) fail('total artifact limit exceeded');
    if (sha256(raw) !== evidence.sha256) fail('artifact hash mismatch');
    const document = parse(raw) as Json;
    const projected = facts(
      v.facts,
      v.inputSchemaPointer === null ? null : pointer(document, v.inputSchemaPointer),
    );
    observations.push({
      identity: id,
      source: evidence,
      factsHash: sha256(canonical(projected)),
      facts: projected,
    });
  }
  return {
    version: 1,
    evidenceKind: manifest.evidenceKind as DriftSnapshot['evidenceKind'],
    manifestHash: sha256(data),
    scope,
    observations: observations.sort((a, b) =>
      endpointKey(a.identity).localeCompare(endpointKey(b.identity)),
    ),
  };
}

function category(path: string): DriftChange['category'] {
  const parts = path.split('/');
  if (parts[1] === 'source') return 'source';
  if (parts[1] === 'retirement' || parts.at(-1) === 'deprecated') return 'deprecation';
  if (parts[1] === 'region') return 'region';
  if (parts[1] === 'capabilities') return 'capability';
  if (parts[1] === 'tariff') {
    if (parts.at(-1) === 'unit') return 'unit';
    if (parts.at(-1) === 'rounding') return 'rounding';
    if (['accountScope', 'accountRef'].includes(parts.at(-1)!)) return 'account-scope';
    return 'tariff';
  }
  if (parts.at(-1) === 'default') return 'default';
  if (
    [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'multipleOf',
    ].includes(parts.at(-1)!)
  )
    return 'bound';
  return 'schema';
}

export function diffDriftSnapshots(before: DriftSnapshot, after: DriftSnapshot): DriftReport {
  if (before.evidenceKind !== after.evidenceKind)
    fail('cannot compare different evidence kinds; fixture provenance cannot be promoted');
  if (JSON.stringify(before.scope) !== JSON.stringify(after.scope))
    fail('baseline and candidate must use the same exact endpoint scope');
  const changes: DriftChange[] = [];
  function diff(id: EndpointIdentity, path: string, a: Json | undefined, b: Json | undefined) {
    if (a !== undefined && b !== undefined && canonical(a) === canonical(b)) return;
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        diff(id, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, a[key], b[key]);
      return;
    }
    changes.push({
      identity: id,
      kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed',
      category: category(path),
      path,
      before: a ?? null,
      after: b ?? null,
      beforePresent: a !== undefined,
      afterPresent: b !== undefined,
    });
  }
  const old = new Map(before.observations.map((v) => [endpointKey(v.identity), v]));
  const next = new Map(after.observations.map((v) => [endpointKey(v.identity), v]));
  const observations = before.scope.map((id) => {
    const a = old.get(endpointKey(id));
    const b = next.get(endpointKey(id));
    if (!a || !b) {
      if (a || b)
        changes.push({
          identity: id,
          kind: a ? 'removed' : 'added',
          category: 'endpoint',
          path: '',
          before: a ? a.facts : null,
          after: b ? b.facts : null,
          beforePresent: !!a,
          afterPresent: !!b,
        });
    } else {
      diff(id, '', a.facts, b.facts);
      diff(id, '/source', a.source as unknown as Obj, b.source as unknown as Obj);
    }
    return {
      identity: id,
      before: a?.source ?? null,
      after: b?.source ?? null,
      beforeFactsHash: a?.factsHash ?? null,
      afterFactsHash: b?.factsHash ?? null,
    };
  });
  return {
    version: 1,
    disposition: changes.length ? 'review-required' : 'no-change',
    baseline: { evidenceKind: before.evidenceKind, manifestHash: before.manifestHash },
    candidate: { evidenceKind: after.evidenceKind, manifestHash: after.manifestHash },
    observations,
    changes,
    notices: [
      'Read-only review evidence: no route, price, canonical identity or accepted job snapshot was changed.',
      'Missing observation is not proof of retirement. Unknown remains null; discovery is not account entitlement or live support.',
      'Endpoint names are not immutable weight digests. Replacement endpoints, variants and regional deployments require explicit independent review.',
      'Account-scoped tariffs remain private; estimates and billing-unit headers are not invoices or guaranteed ceilings.',
    ],
  };
}
