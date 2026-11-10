import { afterEach, describe, expect, it } from 'vitest';
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applyBinding,
  bindingLoginStatus,
  previewBinding,
  type BindingOptions,
} from '../apps/cli/src/bindings';
import { runBindingCommand } from '../apps/cli/src/bindings-command';

const directories: string[] = [];
const baseUrl = 'https://opengen.example';
async function fixture(client: BindingOptions['client'] = 'cursor') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opengen-binding-test-')));
  directories.push(directory);
  return {
    directory,
    options: {
      client,
      configPath: join(directory, 'project', client === 'cursor' ? 'mcp.json' : '.mcp.json'),
      baseUrl,
    },
  };
}
async function seed(options: BindingOptions, content: unknown) {
  await mkdir(join(options.configPath, '..'), { recursive: true });
  await writeFile(
    options.configPath,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('previewable remote OAuth client binding', () => {
  it('previews only the new token-free entry without creating directories or files', async () => {
    const { options } = await fixture();
    const preview = await previewBinding(options);
    expect(preview).toMatchObject({ action: 'add', entry: { url: `${baseUrl}/mcp` } });
    expect(preview.previewId).toMatch(/^[a-f0-9]{64}$/);
    await expect(access(options.configPath)).rejects.toThrow();
    await expect(access(join(options.configPath, '..'))).rejects.toThrow();
  });

  it.each(['cursor', 'claude-code'] as const)(
    'preserves unrelated %s settings and tightens the output file permissions',
    async (client) => {
      const { options } = await fixture(client);
      const unrelated = {
        settings: { theme: 'forest', flag: false, nested: [1, null] },
        mcpServers: {
          library: { command: 'library', env: { PRIVATE_VALUE: 'synthetic-private-setting' } },
        },
      };
      await seed(options, unrelated);
      const preview = await previewBinding(options);
      expect(JSON.stringify(preview)).not.toContain('synthetic-private-setting');
      expect(await applyBinding({ ...options, previewId: preview.previewId })).toMatchObject({
        applied: true,
      });
      const config = JSON.parse(await readFile(options.configPath, 'utf8'));
      expect(config).toEqual({
        ...unrelated,
        mcpServers: {
          ...unrelated.mcpServers,
          opengen:
            client === 'cursor'
              ? { url: `${baseUrl}/mcp` }
              : { type: 'http', url: `${baseUrl}/mcp` },
        },
      });
      expect((await lstat(options.configPath)).mode & 0o077).toBe(0);
    },
  );

  it('writes a new configuration privately and treats a second identical application as a no-op', async () => {
    const { options } = await fixture();
    await applyBinding({ ...options, previewId: (await previewBinding(options)).previewId });
    const before = await readFile(options.configPath, 'utf8');
    const preview = await previewBinding(options);
    expect(preview.action).toBe('unchanged');
    expect(await applyBinding({ ...options, previewId: preview.previewId })).toMatchObject({
      applied: false,
    });
    expect(await readFile(options.configPath, 'utf8')).toBe(before);
    expect((await lstat(join(options.configPath, '..'))).mode & 0o077).toBe(0);
  });

  it('refuses a different existing entry unless replacement is explicitly previewed and applied', async () => {
    const { options } = await fixture();
    await seed(options, {
      mcpServers: {
        opengen: {
          url: 'https://old.example/mcp',
          headers: { Authorization: 'synthetic-old-private-token' },
        },
      },
    });
    await expect(previewBinding(options)).rejects.toThrow('already exists');
    const preview = await previewBinding({ ...options, replace: true });
    expect(preview.action).toBe('replace');
    expect(JSON.stringify(preview)).not.toContain('synthetic-old-private-token');
    await expect(applyBinding({ ...options, previewId: preview.previewId })).rejects.toThrow(
      'already exists',
    );
    await applyBinding({ ...options, replace: true, previewId: preview.previewId });
    expect(await readFile(options.configPath, 'utf8')).not.toContain('Authorization');
  });

  it('rejects stale previews without discarding a client edit', async () => {
    const { options } = await fixture();
    await seed(options, { enabled: true });
    const preview = await previewBinding(options);
    await seed(options, { enabled: true, editedByClient: 'keep me' });
    await expect(applyBinding({ ...options, previewId: preview.previewId })).rejects.toThrow(
      'stale',
    );
    expect(JSON.parse(await readFile(options.configPath, 'utf8'))).toEqual({
      enabled: true,
      editedByClient: 'keep me',
    });
  });

  it('binds preview approval to the destination, client, origin and replacement choice', async () => {
    const a = await fixture(),
      b = await fixture();
    const previewId = (await previewBinding(a.options)).previewId;
    for (const change of [
      b.options,
      { ...a.options, baseUrl: 'https://other.example' },
      { ...a.options, replace: true },
    ]) {
      await expect(applyBinding({ ...change, previewId })).rejects.toThrow('stale');
      await expect(access(change.configPath)).rejects.toThrow();
    }
  });

  it('refuses malformed JSON, JSONC and non-object config without printing private contents', async () => {
    const { options } = await fixture();
    for (const invalid of [
      '{"private":"synthetic-secret",}',
      '{/*synthetic-secret*/}',
      '[]',
      '{"mcpServers":null}',
      '{"mcpServers":[]}',
    ]) {
      await seed(options, invalid);
      const error = await previewBinding(options).catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('synthetic-secret');
      expect(await readFile(options.configPath, 'utf8')).toBe(invalid);
    }
  });

  it('refuses symlink files and directory ancestors', async () => {
    const { options, directory } = await fixture();
    const outside = join(directory, 'untouched.json');
    await writeFile(outside, '{}');
    await mkdir(join(options.configPath, '..'), { recursive: true });
    await symlink(outside, options.configPath);
    await expect(previewBinding(options)).rejects.toThrow('symlink');
    await rm(join(options.configPath, '..'), { recursive: true });
    await symlink(directory, join(options.configPath, '..'));
    await expect(previewBinding(options)).rejects.toThrow('Symlink');
    expect(await readFile(outside, 'utf8')).toBe('{}');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO configuration without waiting for a writer',
    async () => {
      const { options } = await fixture();
      await mkdir(join(options.configPath, '..'), { recursive: true });
      await promisify(execFile)('mkfifo', [options.configPath]);
      await expect(previewBinding(options)).rejects.toThrow('regular JSON file');
      expect((await lstat(options.configPath)).isFIFO()).toBe(true);
    },
    2000,
  );

  it('respects an existing cooperative update lock without writing a configuration', async () => {
    const { options } = await fixture();
    const previewId = (await previewBinding(options)).previewId;
    await mkdir(join(options.configPath, '..'), { recursive: true });
    await writeFile(`${options.configPath}.opengen.lock`, 'other process');
    await expect(applyBinding({ ...options, previewId })).rejects.toThrow('lock');
    await expect(access(options.configPath)).rejects.toThrow();
    expect(await readFile(`${options.configPath}.opengen.lock`, 'utf8')).toBe('other process');
  });

  it('does not accept credentials, insecure remote hosts or private token paths as a binding destination', async () => {
    const { options } = await fixture();
    for (const url of [
      'https://user:synthetic-secret@opengen.example',
      'https://opengen.example/?token=synthetic-secret',
      'https://opengen.example/mcp',
      'http://remote.example',
    ]) {
      const error = await previewBinding({ ...options, baseUrl: url }).catch(
        (cause: Error) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('synthetic-secret');
    }
    for (const configPath of [
      'mcp.json',
      join(options.configPath, '..', 'auth.json'),
      `${options.configPath}c`,
    ])
      await expect(previewBinding({ ...options, configPath })).rejects.toThrow();
    expect((await previewBinding({ ...options, baseUrl: 'http://127.0.0.1:4310' })).entry.url).toBe(
      'http://127.0.0.1:4310/mcp',
    );
  });

  it('keeps prototype-named unrelated JSON keys as data', async () => {
    const { options } = await fixture();
    await seed(
      options,
      '{"__proto__":{"safe":true},"mcpServers":{"__proto__":{"command":"keep"}}}',
    );
    await applyBinding({ ...options, previewId: (await previewBinding(options)).previewId });
    const config = JSON.parse(await readFile(options.configPath, 'utf8'));
    expect(Object.hasOwn(config, '__proto__')).toBe(true);
    expect(Object.hasOwn(config.mcpServers, '__proto__')).toBe(true);
    expect(config.mcpServers.__proto__).toEqual({ command: 'keep' });
  });

  it('reuses a private login profile for safe metadata and refuses a public profile', async () => {
    const { directory } = await fixture();
    const profilePath = join(directory, 'auth.json');
    const accessToken = `og_mcp_a_${'a'.repeat(43)}`;
    const refreshToken = `og_mcp_r_${'a'.repeat(43)}`;
    await writeFile(
      profilePath,
      JSON.stringify({
        version: 1,
        baseUrl,
        issuer: baseUrl,
        resource: `${baseUrl}/mcp`,
        clientId: 'fixture-client',
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scope: 'read generate',
        workspaceId: 'studio',
      }),
      { mode: 0o600 },
    );
    const status = await bindingLoginStatus({ baseUrl, profilePath });
    expect(status).toMatchObject({
      connected: false,
      authenticated: false,
      credentialPresent: true,
      verification: 'not-checked',
      workspaceId: 'studio',
      scope: 'read generate',
    });
    expect(JSON.stringify(status)).not.toContain(accessToken);
    expect(JSON.stringify(status)).not.toContain(refreshToken);
    expect(
      await bindingLoginStatus({ baseUrl: 'https://different.example', profilePath }),
    ).toMatchObject({ connected: false, baseUrl: 'https://different.example' });
    await chmod(profilePath, 0o644);
    await expect(bindingLoginStatus({ baseUrl, profilePath })).rejects.toThrow('0600');
  });

  it('redacts accidental unknown argv flags and offers concrete preview/apply commands', async () => {
    await expect(runBindingCommand(['preview', '--token', 'synthetic-secret'])).rejects.toThrow(
      'private arguments were not printed',
    );
    const { options } = await fixture('claude-code');
    const args = ['--client', options.client, '--config', options.configPath, '--url', baseUrl];
    const preview = (await runBindingCommand(['preview', ...args])) as { previewId: string };
    expect(
      await runBindingCommand(['apply', ...args, '--preview-id', preview.previewId]),
    ).toMatchObject({ applied: true });
    await expect(runBindingCommand(['apply', ...args])).rejects.toThrow('preview first');
    await expect(
      runBindingCommand(['preview', ...args, '--profile', '/private/auth.json']),
    ).rejects.toThrow('never copied');
  });
});
