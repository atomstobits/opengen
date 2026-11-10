import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RoutingPolicy } from '@media-router/contracts';
import { type AccountStore, type Principal, tokenHash } from './accounts.js';
import { isIP } from 'node:net';
import { intersectRoutingPolicies } from './routing-governance.js';
import { revalidateGovernanceAuthority } from './governance-authority.js';

export const mcpOAuthScopes = ['read', 'generate'] as const;
export type McpOAuthScope = (typeof mcpOAuthScopes)[number];
const opaque = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
const requestPattern = /^og_req_[A-Za-z0-9_-]{43}$/;
const accessPattern = /^og_mcp_a_[A-Za-z0-9_-]{43}$/;
const refreshPattern = /^og_mcp_r_[A-Za-z0-9_-]{43}$/;
export class McpOAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}
const invalid = (message = 'The authorization is invalid, expired or no longer permitted.') =>
  new McpOAuthError('invalid_grant', message);
const denied = () =>
  new McpOAuthError(
    'access_denied',
    'Sign in with an eligible workspace account and select a workspace you can use.',
    403,
  );
export function oauthScopes(value = 'read generate'): McpOAuthScope[] {
  const values = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (!values.length || values.some((scope) => !mcpOAuthScopes.includes(scope as McpOAuthScope)))
    throw new McpOAuthError('invalid_scope', 'Only read and generate scopes are supported.');
  return values as McpOAuthScope[];
}
export function validateOAuthRedirect(value: string): string {
  if (/[\u0000-\u0020\u007f]/.test(value))
    throw new McpOAuthError(
      'invalid_redirect_uri',
      'Redirect URIs cannot contain raw spaces or control characters.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError(
      'invalid_redirect_uri',
      'A registered HTTPS or loopback redirect URI is required.',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // RFC 8252 prefers literals. Exact localhost callbacks with explicit ports support native clients.
  const localhost = host === 'localhost' && /^http:\/\/localhost:[1-9][0-9]{0,4}\//.test(value);
  const loopback =
    (host === '127.0.0.1' || host === '::1' || localhost) && url.protocol === 'http:';
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.has('code') ||
    url.searchParams.has('state') ||
    url.searchParams.has('error') ||
    (!loopback &&
      (url.protocol !== 'https:' ||
        Boolean(isIP(host)) ||
        !host.includes('.') ||
        /\.(local|localhost|internal)$/i.test(host)))
  )
    throw new McpOAuthError(
      'invalid_redirect_uri',
      'Redirects require public HTTPS, literal HTTP loopback or exact http://localhost:<port>/ callbacks, without user information, fragments or OAuth response parameters.',
    );
  // Exact string matching, including port/path/query; no wildcard redirects.
  return value;
}
export function intersectOAuthPolicy(
  snapshot?: RoutingPolicy,
  current?: RoutingPolicy,
): RoutingPolicy | undefined {
  return intersectRoutingPolicies(snapshot, current);
}
interface GrantRow {
  id: string;
  client_id: string;
  workspace_id: string;
  resource: string;
  membership_id: string | null;
  membership_epoch: string | null;
  source_key_id: string | null;
  scopes: McpOAuthScope[];
  policy_snapshot: RoutingPolicy | null;
  max_cost_micros: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}
export interface AuthorizationParameters {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  responseType: 'code';
  scope?: string;
  state?: string;
  resource?: string;
}
export class McpOAuthStore {
  readonly issuer: string;
  readonly resource: string;
  constructor(
    readonly pool: Pool,
    readonly accounts: AccountStore,
    options: { issuer: string },
  ) {
    const url = new URL(options.issuer);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('OpenGen OAuth issuer must be an HTTPS origin or local development origin.');
    this.issuer = url.origin;
    this.resource = `${this.issuer}/mcp`;
  }
  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...mcpOAuthScopes],
    };
  }
  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [...mcpOAuthScopes],
      resource_name: 'OpenGen',
    };
  }
  private resourceMatches(value?: string) {
    if (value !== undefined && value !== this.resource)
      throw new McpOAuthError(
        'invalid_target',
        'The resource must be the canonical OpenGen MCP URL.',
      );
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
  async rateLimit(action: string, identity: string, limit: number) {
    const bucket = tokenHash(`${action}:${identity}`);
    const result = await this.pool.query(
      `INSERT INTO mr_mcp_oauth_limits(bucket,window_start,count) VALUES($1,date_trunc('hour',now()),1)
      ON CONFLICT(bucket) DO UPDATE SET window_start=date_trunc('hour',now()),count=CASE WHEN mr_mcp_oauth_limits.window_start=date_trunc('hour',now()) THEN mr_mcp_oauth_limits.count+1 ELSE 1 END RETURNING count`,
      [bucket],
    );
    if (result.rows[0].count > limit)
      throw new McpOAuthError(
        'slow_down',
        'Too many authorization requests. Try again later.',
        429,
      );
  }
  async registerClient(input: { clientName?: string; redirectUris: string[] }, requester: string) {
    await this.rateLimit('register-global', 'installation', 500);
    await this.rateLimit('register', requester, 30);
    if (input.redirectUris.length < 1 || input.redirectUris.length > 10)
      throw new McpOAuthError(
        'invalid_client_metadata',
        'Register one to ten exact redirect URIs.',
      );
    const redirects = [...new Set(input.redirectUris.map(validateOAuthRedirect))];
    const name = input.clientName ?? 'MCP client';
    if (!name.trim() || name.length > 120 || /[\u0000-\u001f]/.test(name))
      throw new McpOAuthError(
        'invalid_client_metadata',
        'Client name must be 1–120 printable characters.',
      );
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('opengen-mcp-client-registration'))",
      );
      const count = Number(
        (await client.query('SELECT count(*) AS count FROM mr_mcp_oauth_clients')).rows[0].count,
      );
      if (count >= 5000)
        throw new McpOAuthError(
          'temporarily_unavailable',
          'Client registration capacity has been reached.',
          503,
        );
      const clientId = `og_client_${randomUUID()}`;
      await client.query(
        'INSERT INTO mr_mcp_oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3)',
        [clientId, name, JSON.stringify(redirects)],
      );
      return {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: redirects,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read generate',
      };
    });
  }
  async beginAuthorization(input: AuthorizationParameters, requester: string) {
    await this.rateLimit('authorize-global', 'installation', 10000);
    await this.rateLimit('authorize', requester, 120);
    this.resourceMatches(input.resource);
    if (
      input.responseType !== 'code' ||
      input.codeChallengeMethod !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
      (input.state?.length ?? 0) > 4096
    )
      throw new McpOAuthError(
        'invalid_request',
        'Authorization code with an S256 PKCE challenge is required.',
      );
    const row = (
      await this.pool.query('SELECT id,redirect_uris FROM mr_mcp_oauth_clients WHERE id=$1', [
        input.clientId,
      ])
    ).rows[0];
    if (!row || !row.redirect_uris.includes(input.redirectUri))
      throw new McpOAuthError(
        'invalid_request',
        'The client or exact redirect URI is not registered.',
      );
    const scopes = oauthScopes(input.scope);
    const id = opaque('og_req_');
    await this.pool.query(
      'DELETE FROM mr_mcp_oauth_requests WHERE expires_at<now() AND id NOT IN (SELECT request_id FROM mr_mcp_oauth_codes)',
    );
    await this.pool.query(
      `INSERT INTO mr_mcp_oauth_requests(id,client_id,redirect_uri,scopes,state,challenge,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
      [
        id,
        input.clientId,
        input.redirectUri,
        JSON.stringify(scopes),
        input.state ?? null,
        input.codeChallenge,
        this.resource,
      ],
    );
    return {
      requestId: id,
      consentUrl: `${this.issuer}/oauth/consent?request=${encodeURIComponent(id)}`,
    };
  }
  async pendingAuthorization(id: string) {
    if (!requestPattern.test(id)) return false;
    return Boolean(
      (
        await this.pool.query(
          'SELECT id FROM mr_mcp_oauth_requests WHERE id=$1 AND resource=$2 AND expires_at>now() AND completed_at IS NULL',
          [id, this.resource],
        )
      ).rowCount,
    );
  }
  private async request(client: Pool | PoolClient, id: string, lock = false) {
    if (!requestPattern.test(id)) throw invalid();
    const row = (
      await client.query(
        `SELECT r.*,c.name AS client_name FROM mr_mcp_oauth_requests r JOIN mr_mcp_oauth_clients c ON c.id=r.client_id WHERE r.id=$1 AND r.resource=$2 ${lock ? 'FOR UPDATE OF r' : ''}`,
        [id, this.resource],
      )
    ).rows[0];
    if (!row || row.expires_at <= new Date() || row.completed_at) throw invalid();
    return row;
  }
  private async actorWorkspaces(actor: Principal) {
    if (actor.bootstrap)
      throw new McpOAuthError(
        'access_denied',
        'The installation bootstrap key cannot authorize agents. Sign in with an account or connect a workspace-scoped read/generate key.',
        403,
      );
    if (actor.keyKind === 'browser' && (actor.policy || actor.maxCostMicros !== undefined))
      throw denied();
    if (actor.keyKind === 'browser' && actor.identity)
      return (await this.accounts.listWorkspaces(actor)).filter((row) => row.accepted_at);
    if (actor.keyId && actor.keyKind === 'api')
      return [{ id: actor.workspaceId, name: actor.workspaceId }];
    throw denied();
  }
  async consentView(id: string, actor: Principal) {
    const request = await this.request(this.pool, id);
    const workspaces = await this.actorWorkspaces(actor);
    return {
      requestId: id,
      client: {
        id: request.client_id,
        name: request.client_name,
        redirectOrigin: new URL(request.redirect_uri).origin,
      },
      requestedScopes: request.scopes,
      availableScopes: request.scopes.filter((scope: McpOAuthScope) =>
        actor.scopes.includes(scope),
      ),
      workspaces: workspaces.map((row) => ({ id: row.id, name: row.name, role: row.role ?? null })),
      resource: this.resource,
    };
  }
  async approve(
    id: string,
    actor: Principal,
    workspaceId: string,
    selected: McpOAuthScope[],
    approve = true,
  ) {
    const workspaces = await this.actorWorkspaces(actor);
    if (!workspaces.some((row) => row.id === workspaceId)) throw denied();
    return this.transaction(async (client) => {
      const request = await this.request(client, id, true);
      const redirect = new URL(request.redirect_uri);
      if (!approve) {
        await client.query('UPDATE mr_mcp_oauth_requests SET completed_at=now() WHERE id=$1', [id]);
        redirect.searchParams.set('error', 'access_denied');
        if (request.state !== null) redirect.searchParams.set('state', request.state);
        return { redirectTo: redirect.href };
      }
      const scopes = oauthScopes(selected.join(' '));
      if (scopes.some((scope) => !request.scopes.includes(scope)))
        throw new McpOAuthError('invalid_scope', 'Consent may only narrow requested permissions.');
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      let membershipId: string | null = null,
        epoch: string | null = null,
        sourceKeyId: string | null = null;
      let authority = actor;
      if (actor.keyKind === 'browser' && actor.identity) {
        const member = (
          await client.query(
            `SELECT id,extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3 AND accepted_at IS NOT NULL AND removed_at IS NULL`,
            [workspaceId, actor.identity.issuer, actor.identity.subject],
          )
        ).rows[0];
        if (!member) throw denied();
        membershipId = member.id;
        epoch = member.epoch;
        // Both current team roles permit read/generate; no administrative permission is delegated.
        authority = { workspaceId, scopes: ['read', 'generate'] };
      } else {
        if (!actor.keyId || actor.workspaceId !== workspaceId) throw denied();
        const current = await revalidateGovernanceAuthority(client, actor, scopes[0]);
        if (current.workspaceId !== workspaceId) throw denied();
        authority = current;
        sourceKeyId = actor.keyId;
      }
      if (scopes.some((scope) => !authority.scopes.includes(scope)))
        throw new McpOAuthError(
          'invalid_scope',
          'The current account does not hold the selected permissions.',
        );
      const grantId = randomUUID(),
        code = opaque('og_code_');
      await client.query(
        `INSERT INTO mr_mcp_oauth_grants(id,client_id,workspace_id,membership_id,membership_epoch,source_key_id,scopes,policy_snapshot,max_cost_micros,resource,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '30 days')`,
        [
          grantId,
          request.client_id,
          workspaceId,
          membershipId,
          epoch,
          sourceKeyId,
          JSON.stringify(scopes),
          authority.policy ? JSON.stringify(authority.policy) : null,
          authority.maxCostMicros ?? null,
          this.resource,
        ],
      );
      await client.query(
        `INSERT INTO mr_mcp_oauth_codes(token_hash,request_id,grant_id,redirect_uri,challenge,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`,
        [tokenHash(code), id, grantId, request.redirect_uri, request.challenge],
      );
      await client.query('UPDATE mr_mcp_oauth_requests SET completed_at=now() WHERE id=$1', [id]);
      redirect.searchParams.set('code', code);
      if (request.state !== null) redirect.searchParams.set('state', request.state);
      return { redirectTo: redirect.href };
    });
  }
  private async authority(client: Pool | PoolClient, grant: GrantRow): Promise<Principal | null> {
    if (grant.resource !== this.resource || grant.revoked_at || grant.expires_at <= new Date())
      return null;
    let current: Principal | null = grant.source_key_id
      ? await this.accounts.principalForKeyId(grant.source_key_id, client)
      : null;
    if (grant.source_key_id && !current) return null;
    if (grant.membership_id) {
      const member = (
        await client.query(
          `SELECT id,issuer,subject,role,extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NOT NULL AND removed_at IS NULL`,
          [grant.membership_id, grant.workspace_id],
        )
      ).rows[0];
      if (
        !member ||
        !['admin', 'member'].includes(member.role) ||
        member.epoch !== grant.membership_epoch
      )
        return null;
      if (current?.membershipId && current.membershipId !== member.id) return null;
      current = {
        ...current,
        workspaceId: grant.workspace_id,
        scopes: (current?.scopes ?? ['read', 'generate']).filter(
          (scope) => scope === 'read' || scope === 'generate',
        ),
        membershipId: member.id,
        identity: { issuer: member.issuer, subject: member.subject },
        role: member.role,
        keyKind: 'oauth',
      };
    } else
      current = grant.source_key_id
        ? await this.accounts.principalForKeyId(grant.source_key_id, client)
        : null;
    if (!current || current.workspaceId !== grant.workspace_id) return null;
    const scopes = grant.scopes.filter((scope) => current!.scopes.includes(scope));
    if (!scopes.length) return null;
    const policy = intersectRoutingPolicies(grant.policy_snapshot ?? undefined, current.policy);
    const amounts = [
      grant.max_cost_micros === null ? undefined : Number(grant.max_cost_micros),
      current.maxCostMicros,
    ].filter((value): value is number => value !== undefined);
    return {
      ...current,
      workspaceId: grant.workspace_id,
      scopes,
      keyKind: 'oauth',
      grantId: grant.id,
      clientId: grant.client_id,
      oauthResource: grant.resource,
      ...(policy ? { policy } : {}),
      ...(amounts.length ? { maxCostMicros: Math.min(...amounts) } : {}),
    };
  }
  private async mint(client: PoolClient, grant: GrantRow) {
    if (!(await this.authority(client, grant))) throw invalid();
    const accessToken = opaque('og_mcp_a_'),
      refreshToken = opaque('og_mcp_r_');
    await client.query(
      `INSERT INTO mr_mcp_oauth_access(token_hash,grant_id,expires_at) VALUES($1,$2,LEAST(now()+interval '1 hour',$3))`,
      [tokenHash(accessToken), grant.id, grant.expires_at],
    );
    await client.query(
      'INSERT INTO mr_mcp_oauth_refresh(token_hash,grant_id,expires_at) VALUES($1,$2,$3)',
      [tokenHash(refreshToken), grant.id, grant.expires_at],
    );
    const authority = await this.authority(client, grant);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(
        1,
        Math.min(3600, Math.floor((grant.expires_at.getTime() - Date.now()) / 1000)),
      ),
      refresh_token: refreshToken,
      scope: authority!.scopes.join(' '),
      workspace_id: grant.workspace_id,
    };
  }
  async exchangeCode(input: {
    clientId: string;
    code: string;
    redirectUri: string;
    verifier: string;
    resource?: string;
  }) {
    this.resourceMatches(input.resource);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)) throw invalid();
    const outcome = await this.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT c.*,g.client_id FROM mr_mcp_oauth_codes c JOIN mr_mcp_oauth_grants g ON g.id=c.grant_id WHERE c.token_hash=$1 FOR UPDATE OF c`,
          [tokenHash(input.code)],
        )
      ).rows[0];
      if (
        !row ||
        row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri ||
        row.expires_at <= new Date()
      )
        throw invalid();
      const challenge = createHash('sha256').update(input.verifier).digest('base64url'),
        expected = Buffer.from(row.challenge),
        actual = Buffer.from(challenge);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
      const grant = (
        await client.query<GrantRow>('SELECT * FROM mr_mcp_oauth_grants WHERE id=$1 FOR UPDATE', [
          row.grant_id,
        ])
      ).rows[0]!;
      if (grant.resource !== this.resource) throw invalid();
      if (row.consumed_at) {
        await client.query(
          'UPDATE mr_mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',
          [grant.id],
        );
        return null;
      }
      const tokens = await this.mint(client, grant);
      await client.query('UPDATE mr_mcp_oauth_codes SET consumed_at=now() WHERE token_hash=$1', [
        tokenHash(input.code),
      ]);
      return tokens;
    });
    if (!outcome) throw invalid();
    return outcome;
  }
  async refresh(input: {
    clientId: string;
    refreshToken: string;
    scope?: string;
    resource?: string;
  }) {
    this.resourceMatches(input.resource);
    if (!refreshPattern.test(input.refreshToken)) throw invalid();
    // Reuse must commit family revocation even though the protocol returns invalid_grant.
    const result = await this.transaction(async (client) => {
      const refresh = (
        await client.query('SELECT * FROM mr_mcp_oauth_refresh WHERE token_hash=$1 FOR UPDATE', [
          tokenHash(input.refreshToken),
        ])
      ).rows[0];
      if (!refresh) return null;
      const grant = (
        await client.query<GrantRow>('SELECT * FROM mr_mcp_oauth_grants WHERE id=$1 FOR UPDATE', [
          refresh.grant_id,
        ])
      ).rows[0];
      if (!grant || grant.client_id !== input.clientId || grant.resource !== this.resource)
        return null;
      if (refresh.consumed_at) {
        await client.query(
          'UPDATE mr_mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',
          [grant.id],
        );
        return null;
      }
      if (refresh.expires_at <= new Date() || !(await this.authority(client, grant))) return null;
      if (input.scope !== undefined) {
        const requested = oauthScopes(input.scope);
        if (requested.some((scope) => !grant.scopes.includes(scope)))
          throw new McpOAuthError('invalid_scope', 'Refresh cannot expand permissions.');
        grant.scopes = requested;
        await client.query('UPDATE mr_mcp_oauth_grants SET scopes=$2 WHERE id=$1', [
          grant.id,
          JSON.stringify(requested),
        ]);
      }
      const tokens = await this.mint(client, grant);
      await client.query('UPDATE mr_mcp_oauth_refresh SET consumed_at=now() WHERE token_hash=$1', [
        tokenHash(input.refreshToken),
      ]);
      return tokens;
    });
    if (!result) throw invalid();
    return result;
  }
  async authenticate(token: string): Promise<Principal | null> {
    if (!accessPattern.test(token)) return null;
    const grant = (
      await this.pool.query<GrantRow & { access_expires_at: Date }>(
        `SELECT g.*,a.expires_at AS access_expires_at FROM mr_mcp_oauth_access a JOIN mr_mcp_oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1 AND a.expires_at>now()`,
        [tokenHash(token)],
      )
    ).rows[0];
    if (!grant) return null;
    const principal = await this.authority(this.pool, grant);
    return principal
      ? { ...principal, authorityExpiresAt: grant.access_expires_at.toISOString() }
      : null;
  }
  async revoke(clientId: string, token: string) {
    const table = accessPattern.test(token)
      ? 'mr_mcp_oauth_access'
      : refreshPattern.test(token)
        ? 'mr_mcp_oauth_refresh'
        : null;
    if (!table) return;
    await this.pool.query(
      `UPDATE mr_mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE client_id=$1 AND resource=$3 AND id IN (SELECT grant_id FROM ${table} WHERE token_hash=$2)`,
      [clientId, tokenHash(token), this.resource],
    );
  }
  async grants(actor: Principal) {
    const admin = actor.scopes.includes('keys:write');
    return (
      await this.pool.query(
        `SELECT g.id,g.scopes,g.created_at,g.expires_at,g.revoked_at,c.name AS client_name FROM mr_mcp_oauth_grants g JOIN mr_mcp_oauth_clients c ON c.id=g.client_id WHERE g.workspace_id=$1 AND g.resource=$4 AND ($2::boolean OR g.membership_id=$3::uuid OR g.source_key_id=$5::uuid) ORDER BY g.created_at DESC LIMIT 100`,
        [
          actor.workspaceId,
          admin,
          actor.keyKind === 'browser' ? (actor.membershipId ?? null) : null,
          this.resource,
          actor.keyKind === 'api' ? (actor.keyId ?? null) : null,
        ],
      )
    ).rows;
  }
  async revokeGrant(actor: Principal, id: string) {
    const admin = actor.scopes.includes('keys:write');
    const result = await this.pool.query(
      `UPDATE mr_mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND resource=$5 AND ($3::boolean OR membership_id=$4::uuid OR source_key_id=$6::uuid) RETURNING id`,
      [
        id,
        actor.workspaceId,
        admin,
        actor.keyKind === 'browser' ? (actor.membershipId ?? null) : null,
        this.resource,
        actor.keyKind === 'api' ? (actor.keyId ?? null) : null,
      ],
    );
    if (!result.rowCount) throw new McpOAuthError('not_found', 'App authorization not found.', 404);
    return { revoked: true };
  }
}
