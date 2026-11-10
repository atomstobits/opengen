import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// A new local installation only. Never replace an existing operator configuration.
const root = new URL('../', import.meta.url);
const destination = new URL('.env', root);
const password = randomBytes(24).toString('hex');
const values = {
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgresql://opengen:${password}@127.0.0.1:5432/opengen`,
  MR_API_TOKEN: randomBytes(32).toString('hex'),
  MR_VAULT_KEY: randomBytes(32).toString('hex'),
  MR_SESSION_SECRET: randomBytes(48).toString('hex'),
  MR_WORKSPACE_ID: 'local',
  MR_INITIAL_BALANCE_MICROS: '0',
  OPENGEN_PUBLIC_URL: 'http://127.0.0.1:4320',
};
let text = await readFile(new URL('.env.example', root), 'utf8');
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  text = pattern.test(text)
    ? text.replace(pattern, `${key}=${value}`)
    : `${text}\n${key}=${value}\n`;
}
try {
  await writeFile(destination, text, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with private file permissions. No values printed.');
  console.log(
    'No credit was added. Review provider settings and deliberate spending limits before generation.',
  );
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env already exists; left unchanged. Edit the existing file privately.');
    process.exitCode = 1;
  } else throw error;
}
