/**
 * Railway.com Zero-Dependency Production Server: server.js
 * Listens on `process.env.PORT || 3000` on `0.0.0.0` and automatically detects
 * `RAILWAY_PUBLIC_DOMAIN` or `x-forwarded-host` for domain-scoped XML sitemaps.
 *
 * Routes:
 *   - GET /health                            -> 200 OK JSON healthcheck for Railway.com
 *   - GET /sitemap.xml (or /api/sitemap.xml) -> 200 OK application/xml; charset=UTF-8
 *   - GET /atom.xml (or /feed.xml, /atom)    -> 200 OK application/atom+xml; charset=UTF-8
 *   - GET / (with query parameters)          -> 200 OK public/index.html (Vanilla HTML CSR)
 *   - Unknown paths                          -> 404 Not Found public/index.html (CSR 404 view)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BUNBUN_API_BASE = process.env.BUNBUN_API_BASE || 'https://bunbunserver.my.id';

const PUBLIC_INDEX = path.join(__dirname, 'public', 'index.html');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const INDEX_HTML_CACHE = fs.existsSync(PUBLIC_INDEX)
  ? fs.readFileSync(PUBLIC_INDEX, 'utf8')
  : fs.readFileSync(ROOT_INDEX, 'utf8');

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveHost(headers = {}) {
  const raw =
    headers['x-forwarded-host'] ||
    headers.host ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    'localhost';
  return String(raw).split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

function resolveOrigin(headers = {}, host = 'localhost') {
  const rawProto = headers['x-forwarded-proto'] || 'https';
  const proto = String(rawProto).split(',')[0].trim();
  const scheme = (host === 'localhost' || host === '127.0.0.1') ? 'http' : (proto || 'https');
  return `${scheme}://${host}`;
}

async function handleSitemapXml(reqUrl, host, origin, res) {
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const domainParam = (reqUrl.searchParams.get('domain') || (isLocal ? 'all' : host)).trim();
  const dbParam = (reqUrl.searchParams.get('db') || reqUrl.searchParams.get('category') || 'all').trim();
  const rawLimit = parseInt(reqUrl.searchParams.get('limit') || '500', 10);
  const limitParam = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50000) : 500;

  const upstreamParams = new URLSearchParams({
    domain: domainParam,
    db: dbParam,
    limit: String(limitParam)
  });

  const upstreamUrl = `${BUNBUN_API_BASE}/sitemap.xml?${upstreamParams.toString()}`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/xml, text/xml, */*',
        Origin: origin,
        Referer: `${origin}/`,
        'User-Agent': 'Railway-CSR-Sitemap-Proxy/1.1'
      }
    });

    if (upstreamRes.ok) {
      const xmlBody = await upstreamRes.text();
      if (xmlBody && xmlBody.includes('<urlset')) {
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=UTF-8',
          'Cache-Control': 'no-store, must-revalidate',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(xmlBody);
        return;
      }
    }

    // Fallback Sitemap 0.9 XML builder if Railway domain is not yet active in allowed_domains.txt
    const fallbackLimit = Math.min(limitParam, 100);
    const randomParams = new URLSearchParams({ limit: String(fallbackLimit) });
    if (dbParam && dbParam !== 'all') {
      randomParams.set('category', dbParam);
    }

    const randomRes = await fetch(`${BUNBUN_API_BASE}/api/articles/random?${randomParams.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`
      }
    });

    const data = randomRes.ok ? await randomRes.json() : { articles: [] };
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const nowIso = new Date().toISOString();

    const entries = [
      `  <url>\n    <loc>${escapeXml(`${origin}/`)}</loc>\n    <lastmod>${nowIso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`
    ];

    for (const item of articles) {
      if (!item || !item.category || !item.slug) continue;
      const loc = `${origin}/?category=${encodeURIComponent(item.category)}&slug=${encodeURIComponent(item.slug)}`;
      const lastMod = item.updatedAt
        ? new Date(Number(item.updatedAt) * 1000).toISOString()
        : nowIso;
      entries.push(
        `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${escapeXml(lastMod)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
      );
    }

    const fallbackXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `${entries.join('\n')}\n` +
      `</urlset>`;

    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=UTF-8',
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(fallbackXml);
  } catch (err) {
    const emptyXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url>\n    <loc>${escapeXml(`${origin}/`)}</loc>\n  </url>\n` +
      `</urlset>`;
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=UTF-8',
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end(emptyXml);
  }
}

async function handleAtomXml(reqUrl, host, origin, res) {
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const domainParam = (reqUrl.searchParams.get('domain') || (isLocal ? 'all' : host)).trim();
  const dbParam = (reqUrl.searchParams.get('db') || reqUrl.searchParams.get('category') || 'all').trim();
  const rawLimit = parseInt(reqUrl.searchParams.get('limit') || '100', 10);
  const limitParam = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 100;

  const params = new URLSearchParams({
    domain: domainParam,
    db: dbParam,
    limit: String(limitParam)
  });

  try {
    const upstreamRes = await fetch(`${BUNBUN_API_BASE}/atom.xml?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/atom+xml, application/xml, text/xml',
        Origin: origin,
        Referer: `${origin}/`
      }
    });
    const body = await upstreamRes.text();
    res.writeHead(upstreamRes.ok ? 200 : 502, {
      'Content-Type': 'application/atom+xml; charset=UTF-8',
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, {
      'Content-Type': 'application/atom+xml; charset=UTF-8',
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end('Method Not Allowed');
    return;
  }

  const host = resolveHost(req.headers);
  const origin = resolveOrigin(req.headers, host);
  const reqUrl = new URL(req.url || '/', origin);
  const pathname = reqUrl.pathname || '/';

  // 1. Railway.com Healthcheck Endpoint (/health)
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'ok', host, timestamp: new Date().toISOString() }));
    return;
  }

  // 2. Dynamic XML Sitemap Route (application/xml)
  if (pathname === '/sitemap.xml' || pathname === '/api/sitemap.xml') {
    await handleSitemapXml(reqUrl, host, origin, res);
    return;
  }

  // 3. Dynamic Atom 1.0 Feed Route (application/atom+xml)
  if (pathname === '/atom.xml' || pathname === '/feed.xml' || pathname === '/atom' || pathname === '/api/atom.xml') {
    await handleAtomXml(reqUrl, host, origin, res);
    return;
  }

  // 4. Serve Vanilla HTML CSR Shell (HTTP 200 on `/` or `/index.html`, HTTP 404 on unknown paths)
  const isRootRoute = (pathname === '/' || pathname === '/index.html');
  res.writeHead(isRootRoute ? 200 : 404, {
    'Content-Type': 'text/html; charset=UTF-8',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(INDEX_HTML_CACHE);
});

server.listen(PORT, HOST, () => {
  console.log(`[Railway.com CSR Server] Listening on http://${HOST}:${PORT}`);
});
