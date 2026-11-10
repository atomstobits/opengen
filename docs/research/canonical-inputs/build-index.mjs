import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

// Research artifacts only: these reports do not change runtime support or execute a provider request.
const root = fileURLToPath(new URL('./', import.meta.url));
const formatting = (await resolveConfig(root)) ?? {};
const writeFormatted = async (path, text) =>
  writeFile(path, await format(text, { ...formatting, filepath: path }));
const names = ['video-seedance-kling-wan', 'video-h3-omni-grok', 'image-models'];
const scope = JSON.parse(await readFile(join(root, 'scope.json'), 'utf8'));
const expected = new Map(scope.models.map((model) => [model.id, model]));
const covered = new Map();
const profiles = [];
const rows = [];
const conflicts = [];
const sources = new Set();
const errors = [];
const layers = new Map();
let supplementalProfiles = 0;
let supplementalFields = 0;

function sourceResolver(document) {
  const registry = new Map();
  for (const [key, value] of Object.entries(document.sources ?? {})) {
    if (value?.id) registry.set(value.id, value);
    registry.set(key, value);
  }
  return (value) => {
    const result = new Set();
    const visit = (item) => {
      if (Array.isArray(item)) return item.forEach(visit);
      if (typeof item === 'string') {
        if (item.startsWith('https://')) result.add(item);
        else if (registry.has(item)) visit(registry.get(item));
        else errors.push(`Unresolved source reference: ${item}`);
      } else if (item?.url) result.add(item.url);
    };
    if (value) visit(value);
    return [...result];
  };
}
function asText(value) {
  return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}
function csvCell(value) {
  let text = asText(value);
  if (/^[=+@\t\r-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

for (const name of names) {
  const document = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
  const resolve = sourceResolver(document);
  for (const model of document.models) {
    if (!expected.has(model.id)) errors.push(`Unexpected model: ${model.id}`);
    if (covered.has(model.id)) errors.push(`Model appears in multiple audit groups: ${model.id}`);
    covered.set(model.id, { ...expected.get(model.id), report: `${name}.md`, endpointIds: [] });
  }
  const localIds = new Set();
  for (const endpoint of document.endpoints) {
    if (!endpoint.id || localIds.has(endpoint.id))
      errors.push(`Missing/duplicate endpoint ID: ${name}/${endpoint.id}`);
    localIds.add(endpoint.id);
    const sourceUrls = resolve(endpoint.sources ?? endpoint.sourceIds ?? endpoint.sourceUrl);
    if (!sourceUrls.length) errors.push(`Endpoint has no resolved source: ${endpoint.id}`);
    for (const url of sourceUrls) {
      const parsed = new URL(url);
      if (parsed.username || parsed.password)
        errors.push(`Credential-bearing source URL: ${endpoint.id}`);
      sources.add(url);
    }
    const operations =
      endpoint.operations ??
      (endpoint.operation ? [endpoint.operation] : (endpoint.documentedOperations ?? []));
    const profile = {
      group: name,
      id: endpoint.id,
      provider: endpoint.provider,
      modelIds: endpoint.modelIds,
      operations,
      region: endpoint.region ?? null,
      endpoint: endpoint.endpointUrl ?? endpoint.endpoint ?? endpoint.endpointId ?? null,
      evidenceStatus:
        endpoint.status ??
        endpoint.verification ??
        endpoint.implementationStatus ??
        'see source report',
      fieldCount: endpoint.fields.length,
      sources: sourceUrls,
      report: `${name}.md`,
    };
    profiles.push(profile);
    for (const modelId of endpoint.modelIds ?? []) {
      if (!covered.has(modelId))
        errors.push(`Endpoint refers to an unaudited model: ${endpoint.id}/${modelId}`);
      else covered.get(modelId).endpointIds.push(`${name}:${endpoint.id}`);
    }
    for (const snapshot of [endpoint.schemaFile, endpoint.snapshot]) {
      if (typeof snapshot === 'string' && snapshot.startsWith('schemas/')) {
        try {
          await access(join(root, snapshot));
        } catch {
          errors.push(`Missing schema snapshot: ${snapshot}`);
        }
      }
    }
    for (const field of endpoint.fields) {
      if (!field.path || field.type === undefined)
        errors.push(`Field lacks path/type: ${endpoint.id}`);
      const layer = field.classification ?? field.recommendedLayer ?? 'unclassified';
      if (!['commonGeneration', 'modelSpecific', 'brokerTransport'].includes(layer))
        errors.push(`Unclassified field: ${endpoint.id}/${field.path}`);
      layers.set(layer, (layers.get(layer) ?? 0) + 1);
      const fieldUrls =
        field.sources || field.sourceIds ? resolve(field.sources ?? field.sourceIds) : sourceUrls;
      rows.push({
        model_ids: (endpoint.modelIds ?? []).join(';'),
        provider: asText(endpoint.provider),
        endpoint_profile: endpoint.id,
        operations: operations.join(';'),
        region: asText(endpoint.region),
        field_path: field.path,
        type: asText(field.type),
        required: asText(field.required),
        required_when_parent_present: asText(field.requiredWhenParentPresent),
        default_specified: asText(
          field.defaultSpecified ??
            field.defaultDocumented ??
            (field.default?.status === 'not_documented' ? false : field.default !== undefined),
        ),
        default: asText(field.default),
        enum: asText(field.enum),
        bounds: asText(field.bounds),
        proposed_layer: layer,
        schema_pointer: field.schemaPointer ?? '',
        source_urls: fieldUrls.join(' ; '),
        research_file: `${name}.json`,
        // Preserve branch/conditional/applicability details even when a group uses a richer field representation.
        field_details_json: JSON.stringify(field),
      });
    }
  }
  for (const conflict of document.conflicts ?? [])
    conflicts.push({ group: name, report: `${name}.md`, ...conflict });
  for (const offering of document.additionalProviderDiscoveries ?? []) {
    supplementalProfiles++;
    supplementalFields += offering.fields?.length ?? 0;
  }
}
for (const [id] of expected) {
  if (!covered.has(id)) errors.push(`Missing requested variant: ${id}`);
  else if (!covered.get(id).endpointIds.length)
    errors.push(`Model lacks an API/inference/absence profile: ${id}`);
}
if (errors.length) throw new Error([...new Set(errors)].join('\n'));
const models = [...covered.values()];
const summary = {
  checkedAt: '2026-11-03',
  note: 'Documentary input inventory. Parameter records include repeated shared/nested/alternative fields across profiles; they are not unique parameters or live-verified capabilities. Classification is an OpenGen design proposal, not a vendor guarantee.',
  scopeModels: expected.size,
  auditedModels: models.length,
  existingCatalogRoutes: scope.routes.length,
  endpointProfiles: profiles.length,
  parameterRecords: rows.length,
  distinctSourceUrls: sources.size,
  classificationCounts: Object.fromEntries(layers),
  conflicts: conflicts.length,
  additionalUnqualifiedOfferingProfiles: supplementalProfiles,
  additionalUnqualifiedOfferingFields: supplementalFields,
};
await writeFormatted(
  join(root, 'index.json'),
  `${JSON.stringify({ summary, models, profiles, conflicts, sources: [...sources].sort() }, null, 2)}\n`,
);
const columns = Object.keys(rows[0]);
await writeFile(
  join(root, 'all-fields.csv'),
  `${[columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n')}\r\n`,
);
const table = models
  .map((model) => {
    const own = profiles.filter((profile) => profile.modelIds?.includes(model.id));
    const providers = [...new Set(own.map((profile) => asText(profile.provider)))].join(', ');
    return `| \`${model.id}\` | ${providers} | ${own.length} | [${model.modality} group](${model.report}) |`;
  })
  .join('\n');
await writeFormatted(
  join(root, 'model-coverage.md'),
  `# Exact model coverage\n\nChecked 2026-11-03. All ${models.length} requested exact variants are represented. Profiles may be shared by variants; per-model profile counts therefore do not sum to the global profile count. A weights/inference-only or unresolved API profile is not an executable hosted offering.\n\n| Exact model/variant | Audited provider labels | Profiles | Detailed report |\n| --- | --- | ---: | --- |\n${table}\n`,
);
const schemaCount = (await readdir(join(root, 'schemas'), { recursive: true })).filter((file) =>
  file.endsWith('.json'),
).length;
console.log(
  JSON.stringify({ ...summary, sanitizedSchemaFiles: schemaCount, validation: 'passed' }, null, 2),
);
