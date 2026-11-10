'use client';

import { useEffect, useRef, useState } from 'react';
import { governanceName, microsToUsdInput, usdInputToMicros } from './form-values';
import styles from './governance.module.css';

export interface GovernanceKey {
  id: string;
  name: string;
  secretVersion: number;
  monthlyCapMicros: number | null;
  revokedAt: string | null;
  /** Null means that attribution cutover has not established cap coverage. */
  coverage: { since: string; legacyUsageUnknown: boolean } | null;
  month: { utcMonth: string; settledMicros: number; heldMicros: number } | null;
}
export interface GovernanceContext {
  workspaceId: string;
  /** Stable authenticated identity/session context; never an actor supplied to admission. */
  identityId: string;
  permissions: readonly string[];
}
export interface KeyGovernanceEditorProps extends GovernanceContext {
  apiKey: GovernanceKey;
  updateKey: (
    workspaceId: string,
    id: string,
    changes: { name: string; monthlyCapMicros: number | null },
  ) => Promise<void>;
  rotateKey: (
    workspaceId: string,
    id: string,
    expectedSecretVersion: number,
  ) => Promise<{ id: string; token: string; secretVersion: number }>;
}

/** Remount private state whenever workspace, identity, key or authority changes. */
export function KeyGovernanceEditor(props: KeyGovernanceEditorProps) {
  return (
    <KeyEditor
      key={JSON.stringify([
        props.workspaceId,
        props.identityId,
        props.apiKey.id,
        props.apiKey.revokedAt,
        props.permissions,
      ])}
      {...props}
    />
  );
}

function KeyEditor({
  apiKey,
  workspaceId,
  permissions,
  updateKey,
  rotateKey,
}: KeyGovernanceEditorProps) {
  const [name, setName] = useState(apiKey.name);
  const [cap, setCap] = useState(microsToUsdInput(apiKey.monthlyCapMicros));
  const [busy, setBusy] = useState<'save' | 'rotate' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rotation, setRotation] = useState<{ token: string; secretVersion: number } | null>(null);
  const [version, setVersion] = useState(apiKey.secretVersion);
  const latestVersion = useRef(apiKey.secretVersion);
  latestVersion.current = apiKey.secretVersion;
  const [rotationUncertain, setRotationUncertain] = useState(false);
  const canWrite = permissions.includes('keys:write') && !apiKey.revokedAt;
  useEffect(() => {
    setVersion(apiKey.secretVersion);
    setRotation((current) => (current?.secretVersion === apiKey.secretVersion ? current : null));
    setRotationUncertain(false);
  }, [apiKey.secretVersion]);

  async function save() {
    if (!canWrite || busy) return;
    let changes: { name: string; monthlyCapMicros: number | null };
    try {
      changes = {
        name: governanceName(name),
        monthlyCapMicros: usdInputToMicros(cap),
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the key name and monthly cap.');
      return;
    }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      await updateKey(workspaceId, apiKey.id, changes);
      setNotice('Key settings saved. Existing usage and holds still count toward its monthly cap.');
    } catch {
      // Callback failures may contain upstream bodies. Keep private server diagnostics out of UI.
      setError('Key settings could not be saved. Refresh the key to check its current settings.');
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    if (!canWrite || busy || rotation || rotationUncertain) return;
    setBusy('rotate');
    setError('');
    setNotice('');
    try {
      const result = await rotateKey(workspaceId, apiKey.id, version);
      if (
        result.id !== apiKey.id ||
        !result.token ||
        result.secretVersion <= version ||
        result.secretVersion < latestVersion.current
      )
        throw new Error('Unexpected rotation response.');
      setVersion(result.secretVersion);
      setRotation(result);
      setNotice('Secret rotated. Apps authorized from this key must connect again.');
    } catch {
      setRotationUncertain(true);
      setError(
        'The rotation response was not received or was rejected. Refresh key metadata before any further rotation. This action will not retry automatically.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.panel} aria-label={`Manage key ${apiKey.name}`}>
      <h3>{apiKey.name}</h3>
      <p className={styles.identity}>
        Key {apiKey.id} · Workspace {workspaceId}
      </p>
      {!permissions.includes('keys:write') && (
        <p className={styles.note}>
          Read only. A workspace key administrator can change these settings.
        </p>
      )}
      {apiKey.revokedAt && <p className={styles.note}>This key is revoked.</p>}
      {apiKey.month ? (
        <dl className={styles.summary} aria-label={`Managed use for ${apiKey.month.utcMonth} UTC`}>
          <div>
            <dt>{apiKey.month.utcMonth} UTC · gross debit</dt>
            <dd>${microsToUsdInput(apiKey.month.settledMicros)}</dd>
          </div>
          <div>
            <dt>Held exposure</dt>
            <dd>${microsToUsdInput(apiKey.month.heldMicros)}</dd>
          </div>
          <div>
            <dt>Monthly cap</dt>
            <dd>
              {apiKey.monthlyCapMicros === null
                ? 'None'
                : `$${microsToUsdInput(apiKey.monthlyCapMicros)}`}
            </dd>
          </div>
        </dl>
      ) : (
        <p className={styles.note}>Current-month attributed use is unavailable.</p>
      )}
      <p className={styles.note}>
        {apiKey.coverage
          ? `Cap accounting begins ${apiKey.coverage.since}. ${apiKey.coverage.legacyUsageUnknown ? 'Earlier unattributed use is unknown and is not included.' : 'Attributed admissions since that date are included.'}`
          : 'Legacy cap coverage has not been established. Earlier unattributed use is unknown; it is not zero.'}
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
            Key name
            <input
              required
              maxLength={80}
              value={name}
              disabled={!canWrite || Boolean(busy)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Monthly managed cap, USD
            <input
              inputMode="decimal"
              value={cap}
              disabled={!canWrite || Boolean(busy)}
              onChange={(event) => setCap(event.target.value)}
              placeholder="No monthly cap"
              aria-describedby={`cap-note-${apiKey.id}`}
            />
          </label>
        </div>
        <p className={styles.note} id={`cap-note-${apiKey.id}`}>
          Gross customer debit plus held exposure, grouped by the UTC admission month. Credits and
          top-ups do not reset use. Unknown charges stay held. BYOK provider charges are outside
          this cap. Leave blank for no cap; 0 blocks new managed spending.
        </p>
        <button
          className="button button-dark"
          type="submit"
          disabled={!canWrite || Boolean(busy) || !name.trim()}
        >
          {busy === 'save' ? 'Saving…' : 'Save key settings'}
        </button>
      </form>
      <div className={styles.rotation}>
        <h3>Rotate this key’s secret</h3>
        <p className={styles.note}>
          The old secret and sessions using it stop working. OAuth grants sourced from this key are
          revoked. The key ID, monthly usage and accepted generations stay in place.
        </p>
        {rotation && canWrite && (
          <div className="new-key-notice">
            <strong>Save the new secret. It is shown once.</strong>
            <p>Store it in your application’s secret manager before dismissing this message.</p>
            <label>
              New key secret
              <input
                className={styles.secret}
                value={rotation.token}
                readOnly
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className={styles.actions}>
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(rotation.token);
                    setNotice('New secret copied.');
                  } catch {
                    setError('Copy was unavailable. Select the new secret and copy it manually.');
                  }
                }}
              >
                Copy new secret
              </button>
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={() => setRotation(null)}
              >
                I’ve saved this secret
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="button button-outline"
          disabled={!canWrite || Boolean(busy) || Boolean(rotation) || rotationUncertain}
          onClick={() => void rotate()}
        >
          {busy === 'rotate' ? 'Rotating…' : 'Rotate secret and revoke sourced apps'}
        </button>
      </div>
    </section>
  );
}
