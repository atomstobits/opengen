import { diffDriftSnapshots, importDriftSnapshot } from './drift.js';

/** The CLI has no network or mutation mode. Writers permit focused exit/output testing. */
export async function runDriftCli(
  args: string[],
  output: (value: string) => void,
  errorOutput: (value: string) => void,
): Promise<number> {
  if (args.length !== 2) {
    errorOutput(
      'Usage: tsx scripts/catalog-drift.ts <baseline-manifest.json> <candidate-manifest.json>',
    );
    return 1;
  }
  try {
    const before = await importDriftSnapshot(args[0]!);
    const after = await importDriftSnapshot(args[1]!);
    const report = diffDriftSnapshots(before, after);
    output(JSON.stringify(report, null, 2));
    return report.disposition === 'review-required' ? 2 : 0;
  } catch (error) {
    errorOutput(
      error instanceof Error && error.message.startsWith('Catalog drift:')
        ? error.message
        : 'Catalog drift: evidence could not be read',
    );
    return 1;
  }
}
