#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuration, cloudDriver } from './gcp-bootstrap.mjs';

/** Exact issuer, stable owner/project IDs, names and production subject; never wildcard trust. */
export function vercelWifPlan(options) {
  const c = configuration(options);
  const {
    projectNumber,
    teamSlug,
    teamId,
    projectName,
    vercelProjectId,
    issuerMode = 'team',
  } = options;
  if (
    !/^[1-9][0-9]{5,19}$/.test(projectNumber ?? '') ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(teamSlug ?? '') ||
    !/^team_[A-Za-z0-9]+$/.test(teamId ?? '') ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(projectName ?? '') ||
    !/^prj_[A-Za-z0-9]+$/.test(vercelProjectId ?? '') ||
    !['team', 'global'].includes(issuerMode)
  )
    throw new Error(
      'Supply exact reviewed GCP project number and Vercel team slug/ID, project name/ID and issuer mode.',
    );
  const subject = `owner:${teamSlug}:project:${projectName}:environment:production`;
  if (subject.length > 127)
    throw new Error(
      'Vercel subject exceeds Google subject limit; review a stable subject mapping separately.',
    );
  const pool = 'opengen-vercel',
    provider = 'vercel';
  const resource = `projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
  const issuer = `https://oidc.vercel.com${issuerMode === 'team' ? `/${teamSlug}` : ''}`;
  const audience = `https://iam.googleapis.com/${resource}`;
  const mapping = {
    'google.subject': 'assertion.sub',
    'attribute.owner_id': 'assertion.owner_id',
    'attribute.project_id': 'assertion.project_id',
    'attribute.environment': 'assertion.environment',
  };
  const condition = `assertion.owner_id == '${teamId}' && assertion.project_id == '${vercelProjectId}' && assertion.environment == 'production' && assertion.sub == '${subject}'`;
  const principal = `principal://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/subject/${subject}`;
  const commands = [
    [
      'iam',
      'workload-identity-pools',
      'create',
      pool,
      '--project',
      c.project,
      '--location',
      'global',
      '--display-name',
      'OpenGen Vercel production',
    ],
    [
      'iam',
      'workload-identity-pools',
      'providers',
      'create-oidc',
      provider,
      '--project',
      c.project,
      '--location',
      'global',
      '--workload-identity-pool',
      pool,
      '--issuer-uri',
      issuer,
      '--allowed-audiences',
      audience,
      '--attribute-mapping',
      Object.entries(mapping)
        .map(([name, value]) => `${name}=${value}`)
        .join(','),
      '--attribute-condition',
      condition,
    ],
    [
      'iam',
      'service-accounts',
      'add-iam-policy-binding',
      c.accounts.vercel,
      '--project',
      c.project,
      '--member',
      principal,
      '--role',
      'roles/iam.workloadIdentityUser',
    ],
    [
      'run',
      'services',
      'add-iam-policy-binding',
      'opengen-api',
      '--project',
      c.project,
      '--region',
      c.region,
      '--member',
      `serviceAccount:${c.accounts.vercel}`,
      '--role',
      'roles/run.invoker',
    ],
  ];
  return {
    mode: 'plan',
    project: c.project,
    region: c.region,
    projectNumber,
    pool,
    provider,
    resource,
    issuer,
    audience,
    mapping,
    condition,
    subject,
    caller: c.accounts.vercel,
    commands: commands.map((args) => ['gcloud', ...args]),
    variables: {
      GCP_WORKLOAD_IDENTITY_PROVIDER: resource,
      GCP_SERVICE_ACCOUNT_EMAIL: c.accounts.vercel,
    },
    notes: [
      'No cloud request/mutation in plan mode.',
      'Project ID must match the supplied GCP project number before apply.',
      'Production trust only; preview/development need a separately reviewed boundary.',
      'No downloaded keys, token headers, provider/operator/database secrets or Vercel mutation.',
    ],
  };
}
export async function setupVercelWif(options, driver = cloudDriver()) {
  const plan = vercelWifPlan(options);
  if (!options.apply) return plan;
  const run = (args, metadata) => driver.command(args, metadata);
  const project = await run(['projects', 'describe', plan.project]);
  if (String(project.projectNumber) !== plan.projectNumber)
    throw new Error('GCP project number mismatch; no federation was changed.');
  const caller = await run([
    'iam',
    'service-accounts',
    'describe',
    plan.caller,
    '--project',
    plan.project,
  ]);
  if (caller.email !== plan.caller || caller.disabled)
    throw new Error('Existing Vercel caller identity is disabled or mismatched.');
  const service = await run([
    'run',
    'services',
    'describe',
    'opengen-api',
    '--project',
    plan.project,
    '--region',
    plan.region,
  ]);
  const policy = await run([
    'run',
    'services',
    'get-iam-policy',
    'opengen-api',
    '--project',
    plan.project,
    '--region',
    plan.region,
  ]);
  if (
    policy.bindings?.some((binding) =>
      binding.members?.some((member) => ['allUsers', 'allAuthenticatedUsers'].includes(member)),
    )
  )
    throw new Error('API has public IAM access; reconcile before federation setup.');
  if (
    service.invokerIamDisabled ||
    service.metadata?.annotations?.['run.googleapis.com/invoker-iam-disabled'] === 'true'
  )
    throw new Error('API invoker IAM check is disabled; reconcile before federation setup.');
  const inheritedPolicy = await run(['projects', 'get-iam-policy', plan.project]);
  if (
    inheritedPolicy.bindings?.some((binding) =>
      binding.members?.some((member) => ['allUsers', 'allAuthenticatedUsers'].includes(member)),
    )
  )
    throw new Error('API inherits public invocation; reconcile before federation setup.');
  const serviceOrigin = service.status?.url;
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]*run\.app$/.test(serviceOrigin ?? ''))
    throw new Error('Expected a canonical Cloud Run service origin.');
  const pool = await run(
    [
      'iam',
      'workload-identity-pools',
      'describe',
      plan.pool,
      '--project',
      plan.project,
      '--location',
      'global',
    ],
    { absent: true },
  );
  if (pool && (pool.state !== 'ACTIVE' || pool.disabled))
    throw new Error('Existing federation pool is disabled or inactive; no automatic repair.');
  const provider = pool
    ? await run(
        [
          'iam',
          'workload-identity-pools',
          'providers',
          'describe',
          plan.provider,
          '--project',
          plan.project,
          '--location',
          'global',
          '--workload-identity-pool',
          plan.pool,
        ],
        { absent: true },
      )
    : null;
  if (provider) {
    const sameMapping =
      JSON.stringify(Object.entries(provider.attributeMapping ?? {}).sort()) ===
      JSON.stringify(Object.entries(plan.mapping).sort());
    if (
      provider.disabled ||
      provider.state !== 'ACTIVE' ||
      provider.oidc?.issuerUri !== plan.issuer ||
      JSON.stringify(provider.oidc?.allowedAudiences) !== JSON.stringify([plan.audience]) ||
      !sameMapping ||
      provider.attributeCondition !== plan.condition
    )
      throw new Error(
        'Existing federation provider trust differs from this exact reviewed plan; no automatic widening/reset.',
      );
  }
  if (!pool) await run(plan.commands[0].slice(1));
  if (!provider) await run(plan.commands[1].slice(1));
  await run(plan.commands[2].slice(1));
  await run(plan.commands[3].slice(1));
  return {
    mode: 'applied',
    variables: { ...plan.variables, MEDIA_ROUTER_API_URL: serviceOrigin },
    readiness:
      'Federation configured; real Vercel token exchange, private API invocation, caller auth and OAuth/client flows still require qualification.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        [
          'project',
          'region',
          'bucket',
          'public-origin',
          'project-number',
          'team-slug',
          'team-id',
          'project-name',
          'vercel-project-id',
          'issuer-mode',
        ]
          .map((name) => [name, { type: 'string' }])
          .concat([
            ['apply', { type: 'boolean' }],
            ['plan', { type: 'boolean' }],
          ]),
      ),
    });
    if (values.apply && values.plan) throw new Error('Choose plan or apply.');
    const options = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name.replace(/-([a-z])/g, (_, char) => char.toUpperCase()),
        value,
      ]),
    );
    console.log(JSON.stringify(await setupVercelWif(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
