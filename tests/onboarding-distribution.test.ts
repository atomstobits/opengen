import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { onboardingOutputs } from '../scripts/build-onboarding.mjs';
import { packageOnboarding } from '../scripts/package-onboarding.mjs';
import { agentSkill, agentEntry, imageToVideoGuide } from '@media-router/contracts';
import { GET as webSkill } from '../apps/web/app/skill.md/route';
import { GET as webGuide } from '../apps/web/app/guides/image-to-video.md/route';
import { siteOrigin } from '../apps/web/app/seo';
import { buildApp } from '../apps/server/src/app';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('private checkout-free onboarding release', () => {
  let temporary: string, release: Awaited<ReturnType<typeof packageOnboarding>>;
  const env = () => ({
    PATH: '/usr/bin:/bin',
    NODE_OPTIONS: '',
    XDG_CONFIG_HOME: join(temporary, 'untouched-config'),
  });
  const args = (suffix: string, manifest = release.manifestSha256) => [
    join(release.releaseDirectory, 'install-opengen.mjs'),
    '--release-dir',
    release.releaseDirectory,
    '--expected-manifest-sha256',
    manifest,
    '--prefix',
    join(temporary, `client-${suffix}`),
    '--skill-dir',
    join(temporary, `skill-${suffix}`),
    '--plugin-dir',
    join(temporary, `plugin-${suffix}`),
  ];
  beforeAll(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'opengen-onboarding-')));
    await mkdir(join(temporary, 'empty-working-directory'));
    release = await packageOnboarding({
      sourceRoot: root,
      outputDirectory: join(temporary, 'review-release'),
    });
  });
  afterAll(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('keeps the served web, REST and installable skill on the canonical source', async () => {
    for (const [path, expected] of await onboardingOutputs(root))
      expect(await readFile(join(root, path), 'utf8'), path).toBe(expected);
    const origin = 'https://gateway.example';
    const app = await buildApp({ publicUrl: origin });
    try {
      const skill = await app.inject('/skill.md');
      expect(skill.body).toBe(agentSkill(origin));
      expect(skill.body.startsWith('---\nname: opengen\ndescription: ')).toBe(true);
      const entry = await app.inject('/llms.txt');
      expect(entry.body).toContain(`${origin}/skill.md`);
      expect(entry.body).toContain(agentEntry(origin));
      expect(await webSkill().text()).toBe(agentSkill(siteOrigin()));
      expect(await webGuide().text()).toBe(imageToVideoGuide(siteOrigin()));
      expect(imageToVideoGuide(origin)).toContain(origin);
    } finally {
      await app.close();
    }
  });

  it('installs CLI, skill and native plugin offline outside a checkout and runs with only Node', async () => {
    const result = await run(process.execPath, args('clean'), {
      cwd: join(temporary, 'empty-working-directory'),
      env: env(),
    });
    const installed = JSON.parse(result.stdout);
    expect(installed.version).toBe(release.version);
    const version = await run(
      process.execPath,
      ['--disallow-code-generation-from-strings', installed.executable, '--version'],
      { cwd: temporary, env: env() },
    );
    expect(version.stdout.trim()).toBe(`opengen-cli ${release.version}`);
    const help = await run(process.execPath, [installed.executable, '--help'], {
      cwd: temporary,
      env: env(),
    });
    expect(help.stdout).toContain('doctor');
    expect(await readFile(join(installed.skillDirectory, 'SKILL.md'), 'utf8')).toBe(
      agentSkill('https://opengen.dev'),
    );
    const plugin = JSON.parse(
      await readFile(join(installed.pluginDirectory, '.claude-plugin/plugin.json'), 'utf8'),
    );
    expect(plugin.version).toBe(release.version);
    expect(plugin.mcpServers).toEqual({
      opengen: { type: 'http', url: 'https://opengen.dev/mcp' },
    });
  });

  it('refuses a wrong trusted manifest digest, tampered archive and existing destination', async () => {
    await expect(
      run(process.execPath, args('wrong', '0'.repeat(64)), { env: env() }),
    ).rejects.toThrow('reviewed digest');
    const archivePath = join(release.releaseDirectory, `opengen-skill-${release.version}.tgz`);
    const archive = await readFile(archivePath);
    try {
      await writeFile(archivePath, Buffer.from('tampered'));
      await expect(run(process.execPath, args('tampered'), { env: env() })).rejects.toThrow(
        'checksum mismatch',
      );
    } finally {
      await writeFile(archivePath, archive);
    }
    await mkdir(join(temporary, 'client-existing'));
    await writeFile(join(temporary, 'client-existing', 'preserve'), 'existing unrelated file');
    await expect(run(process.execPath, args('existing'), { env: env() })).rejects.toThrow(
      'never overwritten',
    );
    expect(await readFile(join(temporary, 'client-existing', 'preserve'), 'utf8')).toBe(
      'existing unrelated file',
    );
  });

  it('rebuilds byte-identical CLI, skill and plugin archives with the same source/toolchain', async () => {
    const second = await packageOnboarding({
      sourceRoot: root,
      outputDirectory: join(temporary, 'second-review-release'),
    });
    for (const kind of ['cli', 'skill', 'plugin']) {
      const file = `opengen-${kind}-${release.version}.tgz`;
      expect(digest(await readFile(join(second.releaseDirectory, file)))).toBe(
        digest(await readFile(join(release.releaseDirectory, file))),
      );
    }
  });

  it('records exact versioned artifact hashes and honest unsigned source provenance', async () => {
    const manifestBytes = await readFile(join(release.releaseDirectory, 'RELEASE-MANIFEST.json'));
    expect(digest(manifestBytes)).toBe(release.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString());
    for (const artifact of Object.values(manifest.artifacts) as { file: string; sha256: string }[])
      expect(digest(await readFile(join(release.releaseDirectory, artifact.file)))).toBe(
        artifact.sha256,
      );
    const provenance = JSON.parse(
      await readFile(join(release.releaseDirectory, 'PROVENANCE.json'), 'utf8'),
    );
    expect(
      provenance.source.inputs.find(
        (input: { path: string }) => input.path === 'docs/agent/SKILL.md',
      ),
    ).toBeDefined();
    expect(provenance.attestation).toContain('Unsigned');
    expect(manifest.publication).toBe('unpublished-review-candidate');
  });
});
