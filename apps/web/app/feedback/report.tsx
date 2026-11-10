'use client';
import { useState, type FormEvent } from 'react';
import {
  containsPrivatePaste,
  feedbackInputSchema,
  type FeedbackInput,
} from '@media-router/contracts';
import { GatewayAccess, type BrowserSession } from '../gateway-access';
import { SiteHeader, Footer } from '../ui';
import styles from './report.module.css';

type Draft = {
  kind: FeedbackInput['kind'];
  category: FeedbackInput['category'];
  summary: string;
  modelId: string;
  routeId: string;
  jobId: string;
};
const initial: Draft = {
  kind: 'feedback',
  category: 'setup',
  summary: '',
  modelId: '',
  routeId: '',
  jobId: '',
};
export function FeedbackForm() {
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [draft, setDraft] = useState<Draft>(initial);
  const [preview, setPreview] = useState<{ input: FeedbackInput; workspaceId: string } | null>(
    null,
  );
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{ id: string; workspaceId: string } | null>(null);
  const permitted = authenticated && session?.scopes?.includes('feedback:write');
  function edit<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setPreview(null);
    setReviewed(false);
    setError('');
    setReceipt(null);
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    setError('');
    setReceipt(null);
    setReviewed(false);
    if (!permitted || !session?.workspaceId) {
      setError('Sign in with permission to send feedback.');
      return;
    }
    const parsed = feedbackInputSchema.safeParse({
      kind: draft.kind,
      category: draft.category,
      summary: draft.summary,
      ...(draft.modelId.trim() ? { modelId: draft.modelId.trim() } : {}),
      ...(draft.routeId.trim() ? { routeId: draft.routeId.trim() } : {}),
      ...(draft.jobId.trim() ? { jobId: draft.jobId.trim() } : {}),
      reviewedForPrivacy: true,
    });
    if (!parsed.success) {
      setError('Use a summary of 8–1,000 characters and valid optional model, route and job IDs.');
      return;
    }
    if (containsPrivatePaste(parsed.data.summary)) {
      setError(
        'Remove URLs, email addresses, credentials, private prompts and raw logs before reviewing.',
      );
      return;
    }
    setPreview({ input: parsed.data, workspaceId: session.workspaceId });
  }
  async function send() {
    if (!preview || !reviewed || !permitted || session?.workspaceId !== preview.workspaceId) return;
    const sending = preview;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        sending.input.kind === 'catalog-request' ? '/v1/catalog/requests' : '/v1/feedback',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sending.input),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? 'Your report could not be sent.');
      if (typeof body.id !== 'string')
        throw new Error(
          'The report receipt is unavailable. Check with your operator before sending again.',
        );
      setReceipt({ id: body.id, workspaceId: sending.workspaceId });
      setPreview(null);
      setReviewed(false);
      setDraft(initial);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your report could not be sent.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SiteHeader />
      <main className={`page-width ${styles.page}`}>
        <span className="eyebrow">HELP SHAPE OPENGEN</span>
        <h1>Tell us what got in your way.</h1>
        <p className={styles.intro}>
          Share product feedback or request an exact model or regional route. Reports stay private
          to your workspace and installation operator.
        </p>
        <GatewayAccess onChange={setAuthenticated} onSession={setSession} />
        {authenticated && !permitted && (
          <p className={styles.notice} role="status">
            Your current access can read reports. Sending requires feedback permission from a
            workspace administrator. Agent OAuth access stays limited to its granted scopes.
          </p>
        )}
        <form onSubmit={prepare} className={styles.form}>
          <fieldset disabled={busy || !permitted}>
            <legend>Describe the issue</legend>
            <div className={styles.columns}>
              <label>
                Report type
                <select
                  value={draft.kind}
                  onChange={(event) => edit('kind', event.target.value as Draft['kind'])}
                >
                  <option value="feedback">Product feedback</option>
                  <option value="catalog-request">Model or route request</option>
                </select>
              </label>
              <label>
                Category
                <select
                  value={draft.category}
                  onChange={(event) => edit('category', event.target.value as Draft['category'])}
                >
                  <option value="setup">Setup and instructions</option>
                  <option value="quality">Result quality</option>
                  <option value="pricing">Pricing</option>
                  <option value="missing-model">Missing model</option>
                  <option value="missing-route">Missing regional route</option>
                  <option value="other">Other</option>
                </select>
              </label>
            </div>
            <label>
              Sanitized summary
              <textarea
                required
                minLength={8}
                maxLength={1000}
                rows={5}
                value={draft.summary}
                onChange={(event) => edit('summary', event.target.value)}
                aria-describedby="feedback-privacy"
                placeholder="For example: The upload instructions should explain when the file is ready."
              />
            </label>
            <p id="feedback-privacy">
              Describe the product behavior in your own words. Remove private prompts, names,
              credentials, links, raw media and logs. No attachments or background context are
              collected.
            </p>
            <details>
              <summary>Link existing model, route or job IDs (optional)</summary>
              <p>
                Use exact catalog IDs and jobs owned by this workspace. For a missing model or
                route, describe it in the summary.
              </p>
              <label>
                Model ID
                <input
                  value={draft.modelId}
                  onChange={(event) => edit('modelId', event.target.value)}
                  maxLength={160}
                  placeholder="minimax/h3-max"
                />
              </label>
              <label>
                Regional route ID
                <input
                  value={draft.routeId}
                  onChange={(event) => edit('routeId', event.target.value)}
                  maxLength={240}
                />
              </label>
              <label>
                Owned job ID
                <input
                  value={draft.jobId}
                  onChange={(event) => edit('jobId', event.target.value)}
                  maxLength={36}
                />
              </label>
            </details>
            <button className="button button-outline" type="submit">
              Review report
            </button>
          </fieldset>
        </form>
        {preview && (
          <section className={styles.preview} aria-labelledby="feedback-review">
            <span className="eyebrow">BEFORE YOU SEND</span>
            <h2 id="feedback-review">Review your report</h2>
            <p>
              Sending to workspace <strong>{preview.workspaceId}</strong>. Only the following fields
              will be sent to this installation. Its operator and your workspace can read this
              report.
            </p>
            <pre tabIndex={0} aria-label="Exact report JSON">
              {JSON.stringify(preview.input, null, 2)}
            </pre>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
                disabled={busy}
              />
              I reviewed these exact fields and removed private information.
            </label>
            {session?.workspaceId !== preview.workspaceId && (
              <p role="status">Your workspace changed. Review the report again before sending.</p>
            )}
            <button
              className="button button-dark"
              type="button"
              onClick={send}
              disabled={
                busy || !reviewed || !permitted || session?.workspaceId !== preview.workspaceId
              }
            >
              {busy ? 'Sending…' : 'Send private report'}
            </button>
          </section>
        )}
        {error && (
          <p className="error-notice" role="alert">
            {error}
          </p>
        )}
        {receipt && (
          <section className={styles.notice} role="status">
            <h2>Report received</h2>
            <p>
              Saved privately for workspace <strong>{receipt.workspaceId}</strong>.
            </p>
            <p>
              Report ID: <code>{receipt.id}</code>
            </p>
            <p>Keep this ID for a follow-up with your installation operator.</p>
          </section>
        )}
        <nav className={styles.links} aria-label="Related pages">
          <a href="/models">Explore models ↗</a>
          <a href="/agents">Agent / CLI / API setup ↗</a>
        </nav>
      </main>
      <Footer />
    </>
  );
}
