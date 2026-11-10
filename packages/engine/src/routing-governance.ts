import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Catalog,
  DeploymentScope,
  GenerateInput,
  RoutingPolicy,
} from '@media-router/contracts';
import type { Principal } from './accounts.js';

/** Broker controls only. These fields must never become provider model arguments. */
export interface GovernedRoutingPolicy extends RoutingPolicy {
  modelIds?: string[];
  /** An exact-model override of providerIds; every other restriction still applies. */
  modelProviderExceptions?: { modelId: string; providerIds: string[] }[];
  authorOnly?: boolean;
  processingScopes?: DeploymentScope[];
}

const listFields = [
  'modelIds',
  'providerIds',
  'deploymentIds',
  'endpointRegions',
  'processingRegions',
] as const;
const denied = (message: string) =>
  Object.assign(new Error(message), { code: 'policy_denied', statusCode: 403 });
const invalid = (message: string) =>
  Object.assign(new Error(message), { code: 'invalid_policy', statusCode: 400 });
const unique = (values: string[]) => [...new Set(values)].sort();
const sameList = (a: string[] | undefined, b: string[] | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && unique(a).every((value, index) => value === unique(b)[index]);
const intersection = (lists: (string[] | undefined)[]): string[] | undefined => {
  const defined = lists.filter((list): list is string[] => list !== undefined);
  return defined.length
    ? unique(defined[0]!).filter((value) => defined.every((list) => list.includes(value)))
    : undefined;
};
const providersFor = (policy: GovernedRoutingPolicy, modelId: string) =>
  policy.modelProviderExceptions?.find((item) => item.modelId === modelId)?.providerIds ??
  policy.providerIds;

/** Strict bounded input validation, also used for stored profile edits. Empty lists deny all. */
export function validateRoutingPolicy(value: unknown, catalog?: Catalog): GovernedRoutingPolicy {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid('A routing policy must be an object.');
  const input = value as Record<string, unknown>;
  const fields = new Set([
    ...listFields,
    'modelProviderExceptions',
    'processingScopes',
    'authorOnly',
    'fidelity',
    'preference',
    'fallback',
  ]);
  for (const key of Object.keys(input))
    if (!fields.has(key)) throw invalid(`Unknown routing policy field: ${key}.`);
  const strings = (item: unknown, field: string) => {
    if (
      !Array.isArray(item) ||
      item.length > 128 ||
      item.some(
        (entry) =>
          typeof entry !== 'string' ||
          !entry.length ||
          entry.length > 200 ||
          entry.trim() !== entry,
      )
    )
      throw invalid(`${field} must be an array of at most 128 exact IDs.`);
    return unique(item as string[]);
  };
  const policy: GovernedRoutingPolicy = {};
  for (const field of listFields)
    if (input[field] !== undefined) policy[field] = strings(input[field], field);
  if (input.processingScopes !== undefined) {
    const scopes = strings(input.processingScopes, 'processingScopes');
    if (
      scopes.some(
        (scope) =>
          !['regional', 'mainland-china', 'international', 'global', 'undisclosed'].includes(scope),
      )
    )
      throw invalid('Unknown processing scope.');
    policy.processingScopes = scopes as DeploymentScope[];
  }
  for (const field of ['authorOnly', 'fallback'] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'boolean') throw invalid(`${field} must be a boolean.`);
    policy[field] = input[field];
  }
  if (input.fidelity !== undefined) {
    if (input.fidelity !== 'any' && input.fidelity !== 'native')
      throw invalid('Unknown fidelity policy.');
    policy.fidelity = input.fidelity;
  }
  if (input.preference !== undefined) {
    if (
      input.preference !== 'cost' &&
      input.preference !== 'speed' &&
      input.preference !== 'reliability'
    )
      throw invalid('Unknown routing preference.');
    policy.preference = input.preference as GovernedRoutingPolicy['preference'];
  }
  if (input.modelProviderExceptions !== undefined) {
    if (!Array.isArray(input.modelProviderExceptions) || input.modelProviderExceptions.length > 128)
      throw invalid('Too many model provider exceptions.');
    const seen = new Set<string>();
    policy.modelProviderExceptions = input.modelProviderExceptions
      .map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw invalid('Invalid model provider exception.');
        const entry = item as Record<string, unknown>;
        if (
          Object.keys(entry).some((field) => !['modelId', 'providerIds'].includes(field)) ||
          typeof entry.modelId !== 'string' ||
          !entry.modelId.length ||
          entry.modelId.length > 200 ||
          entry.modelId.trim() !== entry.modelId ||
          seen.has(entry.modelId)
        )
          throw invalid('Model provider exceptions require unique exact model IDs.');
        seen.add(entry.modelId);
        return { modelId: entry.modelId, providerIds: strings(entry.providerIds, 'providerIds') };
      })
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
  }
  if (catalog) {
    const check = (values: string[] | undefined, known: string[], label: string) => {
      if (values?.some((id) => !known.includes(id)))
        throw invalid(`Unknown ${label} ID in routing policy.`);
    };
    check(
      policy.modelIds,
      catalog.models.map((item) => item.id),
      'exact model',
    );
    check(
      policy.providerIds,
      catalog.providers.map((item) => item.id),
      'provider',
    );
    check(
      policy.deploymentIds,
      catalog.deployments.map((item) => item.id),
      'deployment',
    );
    for (const exception of policy.modelProviderExceptions ?? []) {
      check(
        [exception.modelId],
        catalog.models.map((item) => item.id),
        'exact model',
      );
      check(
        exception.providerIds,
        catalog.providers.map((item) => item.id),
        'provider',
      );
    }
  }
  return policy;
}

/** Current authority AND consent/admission snapshot. Changes can never widen an existing grant. */
export function intersectRoutingPolicies(
  ...layers: (GovernedRoutingPolicy | undefined)[]
): GovernedRoutingPolicy | undefined {
  const policies = layers.filter((policy): policy is GovernedRoutingPolicy => policy !== undefined);
  if (!policies.length) return undefined;
  const result: GovernedRoutingPolicy = {};
  for (const field of listFields) {
    const values = intersection(policies.map((policy) => policy[field]));
    if (values !== undefined) result[field] = values;
  }
  const scopes = intersection(policies.map((policy) => policy.processingScopes));
  if (scopes !== undefined) result.processingScopes = scopes as DeploymentScope[];
  const models = unique(
    policies.flatMap((policy) => policy.modelProviderExceptions?.map((item) => item.modelId) ?? []),
  );
  const exceptions = models.flatMap((modelId) => {
    const providerIds = intersection(policies.map((policy) => providersFor(policy, modelId)));
    return providerIds !== undefined && !sameList(providerIds, result.providerIds)
      ? [{ modelId, providerIds }]
      : [];
  });
  if (exceptions.length) result.modelProviderExceptions = exceptions;
  if (policies.some((policy) => policy.authorOnly === true)) result.authorOnly = true;
  else if (policies.some((policy) => policy.authorOnly === false)) result.authorOnly = false;
  if (policies.some((policy) => policy.fidelity === 'native')) result.fidelity = 'native';
  else if (policies.some((policy) => policy.fidelity === 'any')) result.fidelity = 'any';
  if (policies.some((policy) => policy.fallback === false)) result.fallback = false;
  else if (policies.some((policy) => policy.fallback === true)) result.fallback = true;
  result.preference = [...policies]
    .reverse()
    .find((policy) => policy.preference !== undefined)?.preference;
  if (result.preference === undefined) delete result.preference;
  return result;
}

/** A caller may omit controls or narrow them; explicit widening is rejected. */
export function constrainRoutingPolicy(
  enforced: GovernedRoutingPolicy | undefined,
  requested: GovernedRoutingPolicy | undefined,
): GovernedRoutingPolicy {
  if (!enforced) return intersectRoutingPolicies(requested) ?? {};
  if (!requested) return intersectRoutingPolicies(enforced)!;
  if (
    enforced.processingScopes &&
    requested.processingScopes?.some((scope) => !enforced.processingScopes!.includes(scope))
  )
    throw denied('Request expands the processingScopes policy.');
  for (const field of listFields.filter((field) => field !== 'providerIds')) {
    if (enforced[field] && requested[field]?.some((value) => !enforced[field]!.includes(value)))
      throw denied(`Request expands the key's ${field} policy.`);
  }
  const models = unique([
    ...(enforced.modelProviderExceptions?.map((item) => item.modelId) ?? []),
    ...(requested.modelProviderExceptions?.map((item) => item.modelId) ?? []),
  ]);
  // Check the default and each exact-model exception, rather than just the global list.
  for (const modelId of [null, ...models]) {
    const allowed = modelId === null ? enforced.providerIds : providersFor(enforced, modelId);
    const asked = modelId === null ? requested.providerIds : providersFor(requested, modelId);
    if (allowed && asked?.some((id) => !allowed.includes(id)))
      throw denied("Request expands the key's providerIds policy.");
  }
  if (enforced.authorOnly && requested.authorOnly === false)
    throw denied('Request expands the author-only policy.');
  if (enforced.fidelity === 'native' && requested.fidelity === 'any')
    throw denied('Request expands the native fidelity policy.');
  if (enforced.fallback === false && requested.fallback === true)
    throw denied('Request enables fallback forbidden by the key policy.');
  return intersectRoutingPolicies(enforced, requested)!;
}

/** Convert extended controls to ordinary quote filters for one exact model. Every fallback uses this result. */
export function materializeRoutingPolicy(
  catalog: Catalog,
  policy: GovernedRoutingPolicy,
  modelId: string,
): RoutingPolicy {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model || (policy.modelIds && !policy.modelIds.includes(modelId)))
    throw denied('The exact model is not allowed by this routing policy.');
  const {
    modelIds: _models,
    modelProviderExceptions: _exceptions,
    authorOnly,
    ...effective
  } = policy;
  if (policy.processingScopes) {
    effective.deploymentIds = intersection([
      effective.deploymentIds,
      catalog.deployments
        .filter((deployment) => policy.processingScopes!.includes(deployment.scope))
        .map((deployment) => deployment.id),
    ])!;
  }
  const providerIds = providersFor(policy, modelId);
  if (providerIds !== undefined) effective.providerIds = [...providerIds];
  if (authorOnly)
    effective.providerIds = intersection([effective.providerIds, model.authorProviderIds ?? []])!;
  return effective;
}

/** Defense at the reservation boundary: check the selected route and every saved fallback. */
export function assertGovernedRoutes(
  catalog: Catalog,
  policy: GovernedRoutingPolicy,
  modelId: string,
  routeIds: string[],
): void {
  const effective = materializeRoutingPolicy(catalog, policy, modelId) as GovernedRoutingPolicy;
  if (!routeIds.length) throw denied('A selected route is required.');
  for (const id of routeIds) {
    const route = catalog.routes.find((item) => item.id === id);
    const deployment = route && catalog.deployments.find((item) => item.id === route.deploymentId);
    if (
      !route ||
      !deployment ||
      route.modelId !== modelId ||
      route.status === 'retired' ||
      (effective.providerIds && !effective.providerIds.includes(deployment.providerId)) ||
      (effective.deploymentIds && !effective.deploymentIds.includes(deployment.id)) ||
      (effective.endpointRegions &&
        !effective.endpointRegions.includes(deployment.endpointRegion)) ||
      (effective.processingRegions &&
        (!deployment.processingRegions?.length ||
          !deployment.processingRegions.every((region) =>
            effective.processingRegions!.includes(region),
          ))) ||
      (effective.processingScopes && !effective.processingScopes.includes(deployment.scope)) ||
      (effective.fidelity === 'native' && route.fidelity !== 'native')
    )
      throw denied('A selected or fallback route violates the routing policy.');
  }
  if (effective.fallback === false && routeIds.length > 1)
    throw denied('Fallback is forbidden by the routing policy.');
}

export function constrainGovernedInput(
  catalog: Catalog,
  enforced: GovernedRoutingPolicy | undefined,
  input: GenerateInput,
): GenerateInput {
  const policy = constrainRoutingPolicy(
    enforced,
    input.routing as GovernedRoutingPolicy | undefined,
  );
  return { ...input, routing: materializeRoutingPolicy(catalog, policy, input.modelId) };
}

export interface SavedRoutingPolicy {
  id: string;
  workspaceId: string;
  name: string;
  policy: GovernedRoutingPolicy;
  maxCostMicros: number | null;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface PolicyRow {
  id: string;
  workspace_id: string;
  name: string;
  policy: GovernedRoutingPolicy;
  max_cost_micros: string | null;
  revision: number;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
const iso = (date: Date | string) => new Date(date).toISOString();
const project = (row: PolicyRow): SavedRoutingPolicy => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  policy: row.policy,
  maxCostMicros: row.max_cost_micros === null ? null : Number(row.max_cost_micros),
  revision: row.revision,
  archivedAt: row.archived_at ? iso(row.archived_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/** Caller must already hold the workspace lock. Archived bindings deny admission, never unbind. */
export async function loadBoundRoutingPolicy(
  client: PoolClient,
  workspaceId: string,
  id: string,
): Promise<SavedRoutingPolicy> {
  const row = (
    await client.query<PolicyRow>('SELECT * FROM mr_policies WHERE id=$1 AND workspace_id=$2', [
      id,
      workspaceId,
    ])
  ).rows[0];
  if (!row || row.archived_at) throw denied('The bound routing policy is unavailable.');
  return project(row);
}

/** Revalidation runs on the same connection under workspace lock; safe with a pool of one. */
export class RoutingPolicyStore {
  constructor(
    readonly pool: Pool,
    readonly catalog: Catalog,
    private readonly revalidate: (
      client: PoolClient,
      principal: Principal,
      requiredScope: 'read' | 'policies:write',
    ) => Promise<Principal>,
  ) {}

  private async transaction<T>(
    actor: Principal,
    write: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (
        !(
          await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
            actor.workspaceId,
          ])
        ).rowCount
      )
        throw denied('Workspace unavailable.');
      const current = await this.revalidate(client, actor, write ? 'policies:write' : 'read');
      if (
        current.workspaceId !== actor.workspaceId ||
        !current.scopes.includes(write ? 'policies:write' : 'read')
      )
        throw denied('Routing policy access is required.');
      if (
        write &&
        (current.policy ||
          current.maxCostMicros !== undefined ||
          current.monthlyCapMicros !== undefined ||
          (current.membershipId && current.role !== 'admin'))
      )
        throw denied('Use an unrestricted workspace administrator to manage routing policies.');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(actor: Principal, includeArchived = false): Promise<SavedRoutingPolicy[]> {
    return this.transaction(actor, false, async (client) =>
      (
        await client.query<PolicyRow>(
          'SELECT * FROM mr_policies WHERE workspace_id=$1 AND ($2::boolean OR archived_at IS NULL) ORDER BY created_at DESC,id DESC',
          [actor.workspaceId, includeArchived],
        )
      ).rows.map(project),
    );
  }

  async create(
    actor: Principal,
    input: { name: string; policy: GovernedRoutingPolicy; maxCostMicros?: number | null },
  ): Promise<SavedRoutingPolicy> {
    const name = this.name(input.name);
    const policy = validateRoutingPolicy(input.policy, this.catalog);
    const maxCostMicros = this.maxCost(input.maxCostMicros ?? null);
    return this.transaction(actor, true, async (client) =>
      project(
        (
          await client.query<PolicyRow>(
            'INSERT INTO mr_policies(id,workspace_id,name,policy,max_cost_micros) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [randomUUID(), actor.workspaceId, name, JSON.stringify(policy), maxCostMicros],
          )
        ).rows[0]!,
      ),
    );
  }

  async update(
    actor: Principal,
    id: string,
    expectedRevision: number,
    patch: { name?: string; policy?: GovernedRoutingPolicy; maxCostMicros?: number | null },
  ): Promise<SavedRoutingPolicy> {
    if (
      !Object.keys(patch).length ||
      Object.keys(patch).some((field) => !['name', 'policy', 'maxCostMicros'].includes(field))
    )
      throw invalid('Provide a name, policy or maximum cost update.');
    const name = patch.name === undefined ? undefined : this.name(patch.name);
    const policy =
      patch.policy === undefined ? undefined : validateRoutingPolicy(patch.policy, this.catalog);
    const maxCostMicros =
      patch.maxCostMicros === undefined ? undefined : this.maxCost(patch.maxCostMicros);
    return this.transaction(actor, true, async (client) => {
      const old = await loadBoundRoutingPolicy(client, actor.workspaceId, id);
      this.revision(expectedRevision, old.revision);
      return project(
        (
          await client.query<PolicyRow>(
            'UPDATE mr_policies SET name=$3,policy=$4,max_cost_micros=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *',
            [
              id,
              actor.workspaceId,
              name ?? old.name,
              JSON.stringify(policy ?? old.policy),
              maxCostMicros === undefined ? old.maxCostMicros : maxCostMicros,
            ],
          )
        ).rows[0]!,
      );
    });
  }

  async archive(
    actor: Principal,
    id: string,
    expectedRevision: number,
  ): Promise<SavedRoutingPolicy> {
    return this.transaction(actor, true, async (client) => {
      const old = await loadBoundRoutingPolicy(client, actor.workspaceId, id);
      this.revision(expectedRevision, old.revision);
      return project(
        (
          await client.query<PolicyRow>(
            'UPDATE mr_policies SET archived_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1 AND workspace_id=$2 RETURNING *',
            [id, actor.workspaceId],
          )
        ).rows[0]!,
      );
    });
  }

  private name(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
      throw invalid('Policy name must contain 1–80 characters.');
    return value.trim();
  }
  private maxCost(value: number | null) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw invalid('Maximum cost must be nonnegative integer micro-USD or null.');
    return value;
  }
  private revision(expected: number, current: number) {
    if (!Number.isSafeInteger(expected) || expected < 1)
      throw invalid('A positive expectedRevision is required.');
    if (expected !== current)
      throw Object.assign(new Error('The routing policy changed. Reload before editing.'), {
        code: 'policy_conflict',
        statusCode: 409,
      });
  }
}
