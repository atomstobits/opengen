import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const name = 'gitleaks_8.30.1_linux_x64.tar.gz';
const line = readFileSync(join(directory, 'checksums.txt'), 'utf8')
  .split('\n')
  .find((value) => value.trim().endsWith(name));
const expected = line?.trim().split(/\s+/)[0];
const actual = createHash('sha256')
  .update(readFileSync(join(directory, 'gitleaks.tar.gz')))
  .digest('hex');
if (!expected || actual !== expected)
  throw new Error('Gitleaks archive checksum does not match the official release.');
console.log('Gitleaks archive checksum verified.');
