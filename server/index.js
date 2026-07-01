// Tiny CORS/mixed-content proxy for IPTV streams.
//
// Browsers block cross-origin HLS playback when the stream's CDN doesn't send
// Access-Control-Allow-Origin (e.g. Toffee), and they hard-block http:// streams
// on an https:// page (mixed content). This server fetches those streams on the
// frontend's behalf, rewrites HLS manifests so every segment also routes back
// through here, and re-serves everything with permissive CORS — solving both
// problems at once.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PORT = process.env.PORT || 8787;
const REQUEST_TIMEOUT_MS = 15000;
const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function sendCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
}

// Basic SSRF guard: refuse to fetch internal/private network targets. Not a
// substitute for running this behind a proper egress firewall in production,
// but stops the common cases of someone pointing the proxy at localhost/LAN.
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local')) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

function parseTargetUrl(rawUrl) {
  if (!rawUrl) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (isBlockedHost(target.hostname)) return null;
  return target;
}

function fetchUpstream(target, extraHeaders = {}) {
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      target,
      {
        headers: {
          'User-Agent': UPSTREAM_USER_AGENT,
          Accept: '*/*',
          ...extraHeaders,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (upstreamRes) => resolve(upstreamRes)
    );
    req.on('timeout', () => req.destroy(new Error('Upstream request timed out')));
    req.on('error', reject);
  });
}

function proxiedUrl(kind, absoluteUrl, cookie) {
  let url = `/proxy/${kind}?url=${encodeURIComponent(absoluteUrl)}`;
  if (cookie) url += `&cookie=${encodeURIComponent(cookie)}`;
  return url;
}

// Rewrites every URI line in an HLS manifest (master or media playlist) to
// route back through this proxy, resolving relative URLs against the
// manifest's own location first. The cookie (if the channel needs one, e.g.
// Toffee's signed Edge-Cache-Cookie) is threaded through to every rewritten
// URL so sub-playlists and segments stay authenticated too.
function rewriteManifest(text, baseUrl, cookie) {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // #EXT-X-KEY / #EXT-X-MAP carry a URI="..." attribute that also needs rewriting.
    if (trimmed.startsWith('#')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const abs = new URL(uriMatch[1], baseUrl).toString();
        const kind = abs.includes('.m3u8') ? 'm3u8' : 'segment';
        return line.replace(uriMatch[1], proxiedUrl(kind, abs, cookie));
      }
      return line;
    }

    // A plain URI line: a variant playlist, a media segment, etc.
    const abs = new URL(trimmed, baseUrl).toString();
    const kind = abs.includes('.m3u8') ? 'm3u8' : 'segment';
    return proxiedUrl(kind, abs, cookie);
  });
  return out.join('\n');
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    sendCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (reqUrl.pathname === '/health') {
    sendCors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (reqUrl.pathname === '/proxy/m3u8') {
    const target = parseTargetUrl(reqUrl.searchParams.get('url'));
    if (!target) {
      sendCors(res);
      res.writeHead(400);
      res.end('Invalid or disallowed url');
      return;
    }
    const cookie = reqUrl.searchParams.get('cookie') || '';
    try {
      const upstream = await fetchUpstream(target, cookie ? { Cookie: cookie } : {});
      if (upstream.statusCode >= 400) {
        sendCors(res);
        res.writeHead(upstream.statusCode);
        res.end(`Upstream returned ${upstream.statusCode}`);
        return;
      }
      const chunks = [];
      for await (const chunk of upstream) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf-8');
      const rewritten = rewriteManifest(text, target.toString(), cookie);

      sendCors(res);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      });
      res.end(rewritten);
    } catch (err) {
      sendCors(res);
      res.writeHead(502);
      res.end(`Proxy fetch failed: ${err.message}`);
    }
    return;
  }

  if (reqUrl.pathname === '/proxy/segment') {
    const target = parseTargetUrl(reqUrl.searchParams.get('url'));
    if (!target) {
      sendCors(res);
      res.writeHead(400);
      res.end('Invalid or disallowed url');
      return;
    }
    try {
      const extraHeaders = {};
      if (req.headers.range) extraHeaders.Range = req.headers.range;
      const cookie = reqUrl.searchParams.get('cookie');
      if (cookie) extraHeaders.Cookie = cookie;
      const upstream = await fetchUpstream(target, extraHeaders);

      sendCors(res);
      const headers = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers[h]) headers[h] = upstream.headers[h];
      }
      res.writeHead(upstream.statusCode, headers);
      upstream.pipe(res);
    } catch (err) {
      sendCors(res);
      res.writeHead(502);
      res.end(`Proxy fetch failed: ${err.message}`);
    }
    return;
  }

  sendCors(res);
  res.writeHead(404);
  res.end('Not found');
});

const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`LiveTV stream proxy listening on http://${HOST}:${PORT}`);
});