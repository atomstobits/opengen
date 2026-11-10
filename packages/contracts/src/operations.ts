// Stable native HTTP protocol metadata. No authorization, routing or pricing rules.
export const billingOperationTargets = {
  'billing.policy.get': { method: 'GET', path: '/v1/billing/policy' },
  'billing.policy.update': { method: 'PUT', path: '/v1/billing/policy' },
  'billing.recharges.list': { method: 'GET', path: '/v1/billing/recharges' },
  'billing.documents.list': { method: 'GET', path: '/v1/billing/documents' },
} as const;

export const operationTargets = {
  ...billingOperationTargets,
  'catalog.list': { method: 'GET', path: '/v1/catalog' },
  'catalog.search': { method: 'GET', path: '/v1/catalog/search' },
  'companies.list': { method: 'GET', path: '/v1/companies' },
  'companies.get': { method: 'GET', path: '/v1/companies/:company' },
  'series.list': { method: 'GET', path: '/v1/series' },
  'series.get': { method: 'GET', path: '/v1/series/:company/:slug' },
  'models.list': { method: 'GET', path: '/v1/models' },
  'models.schema': { method: 'GET', path: '/v1/models/schema' },
  'providers.list': { method: 'GET', path: '/v1/providers' },
  'deployments.list': { method: 'GET', path: '/v1/deployments' },
  'routes.list': { method: 'GET', path: '/v1/routes' },
  'metrics.list': { method: 'GET', path: '/v1/metrics' },
  'operations.list': { method: 'GET', path: '/v1/operations' },
  'quotes.single': { method: 'POST', path: '/v1/quotes' },
  'quotes.batch': { method: 'POST', path: '/v1/quotes/batch' },
  'media.generate': { method: 'POST', path: '/v1/generations' },
  'assets.get': { method: 'GET', path: '/v1/assets' },
  'assets.import': { method: 'POST', path: '/v1/assets/import' },
  'assets.reuse': { method: 'POST', path: '/v1/assets/reuse' },
  'assets.multipart.prepare': { method: 'POST', path: '/v1/assets/multipart' },
  'assets.multipart.part': { method: 'POST', path: '/v1/assets/multipart/part' },
  'assets.multipart.get': { method: 'GET', path: '/v1/assets/multipart' },
  'assets.multipart.complete': { method: 'POST', path: '/v1/assets/multipart/complete' },
  'assets.multipart.abort': { method: 'POST', path: '/v1/assets/multipart/abort' },
  'assets.prepare': { method: 'POST', path: '/v1/assets' },
  'assets.complete': { method: 'POST', path: '/v1/assets/complete' },
  'assets.delete': { method: 'DELETE', path: '/v1/assets' },
  'activity.list': { method: 'GET', path: '/v1/activity' },
  'activity.analytics': { method: 'GET', path: '/v1/activity/analytics' },
  'notifications.list': { method: 'GET', path: '/v1/notifications' },
  'notifications.preferences.get': { method: 'GET', path: '/v1/notifications/preferences' },
  'notifications.preferences.put': { method: 'PUT', path: '/v1/notifications/preferences' },
  'notifications.read': { method: 'POST', path: '/v1/notifications/:id/read' },
  'images.edit': { method: 'POST', path: '/v1/images/edits' },
  'jobs.list': { method: 'GET', path: '/v1/generations' },
  'jobs.lookup': { method: 'GET', path: '/v1/generations/lookup' },
  'jobs.status': { method: 'GET', path: '/v1/generations/:id/status' },
  'jobs.get': { method: 'GET', path: '/v1/generations/:id' },
  'jobs.cancel': { method: 'POST', path: '/v1/generations/:id/cancel' },
  'doctor.get': { method: 'GET', path: '/v1/doctor' },
  'feedback.submit': { method: 'POST', path: '/v1/feedback' },
  'feedback.get': { method: 'GET', path: '/v1/feedback/:id' },
  'catalog.request': { method: 'POST', path: '/v1/catalog/requests' },
  'balance.get': { method: 'GET', path: '/v1/balance' },
  'ledger.list': { method: 'GET', path: '/v1/ledger' },
  'ledger.export': { method: 'GET', path: '/v1/ledger/export' },
  'operator.inspect': { method: 'GET', path: '/v1/workspaces/:workspaceId/generations/:id' },
  'operator.reconcile': {
    method: 'POST',
    path: '/v1/workspaces/:workspaceId/generations/:id/reconcile',
  },
  'operator.reconciliations': {
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/generations/:id/reconciliations',
  },
  'keys.governance': { method: 'GET', path: '/v1/governance/keys' },
  'keys.update': { method: 'PATCH', path: '/v1/keys/:id' },
  'keys.rotate': { method: 'POST', path: '/v1/keys/:id/rotate' },
  'policies.governance': { method: 'GET', path: '/v1/governance/policies' },
  'policies.update': { method: 'PATCH', path: '/v1/policies/:id' },
  'policies.archive': { method: 'POST', path: '/v1/policies/:id/archive' },
  'keys.list': { method: 'GET', path: '/v1/keys' },
  'keys.create': { method: 'POST', path: '/v1/keys' },
  'keys.revoke': { method: 'DELETE', path: '/v1/keys/:id' },
  'policies.list': { method: 'GET', path: '/v1/policies' },
  'policies.create': { method: 'POST', path: '/v1/policies' },
  'connections.list': { method: 'GET', path: '/v1/connections' },
  'connections.put': { method: 'PUT', path: '/v1/connections/:deploymentId' },
  'connections.delete': { method: 'DELETE', path: '/v1/connections/:deploymentId' },
  'webhooks.list': { method: 'GET', path: '/v1/webhooks' },
  'webhooks.create': { method: 'POST', path: '/v1/webhooks' },
  'webhooks.deliveries': { method: 'GET', path: '/v1/webhook-deliveries' },
  'alerts.list': { method: 'GET', path: '/v1/alerts' },
  'alerts.settings.get': { method: 'GET', path: '/v1/alerts/settings' },
  'alerts.settings.put': { method: 'PUT', path: '/v1/alerts/settings' },
  'webhooks.update': { method: 'PATCH', path: '/v1/webhooks/:id' },
  'webhooks.rotate': { method: 'POST', path: '/v1/webhooks/:id/rotate-secret' },
  'workspaces.list': { method: 'GET', path: '/v1/workspaces' },
  'teams.create': { method: 'POST', path: '/v1/teams' },
  'members.list': { method: 'GET', path: '/v1/members' },
  'members.invite': { method: 'POST', path: '/v1/members' },
  'members.update': { method: 'PATCH', path: '/v1/members/:id' },
  'members.remove': { method: 'DELETE', path: '/v1/members/:id' },
  'workspaces.acceptInvite': { method: 'POST', path: '/v1/workspaces/:id/accept-invite' },
  'workspaces.create': { method: 'POST', path: '/v1/workspaces' },
  'workspaces.credit': { method: 'POST', path: '/v1/workspaces/:id/credits' },
  'images.generate': { method: 'POST', path: '/v1/images/generations' },
  'videos.create': { method: 'POST', path: '/v1/videos' },
  'videos.get': { method: 'GET', path: '/v1/videos/:id' },
  'videos.content': { method: 'GET', path: '/v1/videos/:id/content' },
} as const;

export type OperationId = keyof typeof operationTargets;

export function operationRequest(operationId: OperationId, input: unknown) {
  if (!Object.hasOwn(operationTargets, operationId))
    throw new TypeError('Unknown registered operation.');
  const target = operationTargets[operationId];
  let path: string = target.path;
  let payload: Record<string, unknown> | unknown[] = Array.isArray(input)
    ? input
    : { ...(input as Record<string, unknown>) };
  if (!Array.isArray(payload)) {
    const fields = payload as Record<string, unknown>;
    path = path.replace(/:([a-zA-Z]+)/g, (_token, field: string) => {
      const value = fields[field];
      delete fields[field];
      return encodeURIComponent(String(value));
    });
    if (target.method === 'GET') {
      const query = new URLSearchParams();
      for (const [field, value] of Object.entries(fields))
        if (value !== undefined) query.set(field, String(value));
      if (query.size) path += '?' + query.toString();
    }
  }
  return { method: target.method, path, payload: target.method === 'GET' ? undefined : payload };
}
