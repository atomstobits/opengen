import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  keyScopes,
  type KeyScope,
  type GenerateInput,
  type RoutingPolicy,
} from '@media-router/contracts';
import { sealVault, openVault } from './vault.js';
import { catalog } from '@media-router/catalog';
import { constrainGovernedInput } from './routing-governance.js';
import { revalidateGovernanceAuthority } from './governance-authority.js';

export { keyScopes, type KeyScope } from '@media-router/contracts';
interface AuthKeyRow {
  id: string | null;
  workspace_id: string;
  scopes: KeyScope[];
  revoked_at: Date | null;
  expires_at: Date | null;
  key_kind: 'api' | 'browser';
  membership_id: string | null;
  member_role: 'admin' | 'member' | null;
  member_removed_at: Date | null;
  member_accepted_at: Date | null;
  issuer: string | null;
  subject: string | null;
  policy: RoutingPolicy | null;
  max_cost_micros: string | null;
  secret_version: number;
  monthly_cap_micros: string | null;
  archived_at: Date | null;
}
export interface Principal {
  workspaceId: string;
  scopes: KeyScope[];
  keyId?: string;
  keySecretVersion?: number;
  monthlyCapMicros?: number;
  authorityExpiresAt?: string;
  grantId?: string;
  clientId?: string;
  oauthResource?: string;
  externalOAuth?: true;
  policy?: RoutingPolicy;
  maxCostMicros?: number;
  bootstrap?: boolean;
  membershipId?: string;
  keyKind?: 'api' | 'browser' | 'oauth';
  identity?: { issuer: string; subject: string };
  role?: 'admin' | 'member';
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const denied = (message: string) =>
  Object.assign(new Error(message), { code: 'policy_denied', statusCode: 403 });
export function constrainInput(principal: Principal, input: GenerateInput): GenerateInput {
  const constrained = constrainGovernedInput(catalog, principal.policy, input);
  return {
    ...constrained,
    ...(principal.maxCostMicros === undefined
      ? {}
      : {
          maxCostMicros: Math.min(input.maxCostMicros ?? Infinity, principal.maxCostMicros),
        }),
  };
}

export class AccountStore {
  constructor(
    readonly pool: Pool,
    private readonly masterKey?: string,
  ) {}

  private keyPrincipal(row: AuthKeyRow): Principal | null {
    if (
      !row.id ||
      row.revoked_at ||
      row.archived_at ||
      (row.expires_at && row.expires_at <= new Date())
    )
      return null;
    if (
      row.membership_id &&
      (!row.member_role ||
        row.member_removed_at ||
        !row.member_accepted_at ||
        !row.issuer ||
        !row.subject)
    )
      return null;
    const scopes: KeyScope[] =
      row.key_kind === 'browser' && row.membership_id
        ? row.member_role === 'admin'
          ? [...keyScopes]
          : ['read', 'generate']
        : row.member_role === 'member'
          ? row.scopes.filter((scope: KeyScope) => scope === 'read' || scope === 'generate')
          : row.scopes;
    return {
      workspaceId: row.workspace_id,
      keyId: row.id,
      keySecretVersion: row.secret_version,
      ...(row.monthly_cap_micros === null
        ? {}
        : { monthlyCapMicros: Number(row.monthly_cap_micros) }),
      scopes,
      keyKind: row.key_kind,
      policy: row.policy ?? undefined,
      ...(row.max_cost_micros === null ? {} : { maxCostMicros: Number(row.max_cost_micros) }),
      ...(row.membership_id
        ? {
            membershipId: row.membership_id,
            identity: { issuer: row.issuer!, subject: row.subject! },
            role: row.member_role ?? undefined,
          }
        : {}),
    };
  }

  private async lookupKey(
    value: string,
    kind: 'token' | 'id',
    queryable: Pool | PoolClient = this.pool,
  ): Promise<Principal | null> {
    const { rows } = await queryable.query(
      `SELECT k.id,k.workspace_id,k.scopes,k.revoked_at,k.expires_at,k.key_kind,k.membership_id,p.policy,p.max_cost_micros,p.archived_at,k.secret_version,k.monthly_cap_micros,
      m.role AS member_role,m.removed_at AS member_removed_at,m.accepted_at AS member_accepted_at,m.issuer,m.subject
      FROM mr_api_keys k LEFT JOIN mr_policies p ON p.id=k.policy_id AND p.workspace_id=k.workspace_id
      LEFT JOIN mr_memberships m ON m.id=k.membership_id AND m.workspace_id=k.workspace_id
      WHERE ${kind === 'id' ? 'k.id=$1' : 'k.token_hash=$1'}`,
      [value],
    );
    return rows[0] ? this.keyPrincipal(rows[0]) : null;
  }
  async authenticate(token: string): Promise<Principal | null> {
    return /^og_sk_[a-f0-9]{64}$/.test(token) ? this.lookupKey(tokenHash(token), 'token') : null;
  }
  /** Internal authority lookup for delegated tokens; uses the caller's transaction and the same role/policy rules. */
  async principalForKeyId(
    id: string,
    queryable: Pool | PoolClient = this.pool,
  ): Promise<Principal | null> {
    return this.lookupKey(id, 'id', queryable);
  }

  async createKey(
    workspaceId: string,
    input: { name: string; scopes: KeyScope[]; policyId?: string; expiresAt?: string },
    membershipId?: string,
  ) {
    return this.teamTransaction(async (client) => {
      if (membershipId)
        await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      if (input.policyId) {
        const owned = await client.query(
          'SELECT id FROM mr_policies WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL',
          [input.policyId, workspaceId],
        );
        if (!owned.rowCount) throw denied('Policy does not belong to this workspace.');
      }
      if (membershipId) {
        const membership = (
          await client.query(
            'SELECT role FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND removed_at IS NULL AND accepted_at IS NOT NULL',
            [membershipId, workspaceId],
          )
        ).rows[0];
        if (membership?.role !== 'admin')
          throw denied('Only an active workspace administrator can issue keys.');
      }
      const token = `og_sk_${randomBytes(32).toString('hex')}`;
      const { rows } = await client.query(
        `INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes,policy_id,expires_at,membership_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,scopes,policy_id,expires_at,created_at`,
        [
          randomUUID(),
          workspaceId,
          input.name,
          tokenHash(token),
          JSON.stringify(input.scopes),
          input.policyId ?? null,
          input.expiresAt ?? null,
          membershipId ?? null,
        ],
      );
      return { ...rows[0], token };
    });
  }
  async listKeys(workspaceId: string) {
    const { rows } = await this.pool.query(
      'SELECT id,name,scopes,policy_id,expires_at,revoked_at,created_at FROM mr_api_keys WHERE workspace_id=$1 ORDER BY created_at DESC',
      [workspaceId],
    );
    return rows;
  }
  async revokeKey(workspaceId: string, id: string) {
    const result = await this.pool.query(
      'UPDATE mr_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 RETURNING id',
      [id, workspaceId],
    );
    return Boolean(result.rowCount);
  }
  async savePolicy(
    workspaceId: string,
    input: { name: string; policy: RoutingPolicy; maxCostMicros?: number },
  ) {
    const { rows } = await this.pool.query(
      'INSERT INTO mr_policies(id,workspace_id,name,policy,max_cost_micros) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [
        randomUUID(),
        workspaceId,
        input.name,
        JSON.stringify(input.policy),
        input.maxCostMicros ?? null,
      ],
    );
    return rows[0];
  }
  async listPolicies(workspaceId: string) {
    return (
      await this.pool.query(
        'SELECT * FROM mr_policies WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at DESC',
        [workspaceId],
      )
    ).rows;
  }
  async createSession(principal: Principal, bootstrapToken?: string) {
    // Delegated grants cannot become broader stable-key cookies. Keep this ban
    // before cleanup, pool checkout or any other database query.
    if (principal.keyKind === 'oauth')
      throw denied('Delegated OAuth tokens cannot create browser sessions. Use browser sign-in.');
    // Complete global expired-row cleanup before acquiring any workspace lock;
    // never retain session-row locks across workspace acquisition/rotation.
    await this.pool.query('DELETE FROM mr_sessions WHERE expires_at<=now()');
    return this.teamTransaction(async (client) => {
      // Token authentication may have completed before a concurrent rotation,
      // revocation or membership change. Recheck its exact source/version while
      // holding the same workspace-first lock used by those mutations.
      const current = await revalidateGovernanceAuthority(client, principal, null);
      const token = randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO mr_sessions(token_hash,workspace_id,key_id,bootstrap_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '12 hours')`,
        [
          tokenHash(token),
          current.workspaceId,
          current.keyId ?? null,
          current.bootstrap && bootstrapToken ? tokenHash(bootstrapToken) : null,
        ],
      );
      return token;
    });
  }
  async session(token: string, bootstrapToken?: string): Promise<Principal | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const { rows } = await this.pool.query(
      `SELECT s.workspace_id,s.bootstrap_hash,k.id,k.scopes,k.revoked_at,k.expires_at,k.key_kind,k.membership_id,p.policy,p.max_cost_micros,p.archived_at,k.secret_version,k.monthly_cap_micros,
      m.role AS member_role,m.removed_at AS member_removed_at,m.accepted_at AS member_accepted_at,m.issuer,m.subject
      FROM mr_sessions s LEFT JOIN mr_api_keys k ON k.id=s.key_id AND k.workspace_id=s.workspace_id
      LEFT JOIN mr_policies p ON p.id=k.policy_id AND p.workspace_id=k.workspace_id
      LEFT JOIN mr_memberships m ON m.id=k.membership_id AND m.workspace_id=k.workspace_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [tokenHash(token)],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.bootstrap_hash)
      return bootstrapToken && tokenHash(bootstrapToken) === row.bootstrap_hash
        ? { workspaceId: row.workspace_id, scopes: [...keyScopes], bootstrap: true }
        : null;
    return this.keyPrincipal(row);
  }

  async deleteSession(token: string) {
    await this.pool.query('DELETE FROM mr_sessions WHERE token_hash=$1', [tokenHash(token)]);
  }

  /** A verified OIDC identity gets one private, zero-credit workspace; never mints operator money. */
  async identity(
    issuer: string,
    subject: string,
    scopes: KeyScope[] = [...keyScopes],
    createBrowserKey = true,
  ): Promise<Principal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `identity:${issuer}:${subject}`,
      ]);
      let row = (
        await client.query(
          'SELECT workspace_id FROM mr_identities WHERE issuer=$1 AND subject=$2',
          [issuer, subject],
        )
      ).rows[0];
      if (!row) {
        const workspaceId = `user-${randomUUID()}`;
        await client.query(
          "INSERT INTO mr_workspaces(id,name,available_micros) VALUES($1,'Personal workspace',0)",
          [workspaceId],
        );
        row = (
          await client.query(
            'INSERT INTO mr_identities(issuer,subject,workspace_id) VALUES($1,$2,$3) RETURNING workspace_id',
            [issuer, subject, workspaceId],
          )
        ).rows[0];
      }
      const membership = (
        await client.query(
          `INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at)
        VALUES($1,$2,$3,$4,'admin',now()) ON CONFLICT(workspace_id,issuer,subject) DO UPDATE SET issuer=EXCLUDED.issuer RETURNING *`,
          [randomUUID(), row.workspace_id, issuer, subject],
        )
      ).rows[0];
      if (membership.removed_at || !membership.accepted_at)
        throw denied('Personal workspace membership is unavailable.');
      if (!createBrowserKey) {
        await client.query('COMMIT');
        return {
          workspaceId: row.workspace_id,
          scopes,
          membershipId: membership.id,
          identity: { issuer, subject },
          role: membership.role,
        };
      }
      // A session follows normal key revocation and policy checks.
      const token = `og_sk_${randomBytes(32).toString('hex')}`;
      const id = randomUUID();
      await client.query(
        `INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes,expires_at,membership_id,key_kind)
        VALUES($1,$2,'Browser sign-in',$3,$4,now()+interval '12 hours',$5,'browser')`,
        [id, row.workspace_id, tokenHash(token), JSON.stringify(scopes), membership.id],
      );
      await client.query('COMMIT');
      return {
        workspaceId: row.workspace_id,
        keyId: id,
        keySecretVersion: 1,
        scopes,
        membershipId: membership.id,
        keyKind: 'browser',
        identity: { issuer, subject },
        role: membership.role,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async teamTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireTeamAdmin(
    client: PoolClient,
    actor: Principal,
    grantRole?: 'admin' | 'member',
  ) {
    // A request can wait after authentication while its source key is revoked,
    // rotated or restricted. Recheck under the workspace mutation lock.
    const current = await revalidateGovernanceAuthority(client, actor, 'members:write');
    if (
      current.policy ||
      current.maxCostMicros !== undefined ||
      current.monthlyCapMicros !== undefined
    )
      throw denied('Use an unrestricted workspace administration session to manage members.');
    if (
      grantRole &&
      (grantRole === 'admin' ? keyScopes : ['read', 'generate']).some(
        (scope) => !current.scopes.includes(scope as KeyScope),
      )
    )
      throw denied('Cannot grant permissions this key does not hold.');
    if (current.membershipId && current.role !== 'admin')
      throw denied('Workspace administrator access is required.');
  }

  async listWorkspaces(principal: Principal) {
    if (principal.identity && (principal.keyKind === 'browser' || !principal.keyId)) {
      return (
        await this.pool.query(
          `SELECT m.workspace_id AS id,coalesce(w.name,w.id) AS name,m.id AS membership_id,m.role,m.accepted_at,m.created_at
        FROM mr_memberships m JOIN mr_workspaces w ON w.id=m.workspace_id
        WHERE m.issuer=$1 AND m.subject=$2 AND m.removed_at IS NULL ORDER BY m.created_at`,
          [principal.identity.issuer, principal.identity.subject],
        )
      ).rows;
    }
    return (
      await this.pool.query('SELECT id,coalesce(name,id) AS name FROM mr_workspaces WHERE id=$1', [
        principal.workspaceId,
      ])
    ).rows;
  }

  async createTeam(principal: Principal, name: string) {
    if (
      !principal.identity ||
      !['browser', 'oauth'].includes(principal.keyKind ?? '') ||
      !principal.scopes.includes('members:write') ||
      principal.policy ||
      principal.maxCostMicros !== undefined ||
      principal.monthlyCapMicros !== undefined
    )
      throw denied(
        'Use an unrestricted verified sign-in with member administration permission to create a team.',
      );
    return this.teamTransaction(async (client) => {
      const id = `team-${randomUUID()}`;
      await client.query('INSERT INTO mr_workspaces(id,name,available_micros) VALUES($1,$2,0)', [
        id,
        name,
      ]);
      await client.query(
        "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,$3,$4,'admin',now())",
        [randomUUID(), id, principal.identity!.issuer, principal.identity!.subject],
      );
      return { id, name };
    });
  }

  async listMembers(principal: Principal) {
    if (!principal.scopes.includes('members:write'))
      throw denied('Member administration permission is required.');
    return (
      await this.pool.query(
        `SELECT id,issuer,subject,role,accepted_at,removed_at,created_at FROM mr_memberships
      WHERE workspace_id=$1 ORDER BY created_at`,
        [principal.workspaceId],
      )
    ).rows;
  }

  /** Invite an identity verified by this installation, never an unverified email claim. */
  async inviteMember(
    actor: Principal,
    input: { issuer: string; subject: string; role: 'admin' | 'member' },
  ) {
    return this.teamTransaction(async (client) => {
      await this.requireTeamAdmin(client, actor, input.role);
      if (
        !(
          await client.query('SELECT 1 FROM mr_identities WHERE issuer=$1 AND subject=$2', [
            input.issuer,
            input.subject,
          ])
        ).rowCount
      )
        throw Object.assign(
          new Error('The teammate must sign in once and share their verified identity first.'),
          { statusCode: 404, code: 'identity_not_found' },
        );
      const old = (
        await client.query(
          'SELECT id,removed_at FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3',
          [actor.workspaceId, input.issuer, input.subject],
        )
      ).rows[0];
      if (old && !old.removed_at)
        throw Object.assign(
          new Error('This identity already has a membership or pending invitation.'),
          { statusCode: 409, code: 'membership_exists' },
        );
      const id = old?.id ?? randomUUID();
      await client.query(
        `INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(workspace_id,issuer,subject) DO UPDATE SET role=EXCLUDED.role,removed_at=NULL,accepted_at=NULL,created_at=now()`,
        [id, actor.workspaceId, input.issuer, input.subject, input.role],
      );
      return { id, role: input.role, status: 'invited' };
    });
  }

  async acceptInvite(principal: Principal, workspaceId: string) {
    if (
      !principal.identity ||
      (principal.keyKind !== 'browser' &&
        !(principal.keyKind === 'oauth' && principal.scopes.includes('members:write'))) ||
      principal.policy ||
      principal.maxCostMicros !== undefined ||
      principal.monthlyCapMicros !== undefined
    )
      throw denied(
        'Accept invitations through verified account sign-in or explicitly authorized account OAuth. Fixed workspace keys cannot accept invitations.',
      );
    const { rows } = await this.pool.query(
      `UPDATE mr_memberships SET accepted_at=COALESCE(accepted_at,now())
      WHERE workspace_id=$1 AND issuer=$2 AND subject=$3 AND removed_at IS NULL RETURNING id,workspace_id,role,accepted_at`,
      [workspaceId, principal.identity.issuer, principal.identity.subject],
    );
    if (!rows[0])
      throw Object.assign(new Error('Invitation not found.'), {
        statusCode: 404,
        code: 'not_found',
      });
    return rows[0];
  }

  async changeMember(actor: Principal, id: string, role: 'admin' | 'member' | null) {
    return this.teamTransaction(async (client) => {
      await this.requireTeamAdmin(client, actor, role ?? undefined);
      const member = (
        await client.query(
          'SELECT * FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND removed_at IS NULL',
          [id, actor.workspaceId],
        )
      ).rows[0];
      if (!member)
        throw Object.assign(new Error('Membership not found.'), {
          statusCode: 404,
          code: 'not_found',
        });
      if (role === 'member' || role === null) {
        const personal = (
          await client.query(
            'SELECT 1 FROM mr_identities WHERE workspace_id=$1 AND issuer=$2 AND subject=$3',
            [actor.workspaceId, member.issuer, member.subject],
          )
        ).rowCount;
        if (personal) throw denied('The personal workspace owner cannot be removed or demoted.');
        if (member.role === 'admin' && member.accepted_at) {
          const count = Number(
            (
              await client.query(
                "SELECT count(*) AS count FROM mr_memberships WHERE workspace_id=$1 AND role='admin' AND accepted_at IS NOT NULL AND removed_at IS NULL",
                [actor.workspaceId],
              )
            ).rows[0].count,
          );
          if (count <= 1) throw denied('Keep at least one accepted workspace administrator.');
        }
      }
      if (role === null) {
        await client.query('UPDATE mr_memberships SET removed_at=now() WHERE id=$1', [id]);
        // Revocation remains durable if this identity is later invited again.
        await client.query(
          'UPDATE mr_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE membership_id=$1',
          [id],
        );
      } else await client.query('UPDATE mr_memberships SET role=$2 WHERE id=$1', [id, role]);
      return { id, ...(role === null ? { removed: true } : { role }) };
    });
  }

  async switchSession(token: string, actor: Principal, workspaceId: string): Promise<Principal> {
    if (
      !actor.identity ||
      actor.keyKind !== 'browser' ||
      !actor.keyId ||
      actor.policy ||
      actor.maxCostMicros !== undefined ||
      actor.monthlyCapMicros !== undefined
    )
      throw denied(
        'Workspace switching requires an unrestricted OIDC browser session. API keys remain bound to one workspace.',
      );
    return this.teamTransaction(async (client) => {
      const session = (
        await client.query(
          'SELECT key_id,expires_at FROM mr_sessions WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',
          [tokenHash(token)],
        )
      ).rows[0];
      if (!session || session.key_id !== actor.keyId)
        throw denied('The browser session does not match this identity.');
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const membership = (
        await client.query(
          'SELECT * FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3 AND removed_at IS NULL AND accepted_at IS NOT NULL',
          [workspaceId, actor.identity!.issuer, actor.identity!.subject],
        )
      ).rows[0];
      if (!membership) throw denied('Accept an invitation before selecting this workspace.');
      const scopes: KeyScope[] =
        membership.role === 'admin' ? [...keyScopes] : ['read', 'generate'];
      const id = randomUUID();
      await client.query(
        `INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes,expires_at,membership_id,key_kind)
        VALUES($1,$2,'Browser sign-in',$3,$4,$5,$6,'browser')`,
        [
          id,
          workspaceId,
          tokenHash(randomBytes(32).toString('hex')),
          JSON.stringify(scopes),
          session.expires_at,
          membership.id,
        ],
      );
      await client.query('UPDATE mr_sessions SET workspace_id=$2,key_id=$3 WHERE token_hash=$1', [
        tokenHash(token),
        workspaceId,
        id,
      ]);
      return {
        workspaceId,
        keyId: id,
        keySecretVersion: 1,
        scopes,
        keyKind: 'browser',
        membershipId: membership.id,
        identity: actor.identity,
        role: membership.role,
      };
    });
  }

  async putConnection(workspaceId: string, deploymentId: string, values: Record<string, string>) {
    const ciphertext = sealVault(values, this.masterKey, `${workspaceId}:${deploymentId}`);
    await this.pool.query(
      `INSERT INTO mr_connections(workspace_id,deployment_id,ciphertext) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,deployment_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,created_at=now()`,
      [workspaceId, deploymentId, ciphertext],
    );
  }
  async getConnection(
    workspaceId: string,
    deploymentId: string,
  ): Promise<Record<string, string> | null> {
    const { rows } = await this.pool.query(
      'SELECT ciphertext FROM mr_connections WHERE workspace_id=$1 AND deployment_id=$2',
      [workspaceId, deploymentId],
    );
    if (!rows[0]) return null;
    return openVault<Record<string, string>>(
      rows[0].ciphertext,
      this.masterKey,
      `${workspaceId}:${deploymentId}`,
    );
  }
  async listConnections(workspaceId: string) {
    return (
      await this.pool.query(
        'SELECT deployment_id,created_at FROM mr_connections WHERE workspace_id=$1 ORDER BY deployment_id',
        [workspaceId],
      )
    ).rows;
  }
  async deleteConnection(workspaceId: string, deploymentId: string) {
    return Boolean(
      (
        await this.pool.query(
          'DELETE FROM mr_connections WHERE workspace_id=$1 AND deployment_id=$2',
          [workspaceId, deploymentId],
        )
      ).rowCount,
    );
  }
}
