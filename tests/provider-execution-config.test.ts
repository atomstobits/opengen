import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readProviderExecutionConfiguration } from '../apps/server/src/provider-execution.js';
import { readExecutionScopeConfiguration } from '../packages/engine/src/execution-scope.js';

describe('shared API and worker provider execution control', () => {
  it('preserves normal and live manual defaults and permits an explicit provider pause', () => {
    expect(readProviderExecutionConfiguration({})).toBe(true);
    expect(
      readProviderExecutionConfiguration({
        DATABASE_URL: 'postgresql://localhost/opengen',
        OPENGEN_BILLING_MANUAL: 'true',
        STRIPE_LIVEMODE: 'true',
      }),
    ).toBe(true);
    expect(
      readProviderExecutionConfiguration({ OPENGEN_PROVIDER_EXECUTION_ENABLED: 'false' }),
    ).toBe(false);
  });

  it('fences API sandbox mode and its database independently without worker billing secrets', () => {
    expect(
      readProviderExecutionConfiguration({
        OPENGEN_BILLING_SANDBOX: 'true',
        OPENGEN_PROVIDER_EXECUTION_ENABLED: 'true',
      }),
    ).toBe(false);
    for (const name of [
      'opengen_billing_sandbox',
      'opengen_billing_sandbox_261106',
      'opengen%5Fbilling_sandbox_fixture',
    ]) {
      // Only the shared database reaches the worker. No Stripe/billing key is
      // needed to keep frozen BYOK execution disabled there.
      for (const value of [undefined, 'true', 'false'])
        expect(
          readProviderExecutionConfiguration({
            DATABASE_URL: `postgresql://localhost/${name}?host=%2Fcloudsql%2Ffixture`,
            ...(value === undefined ? {} : { OPENGEN_PROVIDER_EXECUTION_ENABLED: value }),
          }),
        ).toBe(false);
    }
  });

  it('rejects invalid controls and ambiguous database targets before opening a connection', () => {
    for (const value of ['', '0', 'TRUE', 'paused'])
      expect(() =>
        readProviderExecutionConfiguration({ OPENGEN_PROVIDER_EXECUTION_ENABLED: value }),
      ).toThrow();
    for (const value of ['', 'accidental'])
      expect(() =>
        readProviderExecutionConfiguration({ OPENGEN_BILLING_SANDBOX: value }),
      ).toThrow();
    for (const url of [
      'not-a-database-url',
      'postgresql://localhost',
      'postgresql://localhost/regular?database=opengen_billing_sandbox',
      'postgresql://localhost/regular?%64bname=opengen_billing_sandbox',
    ])
      expect(() => readProviderExecutionConfiguration({ DATABASE_URL: url })).toThrow();
  });

  it('wires the same control into both official entrypoints and keeps it out of worker billing', async () => {
    for (const name of ['index', 'worker']) {
      const source = await readFile(
        new URL(`../apps/server/src/${name}.ts`, import.meta.url),
        'utf8',
      );
      expect(source).toContain('readProviderExecutionConfiguration(process.env)');
      expect(source).toContain('readExecutionScopeConfiguration(process.env)');
      expect(source).toMatch(/createEngine\(\{[\s\S]*?providerExecutionEnabled[\s\S]*?\}\)/);
      expect(source).toMatch(/createEngine\(\{[\s\S]*?executionScope[\s\S]*?\}\)/);
      expect(source.indexOf('readProviderExecutionConfiguration(process.env)')).toBeLessThan(
        source.indexOf('createEngine({'),
      );
      expect(source.indexOf('readExecutionScopeConfiguration(process.env)')).toBeLessThan(
        source.indexOf('createEngine({'),
      );
      if (name === 'worker') {
        expect(source).not.toContain('STRIPE_SECRET_KEY');
        expect(source).not.toContain('hostedBilling');
      }
    }
  });
});

describe('trusted runtime execution-scope configuration', () => {
  it('defaults self-hosting to unrestricted and permits qualification without I2V activation', () => {
    expect(readExecutionScopeConfiguration({})).toEqual({ profile: 'unrestricted' });
    expect(
      readExecutionScopeConfiguration({ OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1' }),
    ).toEqual({ profile: 'qualification-sg-v1' });
  });

  it('accepts a reviewed digest only for the qualification profile', () => {
    expect(
      readExecutionScopeConfiguration({
        OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: 'A'.repeat(64),
      }),
    ).toEqual({ profile: 'qualification-sg-v1', firstFrameSha256: 'a'.repeat(64) });
    expect(() =>
      readExecutionScopeConfiguration({
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: 'a'.repeat(64),
      }),
    ).toThrow();
  });

  it.each(['', 'qualified', 'qualification-sg-v1,HOST=wrong'])(
    'rejects invalid profile %s',
    (profile) => {
      expect(() => readExecutionScopeConfiguration({ OPENGEN_EXECUTION_SCOPE: profile })).toThrow();
    },
  );

  it.each(['', 'not-a-digest', 'a'.repeat(63), 'a'.repeat(65), ` ${'a'.repeat(64)}`])(
    'rejects invalid or empty pin %s',
    (pin) => {
      expect(() =>
        readExecutionScopeConfiguration({
          OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
          OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: pin,
        }),
      ).toThrow();
    },
  );
});
