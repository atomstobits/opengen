import { catalog, validateCatalog } from '@media-router/catalog';

const errors = validateCatalog();
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `Catalog valid: ${catalog.models.length} model variants, ${catalog.providers.length} companies, ${catalog.deployments.length} deployments, ${catalog.routes.length} documented routes.`,
  );
  console.log(
    'Documentation status is not execution or live-verification status. Full regional audits beyond Wan remain in progress.',
  );
}
