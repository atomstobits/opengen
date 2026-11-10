const urls = process.argv.slice(2);
if (!urls.length) throw new Error('Provide at least one local HTTP health URL.');
for (const url of urls) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname))
    throw new Error('Readiness checks are restricted to local services.');
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* The process is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`Local service did not become ready: ${url}`);
  console.log(`Ready: ${url}`);
}
