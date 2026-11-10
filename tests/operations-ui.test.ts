import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Next preserves JSX in its local tsconfig. Compile the actual client components with the
// production JSX runtime for SSR fixtures, without changing the monorepo/Vitest configuration.
const temporary = await mkdtemp(join(process.cwd(), 'node_modules/.operations-ui-'));
const entry = join(temporary, 'components.cjs');
await build({
  stdin: {
    contents: `export {WorkspaceSettings} from './apps/web/app/dashboard/settings'; export {ConnectedApps} from './apps/web/app/dashboard/connected-apps'; export {WorkspaceAdministration} from './apps/web/app/dashboard/team'; export {PrivateActivity} from './apps/web/app/dashboard/activity'; export {WorkspaceOperations} from './apps/web/app/dashboard/operations'; export {PrivateAttributionTables,activityConfigurationLabel} from './apps/web/app/dashboard/activity-analytics';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});
const {
  PrivateActivity,
  WorkspaceSettings,
  ConnectedApps,
  WorkspaceAdministration,
  WorkspaceOperations,
  PrivateAttributionTables,
  activityConfigurationLabel,
} = createRequire(import.meta.url)(entry) as typeof import('../apps/web/app/dashboard/activity') &
  typeof import('../apps/web/app/dashboard/operations') &
  typeof import('../apps/web/app/dashboard/activity-analytics') &
  typeof import('../apps/web/app/dashboard/settings') &
  typeof import('../apps/web/app/dashboard/connected-apps') &
  typeof import('../apps/web/app/dashboard/team');
afterAll(() => rm(temporary, { recursive: true, force: true }));
import {
  activityIdentity,
  privateWorkspaceHeaders,
  activityQuery,
  moneyMicros,
  sumMicros,
  type ActivityItem,
} from '../apps/web/app/dashboard/activity-view';

const row: ActivityItem = {
  id: 'job-a',
  modelId: 'minimax/h3-max',
  operation: 'text-to-video',
  providerId: 'fal',
  endpointRegion: 'us-east-1',
  routeId: 'route-a',
  deploymentId: 'fal-us',
  status: 'submission-unknown',
  deliveryStatus: 'unverified',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
  reservedMicros: 200_000,
  ledgerReservedMicros: 200_000,
  settledMicros: null,
  heldMicros: 200_000,
  accountingState: 'reconciled',
  attribution: null,
  project: null,
};
describe('private Activity presentation', () => {
  it('preserves exact model/region/key/project IDs and opaque cursor encoding', () => {
    const query = new URLSearchParams(
      activityQuery(
        {
          modelId: 'minimax/h3-max',
          providerId: 'fal',
          endpointRegion: 'us-east-1',
          keyId: 'key-a',
          project: 'private & scoped',
        },
        'opaque+/=cursor',
      ),
    );
    expect(Object.fromEntries(query)).toEqual({
      limit: '25',
      modelId: 'minimax/h3-max',
      providerId: 'fal',
      endpointRegion: 'us-east-1',
      keyId: 'key-a',
      project: 'private & scoped',
      cursor: 'opaque+/=cursor',
    });
    expect(query.has('prompt')).toBe(false);
  });
  it('uses UTC day boundaries even across local daylight-saving transitions', () => {
    const query = new URLSearchParams(activityQuery({ since: '2026-11-01', until: '2026-11-01' }));
    expect(query.get('since')).toBe('2026-11-01T00:00:00.000Z');
    expect(query.get('until')).toBe('2026-11-02T00:00:00.000Z');
  });
  it('shows unknown legacy identity and unknown money rather than fabricated attribution or zero', () => {
    expect(activityIdentity(row)).toBe('Unknown (legacy)');
    expect(moneyMicros(row.settledMicros)).toBe('Unknown');
    expect(moneyMicros(0)).toBe('$0.00');
    expect(moneyMicros(1)).toBe('$0.000001');
    expect(
      activityIdentity({
        ...row,
        attribution: {
          kind: 'oauth',
          membershipId: 'member-a',
          keyId: 'stable-key',
          grantId: 'grant-a',
        },
      }),
    ).toBe('oauth · Member member-a');
  });
  it('does not show rounded page accounting totals beyond the precise integer range', () => {
    expect(sumMicros([200_000, 300_000])).toBe(500_000);
    expect(moneyMicros(sumMicros([Number.MAX_SAFE_INTEGER, 1]))).toBe('Unknown');
    expect(moneyMicros(Number.NaN)).toBe('Unknown');
  });
  it('keeps key attribution unknown and private tag markup escaped, without links or additive totals', () => {
    const html = renderToStaticMarkup(
      createElement(PrivateAttributionTables, {
        byKey: [
          {
            keyId: null,
            sampleCount: 2,
            settledMicros: null,
            heldMicros: null,
            unknownAccountingCount: 2,
          },
          {
            keyId: 'stable-key-a',
            sampleCount: 3,
            settledMicros: 500_000,
            heldMicros: 100_000,
            unknownAccountingCount: 0,
          },
        ],
        byTag: [
          {
            name: '<script>private-tag</script>',
            value: '<img src="https://private.example/output" onerror="alert(1)">',
            sampleCount: 3,
            settledMicros: 500_000,
            heldMicros: 100_000,
            unknownAccountingCount: 0,
          },
        ],
        attributionTruncated: true,
        tagsTruncated: true,
      }),
    );
    expect(html).toContain('Unknown (legacy)');
    expect(html).toContain('stable-key-a');
    expect(html).toContain('$0.50');
    expect(html).toContain('$0.10');
    expect(html).toContain('&lt;script&gt;private-tag&lt;/script&gt;');
    expect(html).toContain('&lt;img src=');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a');
    expect(html).toContain('tag rows are not additive');
    expect(html).toContain('100 largest key groups');
    expect(html).toContain('100 largest tag groups');
  });
  it('includes known format/size/codec configuration values and leaves arbitrary private fields out', () => {
    expect(
      activityConfigurationLabel({
        outputFormat: 'webp',
        size: '1024x1024',
        codec: 'h264',
        prompt: 'private prompt',
        input: { secret: 'private' },
      }),
    ).toBe('outputFormat: webp · size: 1024x1024 · codec: h264');
    expect(activityConfigurationLabel({ prompt: 'private prompt' })).toBe(
      'Configuration not recorded',
    );
  });
  it('denies activity rendering before read permission and never renders private records from server markup', () => {
    const denied = renderToStaticMarkup(
      createElement(PrivateActivity, { workspaceId: 'workspace-a', permissions: [] }),
    );
    expect(denied).toContain('do not include activity access');
    expect(denied).not.toContain('<table');
    const loading = renderToStaticMarkup(
      createElement(PrivateActivity, {
        workspaceId: 'workspace-a',
        recoveryScope: 'scope-a',
        permissions: ['read'],
      }),
    );
    expect(loading).toContain('Loading activity');
    expect(loading).not.toContain('job-a');
    expect(loading).not.toContain('<img');
    expect(loading).not.toContain('<video');
  });
  it('replaces the entire private state boundary synchronously when workspace/member/scopes change', () => {
    const props = {
      workspaceId: 'workspace-a',
      membershipId: 'member-a',
      recoveryScope: 'scope-a',
      permissions: ['read', 'webhooks:write'],
    };
    const keyOf = (element: unknown) => {
      expect(isValidElement(element)).toBe(true);
      return isValidElement(element) ? element.key : null;
    };
    const activityKey = keyOf(PrivateActivity(props));
    const operationsKey = keyOf(WorkspaceOperations(props));
    for (const next of [
      { ...props, workspaceId: 'workspace-b' },
      { ...props, membershipId: 'member-b' },
      { ...props, recoveryScope: 'scope-b' },
      { ...props, permissions: ['read'] },
    ]) {
      expect(keyOf(PrivateActivity(next))).not.toBe(activityKey);
      expect(keyOf(WorkspaceOperations(next))).not.toBe(operationsKey);
    }
    expect(keyOf(PrivateActivity({ ...props, permissions: ['webhooks:write', 'read'] }))).toBe(
      activityKey,
    );
  });
  it('requires current authority for every private request and suspends unverified views', () => {
    expect(
      privateWorkspaceHeaders({ workspaceId: 'workspace-a', recoveryScope: 'scope-a' }),
    ).toEqual({ 'x-opengen-workspace': 'workspace-a', 'x-opengen-recovery-scope': 'scope-a' });
    expect(
      privateWorkspaceHeaders({ workspaceId: 'workspace-a', recoveryScope: 'scope-b' }),
    ).not.toEqual(
      privateWorkspaceHeaders({ workspaceId: 'workspace-a', recoveryScope: 'scope-a' }),
    );
    for (const authority of [
      { workspaceId: null, recoveryScope: 'scope-a' },
      { workspaceId: 'workspace-a' },
      { workspaceId: 'workspace-a', recoveryScope: 'bad\nheader' },
    ])
      expect(() => privateWorkspaceHeaders(authority)).toThrow();
    for (const component of [PrivateActivity, WorkspaceOperations]) {
      const html = renderToStaticMarkup(
        createElement(component, {
          workspaceId: 'workspace-a',
          membershipId: 'member-a',
          permissions: ['read', 'webhooks:write'],
        }),
      );
      expect(html).toContain('Verify workspace access');
      expect(html).not.toContain('New endpoint');
      expect(html).not.toContain('<table');
    }
  });
  it('keeps notifications personal and hides administrative webhook controls from read-only members', () => {
    const member = renderToStaticMarkup(
      createElement(WorkspaceOperations, {
        workspaceId: 'workspace-a',
        membershipId: 'member-a',
        recoveryScope: 'scope-a',
        permissions: ['read'],
      }),
    );
    expect(member).toContain('Your notifications');
    expect(member).not.toContain('New endpoint');
    expect(member).not.toContain('Rotate secret');
    const apiKey = renderToStaticMarkup(
      createElement(WorkspaceOperations, {
        workspaceId: 'workspace-a',
        recoveryScope: 'scope-a',
        permissions: ['read'],
      }),
    );
    expect(apiKey).toContain('active workspace membership');
    expect(apiKey).not.toContain('Your workspace notifications');
    expect(
      renderToStaticMarkup(
        createElement(WorkspaceOperations, {
          workspaceId: null,
          membershipId: 'member-a',
          permissions: ['read', 'webhooks:write'],
        }),
      ),
    ).toBe('');
  });
  it('presents explicit webhook edit/disable semantics without embedding a secret or event payload', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceOperations, {
        workspaceId: 'workspace-a',
        recoveryScope: 'scope-a',
        permissions: ['webhooks:write'],
      }),
    );
    expect(html).toContain('already sent may still arrive');
    expect(html).toContain('does not replay cancelled events');
    expect(html).not.toContain('og_whsec_');
    expect(html).not.toContain('secret_ciphertext');
  });
  it('fences all management screens and retires state when expected authority changes', () => {
    const authority = { workspaceId: 'workspace-a', recoveryScope: 'scope-a' };
    const permissions = ['read', 'keys:write', 'policies:write', 'connections:write'];
    const keyOf = (element: unknown) => {
      expect(isValidElement(element)).toBe(true);
      return isValidElement(element) ? element.key : null;
    };
    for (const component of [WorkspaceSettings, ConnectedApps]) {
      const missing = renderToStaticMarkup(
        createElement(component, { workspaceId: 'workspace-a', permissions }),
      );
      expect(missing).toContain('Verify workspace access');
      expect(missing).not.toContain('Create API key');
      expect(missing).not.toContain('Provider API key');
      const initial = keyOf(component({ ...authority, permissions }));
      expect(keyOf(component({ ...authority, recoveryScope: 'scope-b', permissions }))).not.toBe(
        initial,
      );
      expect(keyOf(component({ ...authority, workspaceId: 'workspace-b', permissions }))).not.toBe(
        initial,
      );
      expect(keyOf(component({ ...authority, permissions: ['read', 'keys:write'] }))).not.toBe(
        initial,
      );
      expect(keyOf(component({ ...authority, permissions: [...permissions].reverse() }))).toBe(
        initial,
      );
    }
    const missingTeam = renderToStaticMarkup(
      createElement(WorkspaceAdministration, { expectedAuthority: { workspaceId: 'workspace-a' } }),
    );
    expect(missingTeam).toContain('Verify workspace access');
    expect(missingTeam).not.toContain('Invite teammate');
    const teamKey = keyOf(WorkspaceAdministration({ expectedAuthority: authority }));
    expect(
      keyOf(
        WorkspaceAdministration({ expectedAuthority: { ...authority, recoveryScope: 'scope-b' } }),
      ),
    ).not.toBe(teamKey);
    expect(
      keyOf(
        WorkspaceAdministration({
          expectedAuthority: { ...authority, workspaceId: 'workspace-b' },
        }),
      ),
    ).not.toBe(teamKey);
  });
});
