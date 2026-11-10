// The MCP host serves this static resource before it has any job data.
export const jobResultHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>OpenGen private preview</title>
<style>
  :root {
    color-scheme: dark;
    --canvas: #071c16;
    --surface: #0d261e;
    --ink: #f7f6ec;
    --muted: #b0c3b6;
    --line: #b9d8c138;
    --accent: #d81757;
    --on-accent: #fff8f0;
    --signal: #94dde2;
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); font: 15px/1.45 "Avenir Next", "Segoe UI", sans-serif; }
  main { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .brand::before { content: ""; width: 8px; height: 8px; background: var(--accent); box-shadow: 3px 3px 0 var(--signal); }
  .label { color: var(--signal); font: 11px/1.25 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .body { padding: 14px 16px 16px; }
  .status { margin: 0; color: var(--muted); }
  .media { display: grid; gap: 14px; margin-top: 12px; max-height: 440px; overflow-y: auto; }
  .media:empty { display: none; }
  figure { margin: 0; min-width: 0; }
  video, img { display: block; width: 100%; max-height: 360px; object-fit: contain; background: var(--canvas); border-radius: 8px; }
  figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
  .kind { color: var(--muted); font-size: 13px; }
  a { padding: 7px 12px; border-radius: 6px; color: var(--on-accent); background: var(--accent); font-weight: 600; text-decoration: none; white-space: nowrap; }
  a:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
</style>
</head>
<body>
<main id="preview" aria-label="OpenGen private preview">
  <header><span class="brand">OpenGen</span><span class="label">Private result</span></header>
  <div class="body">
    <p class="status" id="status" role="status">Waiting for the job result…</p>
    <div class="media" id="media"></div>
  </div>
</main>
<script>
  (() => {
    const host = window.parent;
    const preview = document.getElementById('preview');
    const status = document.getElementById('status');
    const media = document.getElementById('media');
    const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    const videoTypes = new Set(['video/mp4', 'video/webm']);
    const cleanup = new Set();
    let hostOrigin;
    let openLinks = false;
    let nextId = 1;
    let openLinkId;
    let lastHeight = 0;

    function post(message) {
      host.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*');
    }
    function reportSize() {
      const height = Math.ceil(preview.getBoundingClientRect().height);
      if (hostOrigin === undefined || height <= 0 || height === lastHeight) return;
      lastHeight = height;
      post({ method: 'ui/notifications/size-changed', params: { height } });
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reportSize) : null;
    observer?.observe(preview);

    function clearMedia() {
      for (const dispose of cleanup) dispose();
    }
    function render(result) {
      clearMedia();
      const data = result?._meta?.openGenPreview;
      if (result?.isError || !data || !Array.isArray(data.media)) {
        status.textContent = 'Preview unavailable. Check this job in OpenGen.';
        return;
      }
      if (['pending', 'queued', 'submitting', 'running', 'submission-unknown'].includes(data.status)) {
        status.textContent = data.status === 'submission-unknown'
          ? 'Job acceptance is unresolved. Check this job again.'
          : 'The job is still processing. Check this job again when it finishes.';
        return;
      }
      if (!['available', 'ready', 'succeeded', 'partial'].includes(data.status)) {
        if (data.status === 'expired') status.textContent = 'This preview has expired.';
        else if (data.status === 'failed') status.textContent = 'This job has no delivered result.';
        else if (data.status === 'cancelled') status.textContent = 'This generation was cancelled.';
        else status.textContent = 'This job has no available preview.';
        return;
      }

      for (const item of data.media.slice(0, 20)) {
        if (typeof item?.url !== 'string' || typeof item.expiresAt !== 'string') continue;
        const isVideo = videoTypes.has(item.mediaType);
        if (!isVideo && !imageTypes.has(item.mediaType)) continue;
        const expiresAt = Date.parse(item.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
        let url;
        try { url = new URL(item.url); } catch { continue; }
        if (url.protocol !== 'https:' || url.username || url.password) continue;

        const figure = document.createElement('figure');
        const asset = document.createElement(isVideo ? 'video' : 'img');
        const caption = document.createElement('figcaption');
        const kind = document.createElement('span');
        const link = document.createElement('a');
        const label = isVideo ? 'Video' : 'Image';
        if (isVideo) {
          asset.controls = true;
          asset.playsInline = true;
          asset.preload = 'metadata';
          asset.setAttribute('aria-label', 'Generated video');
        } else {
          asset.alt = 'Generated image';
          asset.loading = 'lazy';
        }
        asset.addEventListener('error', () => {
          if (figure.isConnected) status.textContent = 'The preview could not load. You can open the file directly.';
        });
        kind.className = 'kind';
        kind.textContent = label;
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open ' + label.toLowerCase();

        function dispose() {
          clearTimeout(expiry);
          cleanup.delete(dispose);
          figure.remove();
          link.removeAttribute('href');
          asset.removeAttribute('src');
          if (isVideo) asset.load();
        }
        function expire() {
          dispose();
          if (!media.childElementCount) status.textContent = 'This preview link has expired. Check this job again.';
        }
        link.addEventListener('click', (event) => {
          if (Date.now() >= expiresAt) {
            event.preventDefault();
            expire();
          } else if (openLinks) {
            event.preventDefault();
            openLinkId = ++nextId;
            post({ id: openLinkId, method: 'ui/open-link', params: { url: url.href } });
          }
        });
        const expiry = setTimeout(expire, Math.min(expiresAt - Date.now(), 2147483647));
        cleanup.add(dispose);
        caption.append(kind, link);
        figure.append(asset, caption);
        media.append(figure);
        asset.src = url.href;
      }
      status.textContent = media.childElementCount
        ? data.status === 'partial' ? 'Some results are available.' : 'Your result is ready.'
        : 'There is no current preview. Check this job in OpenGen.';
    }

    if (host === window) {
      status.textContent = 'Open this preview from the OpenGen job tool.';
      return;
    }
    function receive(event) {
      if (event.source !== host || event.data?.jsonrpc !== '2.0') return;
      const message = event.data;
      if (hostOrigin === undefined) {
        if (message.id !== 1) return;
        if (message.result?.protocolVersion !== '2026-01-26') {
          status.textContent = 'Use the private result link in chat to open the file.';
          return;
        }
        hostOrigin = event.origin;
        openLinks = !!message.result.hostCapabilities?.openLinks;
        post({ method: 'ui/notifications/initialized', params: {} });
        reportSize();
        return;
      }
      if (event.origin !== hostOrigin) return;
      if (message.method === 'ping' && (typeof message.id === 'number' || typeof message.id === 'string')) {
        post({ id: message.id, result: {} });
      } else if (message.method === 'ui/notifications/tool-result') {
        render(message.params);
        reportSize();
      } else if (message.method === 'ui/notifications/tool-cancelled') {
        clearMedia();
        status.textContent = 'The preview request was cancelled.';
      } else if (message.method === 'ui/resource-teardown' && (typeof message.id === 'number' || typeof message.id === 'string')) {
        clearMedia();
        observer?.disconnect();
        window.removeEventListener('message', receive);
        post({ id: message.id, result: {} });
      } else if (openLinkId !== undefined && message.id === openLinkId) {
        openLinkId = undefined;
        if (message.error) status.textContent = 'This host could not open the file.';
      }
    }
    window.addEventListener('message', receive);
    post({
      id: 1,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'OpenGen private preview', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      },
    });
  })();
</script>
</body>
</html>`;
