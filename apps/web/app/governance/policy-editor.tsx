'use client';

import { useState } from 'react';
import type { GovernanceContext } from './key-editor';
import {
  governanceName,
  microsToUsdInput,
  policyFromForm,
  usdInputToMicros,
  type GovernanceRoutingPolicy,
} from './form-values';
import styles from './governance.module.css';

export interface GovernancePolicy {
  id: string;
  name: string;
  policy: GovernanceRoutingPolicy;
  maxCostMicros: number | null;
  archivedAt: string | null;
  /** A new revision remounts the form after an authoritative reload. */
  revision: number;
}
export interface PolicyGovernanceEditorProps extends GovernanceContext {
  profile: GovernancePolicy;
  models: readonly { id: string; name: string }[];
  providers: readonly { id: string; name: string }[];
  updatePolicy: (
    workspaceId: string,
    id: string,
    expectedRevision: number,
    changes: { name: string; policy: GovernanceRoutingPolicy; maxCostMicros: number | null },
  ) => Promise<void>;
  archivePolicy: (workspaceId: string, id: string, expectedRevision: number) => Promise<void>;
}

export function PolicyGovernanceEditor(props: PolicyGovernanceEditorProps) {
  return (
    <PolicyEditor
      key={JSON.stringify([
        props.workspaceId,
        props.identityId,
        props.profile.id,
        props.profile.revision,
        props.permissions,
      ])}
      {...props}
    />
  );
}

function PolicyEditor({
  workspaceId,
  permissions,
  profile,
  models,
  providers,
  updatePolicy,
  archivePolicy,
}: PolicyGovernanceEditorProps) {
  const [name, setName] = useState(profile.name);
  const [maxCost, setMaxCost] = useState(microsToUsdInput(profile.maxCostMicros));
  const [authorOnly, setAuthorOnly] = useState(profile.policy.authorOnly ?? false);
  const [modelRestriction, setModelRestriction] = useState<'any' | 'selected' | 'none'>(
    profile.policy.modelIds === undefined
      ? 'any'
      : profile.policy.modelIds.length
        ? 'selected'
        : 'none',
  );
  const [modelIds, setModelIds] = useState(profile.policy.modelIds ?? []);
  const [exceptions, setExceptions] = useState(
    (profile.policy.modelProviderExceptions ?? []).map((item) => ({
      ...item,
      providerIds: [...item.providerIds],
    })),
  );
  const [archived, setArchived] = useState(Boolean(profile.archivedAt));
  const [busy, setBusy] = useState<'save' | 'archive' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canWrite =
    permissions.includes('keys:write') && permissions.includes('policies:write') && !archived;
  const allModels = [
    ...models,
    ...[...new Set([...modelIds, ...exceptions.map((item) => item.modelId)])]
      .filter((id) => !models.some((model) => model.id === id))
      .map((id) => ({ id, name: 'Unavailable catalog model · retained restriction' })),
  ];
  const allProviders = [
    ...providers,
    ...[...new Set(exceptions.flatMap((item) => item.providerIds))]
      .filter((id) => !providers.some((provider) => provider.id === id))
      .map((id) => ({ id, name: `${id} · unavailable` })),
  ];

  async function save() {
    if (!canWrite || busy) return;
    let changes: {
      name: string;
      policy: GovernanceRoutingPolicy;
      maxCostMicros: number | null;
    };
    try {
      changes = {
        name: governanceName(name),
        policy: policyFromForm(profile.policy, {
          authorOnly,
          modelRestriction,
          modelIds,
          modelProviderExceptions: exceptions,
        }),
        maxCostMicros: usdInputToMicros(maxCost),
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the routing profile settings.');
      return;
    }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      await updatePolicy(workspaceId, profile.id, profile.revision, changes);
      setNotice('Routing profile saved. Accepted jobs retain their frozen policy and routes.');
    } catch {
      setError('Routing profile could not be saved. Refresh to check its current settings.');
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (!canWrite || busy) return;
    setBusy('archive');
    setError('');
    setNotice('');
    try {
      await archivePolicy(workspaceId, profile.id, profile.revision);
      setArchived(true);
      setNotice(
        'Routing profile archived. Bound keys remain restricted; accepted jobs keep their frozen policy.',
      );
    } catch {
      setError('Archiving could not be confirmed. Refresh the profile to check its status.');
    } finally {
      setBusy(null);
    }
  }

  const constraints = profile.policy;
  const list = (items: string[] | undefined) =>
    items === undefined ? 'Any' : items.length ? items.join(', ') : 'None allowed';
  return (
    <section className={styles.panel} aria-label={`Manage routing profile ${profile.name}`}>
      <h3>
        {profile.name}
        {archived ? ' · Archived' : ''}
      </h3>
      <p className={styles.identity}>
        Profile {profile.id} · Workspace {workspaceId}
      </p>
      {!canWrite && (
        <p className={styles.note}>
          {archived
            ? 'Archived profiles are read only.'
            : 'Read only. Key and routing profile administration permissions are required to make changes.'}
        </p>
      )}
      <p className={styles.note}>
        Requests can narrow this profile. Every selected route and fallback must keep its model,
        provider, deployment, processing and regional restrictions.
      </p>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="recovery-notice" role="status">
          {notice}
        </p>
      )}
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="field-grid">
          <label>
            Profile name
            <input
              required
              maxLength={80}
              value={name}
              disabled={!canWrite || Boolean(busy)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Maximum per generation, USD
            <input
              inputMode="decimal"
              value={maxCost}
              disabled={!canWrite || Boolean(busy)}
              onChange={(event) => setMaxCost(event.target.value)}
              placeholder="No per-generation ceiling"
            />
          </label>
        </div>
        <fieldset disabled={!canWrite || Boolean(busy)}>
          <legend>Exact models</legend>
          <label className={styles.exception}>
            Allowed models
            <select
              value={modelRestriction}
              onChange={(event) =>
                setModelRestriction(event.target.value as typeof modelRestriction)
              }
            >
              <option value="any">Any exact model</option>
              <option value="selected">Only selected models</option>
              <option value="none">Block all models</option>
            </select>
          </label>
          {modelRestriction === 'selected' && (
            <div className={styles.restriction}>
              {allModels.map((model) => (
                <label key={model.id} className={styles.choice}>
                  <input
                    type="checkbox"
                    checked={modelIds.includes(model.id)}
                    onChange={(event) =>
                      setModelIds((current) =>
                        event.target.checked
                          ? [...current, model.id]
                          : current.filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span>
                    {model.name}
                    <small>{model.id}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset disabled={!canWrite || Boolean(busy)}>
          <legend>Model author</legend>
          <label className={styles.choice}>
            <input
              type="checkbox"
              checked={authorOnly}
              onChange={(event) => setAuthorOnly(event.target.checked)}
            />
            <span>Use author-operated providers only</span>
          </label>
          <p className={styles.note}>
            Uses the exact model’s explicit author provider IDs. A reseller name or related model
            does not establish authorship. Provider exceptions do not bypass this rule.
          </p>
        </fieldset>
        <fieldset disabled={!canWrite || Boolean(busy)}>
          <legend>Provider exceptions for an exact model</legend>
          <p className={styles.note}>
            An exception replaces the default provider list for that model only. Other constraints
            still apply. Selecting no providers blocks that model.
          </p>
          {exceptions.map((exception, index) => (
            <div key={index} className={styles.exception}>
              <label>
                Exact model for exception {index + 1}
                <select
                  value={exception.modelId}
                  onChange={(event) =>
                    setExceptions((current) =>
                      current.map((item, at) =>
                        at === index ? { ...item, modelId: event.target.value } : item,
                      ),
                    )
                  }
                >
                  <option value="">Choose an exact model</option>
                  {allModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.id}
                    </option>
                  ))}
                </select>
              </label>
              <div
                className={styles.providers}
                role="group"
                aria-label={`Allowed providers for exception ${index + 1}`}
              >
                {allProviders.map((provider) => (
                  <label key={provider.id} className={styles.choice}>
                    <input
                      type="checkbox"
                      checked={exception.providerIds.includes(provider.id)}
                      onChange={(event) =>
                        setExceptions((current) =>
                          current.map((item, at) =>
                            at === index
                              ? {
                                  ...item,
                                  providerIds: event.target.checked
                                    ? [...item.providerIds, provider.id]
                                    : item.providerIds.filter((id) => id !== provider.id),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                    {provider.name}
                  </label>
                ))}
              </div>
              {!exception.providerIds.length && (
                <p className={styles.note}>
                  No providers selected. This exact model is blocked by this exception.
                </p>
              )}
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setExceptions((current) => current.filter((_item, at) => at !== index))
                }
              >
                Remove exception {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button-outline button-sm"
            disabled={exceptions.length >= allModels.length}
            onClick={() =>
              setExceptions((current) => [...current, { modelId: '', providerIds: [] }])
            }
          >
            Add model exception
          </button>
        </fieldset>
        <details>
          <summary>Existing route constraints · retained on save</summary>
          <dl className={styles.constraints}>
            <dt>Default providers</dt>
            <dd>{list(constraints.providerIds)}</dd>
            <dt>Deployments</dt>
            <dd>{list(constraints.deploymentIds)}</dd>
            <dt>Endpoint regions</dt>
            <dd>{list(constraints.endpointRegions)}</dd>
            <dt>Processing regions</dt>
            <dd>{list(constraints.processingRegions)}</dd>
            <dt>Fidelity</dt>
            <dd>{constraints.fidelity ?? 'Any'}</dd>
            <dt>Preference</dt>
            <dd>{constraints.preference ?? 'Cost'}</dd>
            <dt>Fallback</dt>
            <dd>
              {constraints.fallback === true
                ? 'Enabled within all restrictions'
                : constraints.fallback === false
                  ? 'Disabled'
                  : 'Request may enable within restrictions'}
            </dd>
          </dl>
        </details>
        <p className={styles.note}>
          An endpoint region does not establish processing residency. Empty restricted lists deny
          access.
        </p>
        <button
          className="button button-dark"
          type="submit"
          disabled={!canWrite || Boolean(busy) || !name.trim()}
        >
          {busy === 'save' ? 'Saving…' : 'Save routing profile'}
        </button>
      </form>
      <div className={styles.rotation}>
        <h3>Archive this profile</h3>
        <p className={styles.note}>
          Archiving prevents new bindings. Keys already bound to this profile keep their
          restrictions; archiving never switches them to unrestricted workspace defaults.
        </p>
        <button
          type="button"
          className={`button button-outline ${styles.archive}`}
          disabled={!canWrite || Boolean(busy)}
          onClick={() => void archive()}
        >
          {busy === 'archive'
            ? 'Archiving…'
            : archived
              ? 'Profile archived'
              : 'Archive routing profile'}
        </button>
      </div>
    </section>
  );
}
