import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { catalog } from '@media-router/catalog';
import type { DoctorBlocker, DoctorReport, WorkspaceReadiness } from '@media-router/contracts';
import type { Principal } from '@media-router/engine';
import type { EngineLike } from './app.js';

export async function registerDoctor(
  app: FastifyInstance,
  context: {
    authenticate(request: Pick<FastifyRequest, 'headers' | 'cookies'>): Promise<Principal>;
    requireEngine(): EngineLike;
  },
) {
  app.get('/v1/doctor', async (request, reply): Promise<DoctorReport> => {
    reply.header('Cache-Control', 'no-store');
    const principal = await context.authenticate(request);
    const engine = context.requireEngine();
    const readiness: WorkspaceReadiness | undefined = await engine.workspaceReadiness?.(
      principal.workspaceId,
    );
    const balance =
      readiness?.balance ??
      ((await engine.getBalance(principal.workspaceId)) as WorkspaceReadiness['balance']);
    const policy = principal.policy;
    const eligible = (id: string) => {
      const route = catalog.routes.find((route) => route.id === id);
      const deployment = catalog.deployments.find(
        (deployment) => deployment.id === route?.deploymentId,
      );
      return Boolean(
        route &&
        deployment &&
        (!policy?.providerIds || policy.providerIds.includes(deployment.providerId)) &&
        (!policy?.deploymentIds || policy.deploymentIds.includes(deployment.id)) &&
        (!policy?.endpointRegions || policy.endpointRegions.includes(deployment.endpointRegion)) &&
        (!policy?.processingRegions ||
          (deployment.processingRegions?.length &&
            deployment.processingRegions.every((region) =>
              policy.processingRegions!.includes(region),
            ))) &&
        (policy?.fidelity !== 'native' || route.fidelity === 'native'),
      );
    };
    const managed = (readiness?.configuredRoutes.managed ?? engine.getExecutableRouteIds()).filter(
      eligible,
    );
    const byok = (readiness?.configuredRoutes.byok ?? []).filter(eligible);
    const blockers: DoctorBlocker[] = [];
    const block = (code: string, message: string, nextCommand: string) =>
      blockers.push({ code, message, nextCommand });
    if (!principal.scopes.includes('generate'))
      block(
        'insufficient_scope',
        'This credential can read but cannot authorize generation. Obtain generate scope for this paying workspace.',
        'opengen login',
      );
    if (!readiness)
      block(
        'readiness_unavailable',
        'This installation cannot diagnose billing holds or workspace provider connections. Ask its operator to update the gateway.',
        'opengen status',
      );
    if (readiness?.billingHold)
      block(
        'billing_hold',
        'Billing review blocks new generation, including BYOK. Existing accepted jobs remain recoverable.',
        'opengen call jobs.list',
      );
    if (readiness?.executionScope?.transitionBlocked)
      block(
        'execution_scope_transition_required',
        'Queued work requires operator review under the current qualification scope. Original jobs and holds are unchanged.',
        'opengen call jobs.list',
      );
    if (principal.maxCostMicros === 0)
      block(
        'spending_cap_zero',
        'This credential has a zero managed-credit spending ceiling. Select explicit BYOK or ask a workspace administrator to change the policy.',
        'opengen catalog search',
      );
    if (!managed.length && !byok.length)
      block(
        'no_executable_route',
        'No configured route satisfies this credential’s provider, regional and fidelity policy. Catalog listings alone cannot execute.',
        'opengen catalog search',
      );
    if (balance.availableMicros <= 0 && !byok.length)
      block(
        'insufficient_balance',
        'The paying workspace has no available managed credit and no configured BYOK route. Ask its administrator to fund it or configure an explicit BYOK connection.',
        'opengen balance',
      );
    let name: string | null = null;
    if (engine.accounts) {
      const workspaces = await engine.accounts.listWorkspaces(principal);
      name = workspaces.find((workspace) => workspace.id === principal.workspaceId)?.name ?? null;
    }
    return {
      authenticated: true,
      authorized: principal.scopes.includes('generate'),
      account: principal.identity ?? null,
      payingWorkspace: { id: principal.workspaceId, name },
      scopes: principal.scopes,
      policy: policy ?? null,
      maxCostMicros: principal.maxCostMicros ?? null,
      balance,
      billingHold: readiness?.billingHold ?? null,
      ...(readiness?.executionScope
        ? {
            executionScope: {
              profile: readiness.executionScope.profile,
              queuedConflicts: readiness.executionScope.queuedConflicts,
              transitionBlocked: readiness.executionScope.transitionBlocked,
            },
          }
        : {}),
      executableRoutes: {
        managed,
        byok,
        evidence: 'configuration-only',
        requestQuoteRequired: true,
      },
      blockers,
      nextBlocker: blockers[0] ?? null,
      nextCommand: blockers[0]?.nextCommand ?? 'opengen catalog search --operation image-to-video',
      notices: [
        ...(readiness?.executionScope?.profile === 'qualification-sg-v1'
          ? [
              'This runtime is restricted to a bounded qualification scope, not a public launch. An exact managed quote is required; image-to-video also requires an operator-approved owned fixture. Broader documented capabilities remain comparison-only.',
            ]
          : []),
        'Authorized means the credential has generate scope; human approval of a specific quote and payer is still required before spending.',
        'Configured routes are not live provider verification. Inspect the effective schema and quote the exact request, regional route and explicit billing payer before submission.',
        'Diagnosis creates no upload, quote, reservation or generation and does not contact providers.',
      ],
    };
  });
  app.get('/v1/generations/lookup', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = await context.authenticate(request);
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string().min(1).max(200) })
      .strict()
      .parse(request.query);
    const engine = context.requireEngine();
    if (!engine.lookupJob)
      throw Object.assign(new Error('This gateway does not support read-only submission lookup.'), {
        statusCode: 501,
        code: 'lookup_unavailable',
      });
    const job = await engine.lookupJob(principal.workspaceId, idempotencyKey);
    return (
      job ??
      reply.code(404).send({
        error: {
          code: 'submission_not_found',
          message:
            'No job is visible for this workspace and key yet. Acceptance remains unknown; wait and repeat this read-only lookup or ask the operator to reconcile. Do not create a new submission.',
        },
      })
    );
  });
}
