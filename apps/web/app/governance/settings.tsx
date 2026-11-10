'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyGovernanceEditor, type GovernanceContext, type GovernanceKey } from './key-editor';
import { PolicyGovernanceEditor, type GovernancePolicy } from './policy-editor';
import styles from './governance.module.css';

export interface GovernanceSettingsProps {
  workspaceId: string | null;
  /** Opaque authenticated recoveryScope from the current server session. */
  recoveryScope: string | null;
  permissions: readonly string[];
}
type Choice = { id: string; name: string };
type KeyRecord = {
  id: string;
  name: string;
  secretVersion: number;
  monthlyCapMicros: number | null;
  revokedAt: string | null;
  coverageStartedAt?: string | null;
  admissionMonth?: string | null;
  grossDebitMicros?: number | null;
  heldMicros?: number | null;
  legacyCoverage?: string | null;
};
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
function keyRecord(row: KeyRecord): GovernanceKey {
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    !amount(row.secretVersion) ||
    row.secretVersion < 1 ||
    (row.monthlyCapMicros !== null && !amount(row.monthlyCapMicros)) ||
    (row.revokedAt !== null && !date(row.revokedAt))
  )
    throw new Error('Key metadata is unavailable.');
  const coverage =
    date(row.coverageStartedAt) && row.legacyCoverage === 'since_cutover'
      ? { since: row.coverageStartedAt, legacyUsageUnknown: true }
      : null;
  const month =
    coverage &&
    typeof row.admissionMonth === 'string' &&
    /^\d{4}-\d{2}-01$/.test(row.admissionMonth) &&
    amount(row.grossDebitMicros) &&
    amount(row.heldMicros)
      ? {
          utcMonth: row.admissionMonth.slice(0, 7),
          settledMicros: row.grossDebitMicros,
          heldMicros: row.heldMicros,
        }
      : null;
  return {
    id: row.id,
    name: row.name,
    secretVersion: row.secretVersion,
    monthlyCapMicros: row.monthlyCapMicros,
    revokedAt: row.revokedAt,
    coverage,
    month,
  };
}

/** No private state is mounted until both selected workspace and server identity are known. */
export function GovernanceSettings(props: GovernanceSettingsProps) {
  if (!props.workspaceId || !props.recoveryScope || !props.permissions.includes('keys:write'))
    return null;
  const context = {
    workspaceId: props.workspaceId,
    identityId: props.recoveryScope,
    permissions: props.permissions,
  };
  return (
    <Settings
      key={JSON.stringify([
        context.workspaceId,
        context.identityId,
        [...context.permissions].sort(),
      ])}
      context={context}
    />
  );
}
function Settings({ context }: { context: GovernanceContext }) {
  const [keys, setKeys] = useState<GovernanceKey[]>([]);
  const [profiles, setProfiles] = useState<GovernancePolicy[]>([]);
  const [models, setModels] = useState<Choice[]>([]);
  const [providers, setProviders] = useState<Choice[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const loadEpoch = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      loadEpoch.current++;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, []);
  const request = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      if (!active.current) throw new DOMException('Workspace changed.', 'AbortError');
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const response = await fetch(path, {
          method,
          signal: controller.signal,
          cache: 'no-store',
          headers: {
            'x-opengen-workspace': context.workspaceId,
            'x-opengen-recovery-scope': context.identityId,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        controller.signal.throwIfAborted();
        if (!active.current) throw new DOMException('Workspace changed.', 'AbortError');
        if (!response.ok)
          throw new Error(
            'Governance request was not confirmed. Refresh the current workspace before another action.',
          );
        return (value.data ?? value) as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [context.workspaceId, context.identityId],
  );
  const canReadProfiles = context.permissions.includes('read');
  const reload = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setError('');
    try {
      const [nextKeys, nextProfiles, catalog] = await Promise.all([
        request<KeyRecord[]>('/api/governance/keys'),
        canReadProfiles
          ? request<GovernancePolicy[]>(
              `/api/governance/policies?includeArchived=${includeArchived}`,
            )
          : Promise.resolve([]),
        request<{ models: Choice[]; providers: Choice[] }>('/api/catalog'),
      ]);
      if (!active.current || epoch !== loadEpoch.current) return;
      if (
        !Array.isArray(nextKeys) ||
        !Array.isArray(nextProfiles) ||
        !Array.isArray(catalog.models) ||
        !Array.isArray(catalog.providers)
      )
        throw new Error('Governance metadata is unavailable.');
      const mappedKeys = nextKeys.map(keyRecord);
      setKeys(mappedKeys);
      setProfiles(nextProfiles);
      setModels(catalog.models.map(({ id, name }) => ({ id, name })));
      setProviders(catalog.providers.map(({ id, name }) => ({ id, name })));
      setSelectedKey((current) =>
        mappedKeys.some((key) => key.id === current) ? current : (mappedKeys[0]?.id ?? ''),
      );
      setSelectedProfile((current) =>
        nextProfiles.some((profile) => profile.id === current)
          ? current
          : (nextProfiles[0]?.id ?? ''),
      );
    } catch {
      if (active.current && epoch === loadEpoch.current) {
        setKeys([]);
        setProfiles([]);
        setModels([]);
        setProviders([]);
        setError(
          'Governance settings could not be loaded. Refresh your current workspace and permissions before continuing.',
        );
      }
    } finally {
      if (active.current && epoch === loadEpoch.current) setLoading(false);
    }
  }, [includeArchived, request, canReadProfiles]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const sameWorkspace = (workspaceId: string) => {
    if (!active.current || workspaceId !== context.workspaceId)
      throw new Error('Workspace changed.');
  };
  const apiKey = keys.find((key) => key.id === selectedKey);
  const profile = profiles.find((item) => item.id === selectedProfile);
  return (
    <section className={styles.panel} aria-label="Spending and routing governance">
      <h2>Spending & routing</h2>
      <p className={styles.note}>
        Set managed spending limits for each key and review routing restrictions. Existing usage,
        holds and accepted generations keep their original identities.
      </p>
      <div className={styles.actions}>
        <button
          className="button button-outline button-sm"
          type="button"
          disabled={loading}
          onClick={() => {
            void reload();
          }}
        >
          {loading ? 'Loading settings…' : 'Refresh settings'}
        </button>
        <label className={styles.choice}>
          <input
            type="checkbox"
            disabled={!canReadProfiles}
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Include archived routing profiles
        </label>
      </div>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !keys.length && (
        <p className={styles.note}>
          Create an API key above to configure its managed monthly limit.
        </p>
      )}
      {!!keys.length && (
        <div className="settings-form">
          <label>
            API key
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name}
                  {key.revokedAt ? ' · revoked' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {apiKey && (
        <KeyGovernanceEditor
          {...context}
          apiKey={apiKey}
          updateKey={async (workspaceId, id, changes) => {
            sameWorkspace(workspaceId);
            await request(`/api/keys/${encodeURIComponent(id)}`, 'PATCH', changes);
            await reload();
          }}
          rotateKey={async (workspaceId, id, expectedSecretVersion) => {
            sameWorkspace(workspaceId);
            const result = await request<{ id: string; token: string; secretVersion: number }>(
              `/api/keys/${encodeURIComponent(id)}/rotate`,
              'POST',
              { expectedSecretVersion },
            );
            if (
              result.id !== id ||
              typeof result.token !== 'string' ||
              !result.token.length ||
              result.token.length > 512 ||
              /[\u0000-\u001f\u007f]/.test(result.token) ||
              !amount(result.secretVersion) ||
              result.secretVersion <= expectedSecretVersion
            )
              throw new Error('Rotation confirmation is unavailable.');
            if (active.current)
              setKeys((current) =>
                current.map((key) =>
                  key.id === id ? { ...key, secretVersion: result.secretVersion } : key,
                ),
              );
            return result;
          }}
        />
      )}
      {apiKey && (
        <p className={styles.note}>
          After a lost rotation response, reload this page to inspect the current key version before
          another rotation. Rotation never retries automatically.
        </p>
      )}
      {!loading && !error && !canReadProfiles && (
        <p className={styles.note}>Read permission is required to inspect routing profiles.</p>
      )}
      {!loading && !error && canReadProfiles && !profiles.length && (
        <p className={styles.note}>No routing profiles match this view.</p>
      )}
      {!!profiles.length && (
        <div className="settings-form">
          <label>
            Routing profile
            <select
              value={selectedProfile}
              onChange={(event) => setSelectedProfile(event.target.value)}
            >
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.archivedAt ? ' · archived' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {profile && (
        <PolicyGovernanceEditor
          {...context}
          profile={profile}
          models={models}
          providers={providers}
          updatePolicy={async (workspaceId, id, expectedRevision, changes) => {
            sameWorkspace(workspaceId);
            await request(`/api/policies/${encodeURIComponent(id)}`, 'PATCH', {
              expectedRevision,
              ...changes,
            });
            await reload();
          }}
          archivePolicy={async (workspaceId, id, expectedRevision) => {
            sameWorkspace(workspaceId);
            await request(`/api/policies/${encodeURIComponent(id)}/archive`, 'POST', {
              expectedRevision,
            });
            await reload();
          }}
        />
      )}
    </section>
  );
}
