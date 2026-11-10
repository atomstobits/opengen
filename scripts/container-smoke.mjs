import assert from 'node:assert/strict';

const origin = 'http://127.0.0.1:4310';
const health = await fetch(`${origin}/health`);
assert.equal(health.status, 200);
assert.equal((await health.json()).database, true);
const catalog = await fetch(`${origin}/v1/catalog`);
assert.equal(catalog.status, 200);
assert.ok((await catalog.json()).models.length > 0);
const generation = await fetch(`${origin}/v1/generations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
assert.equal(generation.status, 401, 'Anonymous generation must never reach a provider.');
const home = await fetch('http://127.0.0.1:4320');
assert.equal(home.status, 200);
assert.match(await home.text(), /OpenGen/);
console.log(
  'Container smoke passed: database, catalog, web and generation authentication; no provider call made.',
);
