'use client';

import { useEffect, useState } from 'react';
import type { Catalog, GenerateInput, Job, OutputAsset } from '@media-router/contracts';
import { regionNames, OutputCredentials } from './ui';
import { OutputReuse } from './playground-reuse';
import styles from './private-playground.module.css';

const money = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 2 })}`;

function usableLink(output: OutputAsset) {
  try {
    const url = new URL(output.url);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !!output.expiresAt &&
      Date.parse(output.expiresAt) > Date.now()
    );
  } catch {
    return false;
  }
}

function OutputPreview({ output }: { output: OutputAsset }) {
  const [, setExpired] = useState(false);
  useEffect(() => {
    const remaining = Date.parse(output.expiresAt ?? '') - Date.now();
    if (!(remaining > 0 && remaining < 2 ** 31)) return;
    const timeout = setTimeout(() => setExpired((expired) => !expired), remaining);
    return () => clearTimeout(timeout);
  }, [output.expiresAt]);
  if (!usableLink(output))
    return <p>Private preview link unavailable. Refresh the existing job for current access.</p>;

  return (
    <>
      {output.mediaType.startsWith('image/') ? (
        <img src={output.url} alt="Generated output" referrerPolicy="no-referrer" />
      ) : output.mediaType.startsWith('video/') ? (
        <video
          src={output.url}
          controls
          playsInline
          preload="metadata"
          aria-label="Generated video"
        />
      ) : output.mediaType.startsWith('audio/') ? (
        <audio src={output.url} controls preload="metadata" aria-label="Generated audio" />
      ) : null}
      <a href={output.url} target="_blank" rel="noreferrer">
        Open private output ↗
      </a>
      <p className={styles.scope}>
        Private link expires {new Date(output.expiresAt!).toLocaleString()}.
      </p>
    </>
  );
}

export function PlaygroundResult({
  job,
  draft,
  catalog,
  resultKey,
  expectedHeaders,
  view,
  onView,
  allowModelTransfer,
  onReuse,
  onRefresh,
  onCopySettings,
  onNewAttempt,
  onCancel,
  error,
}: {
  job: Job;
  draft: GenerateInput;
  catalog: Catalog;
  resultKey?: string;
  expectedHeaders: Record<string, string>;
  view: 'preview' | 'json';
  onView: (view: 'preview' | 'json') => void;
  allowModelTransfer: boolean;
  onReuse: (
    request: GenerateInput,
    outputIndex: number,
    lineage: string,
    asset: { assetKey: string; expiresAt: string | null },
  ) => void;
  onRefresh: () => void;
  onCopySettings?: () => void;
  onNewAttempt?: () => void;
  onCancel?: () => void;
  error: string;
}) {
  const deployment = catalog.deployments.find(({ id }) => id === job.deploymentId);
  const exactModel = catalog.models.find(({ id }) => id === job.input.modelId);
  return (
    <>
      <div className={`job-status ${job.status}`} role="status">
        <span className="status-dot" />
        {job.status.replaceAll('-', ' ')} · Delivery {job.deliveryStatus ?? 'unverified'}
      </div>
      <p className={styles.scope}>
        {exactModel?.name ?? job.input.modelId} · {job.input.operation}
      </p>
      <code className="job-id">{job.id}</code>
      <dl>
        <div>
          <dt>Provider route</dt>
          <dd>
            {deployment?.name ?? job.deploymentId}
            {deployment
              ? ` · ${regionNames[deployment.endpointRegion] ?? deployment.endpointRegion}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Credit hold</dt>
          <dd>{job.input.billing === 'byok' ? 'Provider account' : money(job.reservedMicros)}</dd>
        </div>
        <div>
          <dt>Actual settlement</dt>
          <dd>
            {job.input.billing === 'byok'
              ? 'Billed by provider'
              : job.settledMicros === null
                ? 'Pending'
                : money(job.settledMicros)}
          </dd>
        </div>
      </dl>
      {job.error && <p className="error-notice">{job.structuredError?.message ?? job.error}</p>}
      <div className={styles.outputActions} role="group" aria-label="Result view">
        <button type="button" aria-pressed={view === 'preview'} onClick={() => onView('preview')}>
          Preview
        </button>
        <button type="button" aria-pressed={view === 'json'} onClick={() => onView('json')}>
          Response JSON
        </button>
      </div>
      {view === 'json' ? (
        <>
          <p className={styles.scope}>
            Private workspace response. Media links are hidden in this view.
          </p>
          <pre className={styles.responseJson} tabIndex={0} aria-label="Private response JSON">
            {JSON.stringify(
              job,
              (key, value) =>
                key === 'url' || key === 'storageKey' || key === 'upstreamId' ? undefined : value,
              2,
            )}
          </pre>
        </>
      ) : (
        <>
          {job.outputs.length === 0 && (
            <p className="detail-note">No private preview is available for this job.</p>
          )}
          {job.outputs.map((output, index) => {
            const slot =
              output.outputIndex ?? (job.deliveryStatus === 'available' ? index : undefined);
            return (
              <section
                className="job-output"
                aria-label={`Output ${(slot ?? index) + 1}`}
                key={slot ?? index}
              >
                <OutputPreview output={output} />
                <OutputCredentials asset={output} />
                {resultKey && slot !== undefined && (
                  <OutputReuse
                    sourceJobId={job.id}
                    outputIndex={slot}
                    output={output}
                    draft={draft}
                    catalog={catalog}
                    recoveryNamespace={resultKey}
                    expectedHeaders={expectedHeaders}
                    allowModelTransfer={allowModelTransfer}
                    onApply={(next, lineage, asset) => onReuse(next, slot, lineage, asset)}
                  />
                )}
              </section>
            );
          })}
        </>
      )}
      <div className={styles.outputActions}>
        <button type="button" onClick={onRefresh}>
          Refresh existing job
        </button>
        {onCopySettings && (
          <button type="button" onClick={onCopySettings}>
            Copy settings to form
          </button>
        )}
        {onNewAttempt && (
          <button type="button" onClick={onNewAttempt}>
            Prepare a new attempt
          </button>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel queued generation
          </button>
        )}
      </div>
      <p className={styles.scope}>
        Refresh reads this job and its delivery. Copy prepares a draft. A new attempt needs a fresh
        quote and your spend approval.
      </p>
      {job.status === 'submission-unknown' && (
        <p className="detail-note">
          Provider acceptance is unresolved. Keep this job ID for reconciliation.
        </p>
      )}
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
