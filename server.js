'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Higher configurable ceilings; large archives can use substantial phone RAM.
const MAX_RESOURCES = 600;
const MAX_PAGES = 100;
const MAX_DEPTH = 5;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20000;
const BODY_LIMIT = 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map();
const progressJobs = new Map();

function setProgress(id, percent, label, detail = '') {
  if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return;
  const now = Date.now();
  if (progressJobs.size > 100) {
    for (const [key, value] of progressJobs) {
      if (now - value.updatedAt > 10 * 60 * 1000) progressJobs.delete(key);
    }
  }
  progressJobs.set(id, { percent: Math.max(0, Math.min(100, Math.round(percent))), label, detail, updatedAt: now });
}

function getProgress(id) {
  const value = progressJobs.get(id);
  if (!value) return { percent: 0, label: 'Starting…', detail: '' };
  return value;
}

const MIME_BY_EXT = {
  '.wasm': 'WebAssembly', '.js': 'JavaScript', '.mjs': 'JavaScript',
  '.css': 'Stylesheet', '.html': 'HTML', '.htm': 'HTML',
  '.json': 'JSON / data', '.xml': 'XML / data', '.map': 'Source map',
  '.png': 'Image', '.jpg': 'Image', '.jpeg': 'Image', '.gif': 'Image',
  '.webp': 'Image', '.avif': 'Image', '.svg': 'Image', '.ico': 'Image',
  '.mp3': 'Audio', '.wav': 'Audio', '.ogg': 'Audio', '.m4a': 'Audio',
  '.mp4': 'Video', '.webm': 'Video', '.mov': 'Video',
  '.woff': 'Font', '.woff2': 'Font', '.ttf': 'Font', '.otf': 'Font',
  '.pdf': 'Document', '.txt': 'Text', '.csv': 'Data',
  '.bin': 'Binary / data', '.dat': 'Binary / data', '.pak': 'Game / app data',
  '.data': 'Game / app data', '.asset': 'Game / app data'
};

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function rateLimit(req, res) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start > RATE_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > RATE_MAX) {
    json(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
    return false;
  }
  return true;
}

function isPublicIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT
  if (a === 169 && b === 254) return false;                    // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;           // private
  if (a === 192 && b === 168) return false;                    // private
  if (a === 192 && b === 0 && c === 0) return false;           // IETF assignments
  if (a === 192 && b === 0 && c === 2) return false;           // documentation
  if (a === 198 && (b === 18 || b === 19)) return false;       // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;        // documentation
  if (a === 203 && b === 0 && c === 113) return false;         // documentation
  if (a === 192 && b === 88 && c === 99) return false;         // deprecated 6to4 relay
  if (a === 255) return false;
  return true;
}

async function resolvePublicIPv4(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new Error('Local and internal hostnames are not allowed.');
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion) {
    if (ipVersion !== 4 || !isPublicIPv4(normalized)) {
      throw new Error('Only public IPv4 destinations are allowed; private, reserved and IPv6 IP literals are blocked.');
    }
    return normalized;
  }

  let records;
  try {
    records = await dns.lookup(normalized, { all: true, verbatim: true, family: 4 });
  } catch {
    throw new Error('The hostname could not be resolved.');
  }
  if (!records.length) throw new Error('The hostname has no address records.');
  // Pin requests to validated IPv4 answers only. AAAA answers are ignored,
  // so dual-stack hosts remain usable without ever connecting over IPv6.
  const ipv4Records = records.filter(record => record.family === 4);
  if (!ipv4Records.length) throw new Error('The hostname has no supported public IPv4 address.');
  if (ipv4Records.some(record => !isPublicIPv4(record.address))) {
    throw new Error('The hostname resolves to a private or reserved IPv4 address.');
  }
  return ipv4Records[0].address;
}

async function validateTarget(raw, base) {
  let url;
  try { url = base ? new URL(raw, base) : new URL(raw); }
  catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  if (!url.hostname) throw new Error('URL hostname is missing.');
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Only standard web ports 80 and 443 are allowed.');
  }
  if ((url.protocol === 'https:' && url.port === '80') || (url.protocol === 'http:' && url.port === '443')) {
    throw new Error('The URL port does not match its HTTP/HTTPS scheme.');
  }
  url.hash = '';
  const address = await resolvePublicIPv4(url.hostname);
  return { url, address };
}

function fetchBuffer(rawUrl, options = {}) {
  const maxBytes = options.maxBytes || MAX_FILE_BYTES;
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

  return (async () => {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { url, address } = await validateTarget(current);
      if (url.protocol !== 'https:' && options.allowHttp !== true) {
        throw new Error('HTTP resources require explicit opt-in in the scan form.');
      }
      const transport = url.protocol === 'https:' ? https : http;
      const result = await new Promise((resolve, reject) => {
        const requestOptions = {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'User-Agent': 'WebXtract/4.0 (+local public-resource inspector)',
            'Accept': '*/*',
            'Accept-Encoding': 'identity'
          },
          agent: false,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions && lookupOptions.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          }
        };
        const req = transport.request(requestOptions, response => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.resume();
            if (!location) {
              reject(new Error('Remote redirect response did not include a Location header.'));
            } else {
              resolve({ redirect: location, status });
            }
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new Error(`Remote server returned HTTP ${status}.`));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new Error(`Response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers['content-type'] || ''),
            finalUrl: url.href,
            status
          }));
          response.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out.')));
        req.on('error', reject);
        req.end();
      });

      if (!result.redirect) return result;
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.');
      current = new URL(result.redirect, url).href;
      // The next loop validates and resolves every redirect destination again.
    }
    throw new Error('Redirect limit exceeded.');
  })();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function decodeEntities(value) {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function extractPageLinks(html, pageUrl) {
  const found = new Set();
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(['"])(.*?)\1/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const raw = decodeEntities(match[2].trim());
    if (!raw || raw.startsWith('#') || /^(?:javascript:|data:|blob:|mailto:|tel:)/i.test(raw)) continue;
    try {
      const absolute = new URL(raw, pageUrl);
      if (['http:', 'https:'].includes(absolute.protocol)) {
        absolute.hash = '';
        found.add(absolute.href);
      }
    } catch {}
  }
  found.delete(pageUrl);
  return [...found];
}

function extractCandidates(html, pageUrl) {
  // Collect actual resource-bearing attributes, not every navigation link.
  // Ordinary <a href="/wiki/..."> links are crawl targets, not downloadable files.
  const found = new Set();
  const baseMatch = html.match(/<base\b[^>]*href\s*=\s*(['"])(.*?)\1/i);
  let baseUrl = pageUrl;
  if (baseMatch) {
    try { baseUrl = new URL(decodeEntities(baseMatch[2]), pageUrl).href; } catch {}
  }

  const attrPattern = /\b(?:src|poster|data-src|data-href|data-lazy-src)\s*=\s*(['"])(.*?)\1/gi;
  let match;
  while ((match = attrPattern.exec(html)) !== null) {
    const raw = decodeEntities(match[2].trim());
    if (!raw || raw.startsWith('#') || /^(?:javascript:|data:|blob:|mailto:|tel:)/i.test(raw)) continue;
    try {
      const absolute = new URL(raw, baseUrl);
      if (['http:', 'https:'].includes(absolute.protocol)) {
        absolute.hash = '';
        found.add(absolute.href);
      }
    } catch {}
  }

  // Keep linked stylesheets, icons, preload and modulepreload resources.
  const linkPattern = /<link\b[^>]*>/gi;
  while ((match = linkPattern.exec(html)) !== null) {
    const tag = match[0];
    const hrefMatch = tag.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
    const relMatch = tag.match(/\brel\s*=\s*(['"])(.*?)\1/i);
    if (!hrefMatch || !relMatch) continue;
    const rel = relMatch[2].toLowerCase().split(/\s+/);
    if (!rel.some(x => ['stylesheet', 'icon', 'apple-touch-icon', 'preload', 'modulepreload', 'manifest'].includes(x))) continue;
    try {
      const absolute = new URL(decodeEntities(hrefMatch[2].trim()), baseUrl);
      if (['http:', 'https:'].includes(absolute.protocol)) {
        absolute.hash = '';
        found.add(absolute.href);
      }
    } catch {}
  }

  const srcsetPattern = /\bsrcset\s*=\s*(['"])(.*?)\1/gi;
  while ((match = srcsetPattern.exec(html)) !== null) {
    for (const entry of match[2].split(',')) {
      const raw = entry.trim().split(/\s+/)[0];
      try {
        const absolute = new URL(decodeEntities(raw), baseUrl);
        if (['http:', 'https:'].includes(absolute.protocol)) {
          absolute.hash = '';
          found.add(absolute.href);
        }
      } catch {}
    }
  }
  found.delete(pageUrl);
  return [...found];
}

function categoryFor(url, contentType = '') {
  const pathname = new URL(url).pathname.toLowerCase();
  const ext = path.extname(pathname);
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const mime = contentType.toLowerCase();
  if (mime.includes('javascript')) return 'JavaScript';
  if (mime.includes('css')) return 'Stylesheet';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.includes('wasm')) return 'WebAssembly';
  if (mime.includes('font')) return 'Font';
  if (mime.includes('json')) return 'JSON / data';
  return 'Other';
}

function safeFilename(url, index) {
  let name = path.posix.basename(new URL(url).pathname) || `resource-${index}`;
  try { name = decodeURIComponent(name); } catch {}
  name = name.normalize('NFKC').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  if (!name || name === '.' || name === '..') name = `resource-${index}.bin`;
  return `${String(index).padStart(2, '0')}-${name}`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

async function crc32Async(buffer, onProgress) {
  let crc = 0xffffffff;
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const end = Math.min(buffer.length, offset + chunkSize);
    for (let i = offset; i < end; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    if (onProgress) onProgress(end, buffer.length);
    // Yield to the event loop so progress polling and the UI can keep updating.
    await new Promise(resolve => setImmediate(resolve));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  }));
  return results;
}

async function makeZip(entries, progressId = '') {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let processedBytes = 0;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = await crc32Async(data, (done, size) => {
      const overall = processedBytes + done;
      const pct = 68 + Math.round(27 * overall / Math.max(1, totalBytes));
      setProgress(progressId, pct, 'Assembling ZIP archive',
        `${index + 1} of ${entries.length} entries · ${(overall / 1024 / 1024).toFixed(1)} of ${(totalBytes / 1024 / 1024).toFixed(1)} MB processed`);
    });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
    processedBytes += data.length;
    const percent = 68 + Math.round(27 * (index + 1) / entries.length);
    setProgress(progressId, percent, 'Assembling ZIP archive',
      `${index + 1} of ${entries.length} entries · ${(processedBytes / 1024 / 1024).toFixed(1)} of ${(totalBytes / 1024 / 1024).toFixed(1)} MB processed`);
    await new Promise(resolve => setImmediate(resolve));
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  setProgress(progressId, 96, 'Finalizing ZIP archive', 'Combining archive records');
  await new Promise(resolve => setImmediate(resolve));
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function extractTextReferences(text, pageUrl, kind) {
  const found = new Set();
  const patterns = kind === 'css'
    ? [/url\(\s*["']?([^"')]+)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi]
    : [/\b(?:src|href|url|asset|file|wasm|worker)\s*[:=]\s*["']([^"']+)["']/gi,
       /import\s*\(\s*["']([^"']+)["']\s*\)/gi,
       /(?:import|from)\s*["']([^"']+)["']/gi];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const raw = decodeEntities(m[1].trim());
      if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) continue;
      try { const u = new URL(raw, pageUrl); if (['http:', 'https:'].includes(u.protocol)) { u.hash = ''; found.add(u.href); } } catch {}
    }
  }
  return [...found];
}

function looksLikePage(url, contentType = '') {
  const p = new URL(url).pathname.toLowerCase();
  return contentType.includes('text/html') || contentType.includes('application/xhtml') || !path.extname(p) || /\.(?:html?|php|aspx?)$/i.test(p);
}

async function scanWebsite(startUrl, options = {}, progressId = '') {
  const allowHttp = options.allowHttp === true;
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 20, MAX_PAGES));
  const requestedDepth = Number(options.depth);
  const maxDepth = Math.max(0, Math.min(Number.isFinite(requestedDepth) ? requestedDepth : 2, MAX_DEPTH));
  const maxResources = Math.max(1, Math.min(Number(options.maxResources) || MAX_RESOURCES, MAX_RESOURCES));
  const start = new URL(startUrl);
  const queue = [{ url: start.href, depth: 0 }];
  const queued = new Set([start.href]);
  const visited = new Set();
  const found = new Map();
  const errors = [];
  let totalPageBytes = 0;
  const report = (percent, label, detail = '') => setProgress(progressId, percent, label, detail);
  report(3, 'Validating website', 'Checking the public destination');

  function add(url, sourcePage, typeHint = '') {
    if (found.size >= maxResources || found.has(url)) return;
    let u; try { u = new URL(url); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol)) return;
    found.set(url, { url, sourcePage, category: categoryFor(url, typeHint), status: 'Discovered', host: u.hostname });
  }

  // Crawl in small parallel batches. Bounded concurrency avoids a long serial wait
  // while keeping mobile memory/network usage reasonable.
  while (queue.length && visited.size < maxPages && found.size < maxResources) {
    report(10 + Math.min(48, Math.round((visited.size / maxPages) * 48)), 'Fetching website pages', `${visited.size} of up to ${maxPages} pages visited`);
    const batch = [];
    while (queue.length && batch.length < 4 && visited.size + batch.length < maxPages) {
      const item = queue.shift();
      if (!visited.has(item.url)) { visited.add(item.url); batch.push(item); }
    }
    const pages = await mapLimit(batch, 4, async item => {
      const page = await fetchBuffer(item.url, { maxBytes: MAX_SCAN_BYTES, allowHttp, timeoutMs: 12000 });
      const ct = (page.contentType || '').toLowerCase();
      const text = page.buffer.toString('utf8');
      return { item, page, ct, text, isHtml: looksLikePage(page.finalUrl, ct) };
    });
    for (const result of pages) {
      if (!result || result.error) {
        const item = batch[pages.indexOf(result)];
        if (item) errors.push({ url: item.url, error: result?.error?.message || 'Page fetch failed.' });
        continue;
      }
      const { item, page, ct, text, isHtml } = result;
      totalPageBytes += page.buffer.length;
      if (isHtml) {
        // Crawl ordinary same-host navigation links, but do not list them as files.
        for (const candidate of extractPageLinks(text, page.finalUrl)) {
          let u; try { u = new URL(candidate); } catch { continue; }
          if (u.hostname === start.hostname && item.depth < maxDepth && looksLikePage(candidate)) {
            if (!queued.has(candidate) && visited.size + queue.length < maxPages) {
              queued.add(candidate); queue.push({ url: candidate, depth: item.depth + 1 });
            }
          }
        }
        // Only resource-bearing tags/attributes are added to the downloadable list.
        for (const candidate of extractCandidates(text, page.finalUrl)) {
          add(candidate, page.finalUrl);
        }
        if (page.finalUrl !== start.href) add(page.finalUrl, 'Crawled page', 'text/html');
      } else if (ct.includes('text/css') || /\.css(?:$|\?)/i.test(page.finalUrl)) {
        for (const candidate of extractTextReferences(text, page.finalUrl, 'css')) add(candidate, page.finalUrl);
      } else if (ct.includes('javascript') || /\.(?:m?js)(?:$|\?)/i.test(page.finalUrl)) {
        for (const candidate of extractTextReferences(text, page.finalUrl, 'js')) add(candidate, page.finalUrl);
      }
    }
  }

  // Parse linked CSS/JS concurrently; do not make up to 100 serial network waits.
  const assetQueue = [...found.values()].filter(x => /\.(?:css|m?js)(?:$|\?)/i.test(x.url)).slice(0, 120);
  report(62, 'Inspecting CSS and JavaScript', `${assetQueue.length} linked files queued`);
  const assetResults = await mapLimit(assetQueue, 6, async asset => {
    const fetched = await fetchBuffer(asset.url, { maxBytes: 2 * 1024 * 1024, allowHttp, timeoutMs: 10000 });
    const content = fetched.buffer.toString('utf8');
    const isCss = /\.css(?:$|\?)/i.test(asset.url) || (fetched.contentType || '').includes('text/css');
    return { asset, refs: extractTextReferences(content, fetched.finalUrl, isCss ? 'css' : 'js') };
  });
  for (const result of assetResults) {
    if (result?.error) continue;
    for (const ref of result.refs) add(ref, result.asset.url);
  }

  // Validation is concurrent too. The URL is still revalidated again at download time.
  const entries = [...found.values()];
  let checkedCount = 0;
  report(82, 'Checking discovered resources', `${entries.length} resources found`);
  const checks = await mapLimit(entries, 8, async entry => {
    const checked = await validateTarget(entry.url);
    if (checked.url.protocol !== 'https:' && !allowHttp) throw new Error('HTTP requires opt-in.');
    checkedCount += 1;
    if (checkedCount % 8 === 0 || checkedCount === entries.length) report(82 + Math.round(16 * checkedCount / Math.max(1, entries.length)), 'Checking discovered resources', `${checkedCount} of ${entries.length} checked`);
    return true;
  });
  const resources = entries.map((entry, index) => {
    const error = checks[index]?.error;
    const id = index + 1;
    return { id, ...entry, status: error ? `Blocked: ${error.message}` : 'Discovered', filename: safeFilename(entry.url, id) };
  });
  report(100, 'Scan complete', `${visited.size} pages · ${resources.length} resources`);
  return { pageUrl: start.href, pagesVisited: visited.size, pageBytes: totalPageBytes, resources, errors, limits: { maxPages, maxDepth, maxResources }, note: 'V4.1.1 uses bounded parallel page, asset and destination checks. Deep crawl cannot see resources only requested after browser interaction; Browser scan requires optional Playwright.' };
}

async function browserScan(startUrl, options = {}, progressId = '') {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('Browser scan needs Playwright. On supported Linux/Windows: npm install, then npx playwright install chromium. On Termux, use Deep crawl; browser installation may not be supported on your device.'); }
  const allowHttp = options.allowHttp === true;
  const start = new URL(startUrl);
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 10, 40));
  setProgress(progressId, 5, 'Launching browser', 'Starting the optional browser engine');
  const collected = new Map();
  const pages = new Set([start.href]);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    await page.route('**/*', async route => {
      const req = route.request(); const raw = req.url();
      if (/^(?:data:|blob:|about:|chrome:|devtools:)/i.test(raw)) return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' } });
      // Read-only GETs are fetched by the pinned-IP server proxy, not Chromium.
      // This prevents the browser from independently resolving a potentially rebinding hostname.
      if (req.method() !== 'GET') return route.abort('blockedbyclient');
      try {
        const checked = await validateTarget(raw);
        if (checked.url.protocol !== 'https:' && !allowHttp) return route.abort('blockedbyclient');
        if (req.isNavigationRequest() && checked.url.hostname !== start.hostname) return route.abort('blockedbyclient');
        const fetched = await fetchBuffer(checked.url.href, { maxBytes: MAX_FILE_BYTES, allowHttp, timeoutMs: 20000 });
        return route.fulfill({ status: fetched.status || 200, body: fetched.buffer, headers: {
          'content-type': fetched.contentType || 'application/octet-stream',
          'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': '*', 'cache-control': 'no-store'
        } });
      } catch { return route.abort('blockedbyclient'); }
    });
    page.on('response', response => {
      try {
        const u = new URL(response.url());
        if (!['http:', 'https:'].includes(u.protocol)) return;
        const ct = response.headers()['content-type'] || '';
        if (!collected.has(u.href) && collected.size < MAX_RESOURCES) collected.set(u.href, { url: u.href, sourcePage: 'Browser runtime', category: categoryFor(u.href, ct), host: u.hostname, status: response.ok() ? 'Discovered' : `HTTP ${response.status()}` });
      } catch {}
    });
    setProgress(progressId, 15, 'Loading website in browser', start.hostname);
    await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    setProgress(progressId, 45, 'Capturing runtime requests', 'Waiting for initial network activity');
    await page.waitForTimeout(5000);
    // Scroll in steps to trigger lazy-loaded images and media.
    for (let i = 0; i < 6; i++) { setProgress(progressId, 50 + i * 4, 'Triggering lazy-loaded resources', `Scroll pass ${i + 1} of 6`); await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 600))); await page.waitForTimeout(500); }
    const pageQueue = [start.href];
    const visitedPages = new Set();
    while (pageQueue.length && visitedPages.size < maxPages && collected.size < MAX_RESOURCES) {
      const pageUrl = pageQueue.shift();
      if (visitedPages.has(pageUrl)) continue;
      visitedPages.add(pageUrl);
      setProgress(progressId, 75 + Math.round(20 * visitedPages.size / maxPages), 'Inspecting linked pages', `${visitedPages.size} pages visited`);
      try {
        if (page.url() !== pageUrl) await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1600);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(400);
        const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(n => n.href));
        for (const link of links) {
          try { const u = new URL(link); u.hash = ''; if (u.hostname === start.hostname && ['http:', 'https:'].includes(u.protocol) && !visitedPages.has(u.href) && pages.size < maxPages) { pages.add(u.href); pageQueue.push(u.href); } } catch {}
        }
      } catch {}
    }
    setProgress(progressId, 100, 'Browser scan complete', `${visitedPages.size} pages · ${collected.size} resources`);
    return { pageUrl: start.href, pagesVisited: visitedPages.size, pageBytes: 0, resources: [...collected.values()].map((x, i) => ({ id: i + 1, ...x, filename: safeFilename(x.url, i + 1) })), errors: [], note: 'Browser scan records network responses observed during page load, a short wait, scrolling and same-host link visits. It cannot discover every conditional or interaction-gated request.' };
  } finally { await browser.close(); }
}

async function downloadZip(urls, allowHttp = false, progressId = '') {
  if (!Array.isArray(urls) || urls.length < 1) throw new Error('Select at least one resource.');
  if (urls.length > MAX_RESOURCES) throw new Error(`A maximum of ${MAX_RESOURCES} resources can be downloaded at once.`);
  const uniqueUrls = [...new Set(urls.map(value => String(value)))];
  let fetchedCount = 0;
  setProgress(progressId, 3, 'Fetching and validating files', `0 of ${uniqueUrls.length} downloaded · up to 20 MB each`);
  const results = await mapLimit(uniqueUrls, 4, async raw => {
    const result = await fetchBuffer(raw, { maxBytes: MAX_FILE_BYTES, allowHttp, timeoutMs: 15000 });
    fetchedCount += 1;
    setProgress(progressId, 3 + Math.round(62 * fetchedCount / uniqueUrls.length), 'Fetching and validating files', `${fetchedCount} of ${uniqueUrls.length} downloaded`);
    return result;
  });
  const entries = [];
  const manifest = [];
  const failures = [];
  let total = 0;
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result || result.error) {
      failures.push({ sourceUrl: uniqueUrls[i], error: result?.error?.message || 'unknown error' });
      continue;
    }
    if (total + result.buffer.length > MAX_TOTAL_BYTES) {
      failures.push({ sourceUrl: uniqueUrls[i], error: 'Skipped: adding this file would exceed the 150 MB total limit.' });
      continue;
    }
    total += result.buffer.length;
    const filename = safeFilename(result.finalUrl, i + 1);
    entries.push({ name: filename, data: result.buffer });
    manifest.push({ filename, sourceUrl: result.finalUrl, contentType: result.contentType || 'unknown', category: categoryFor(result.finalUrl, result.contentType), sizeBytes: result.buffer.length });
  }
  if (!entries.length) {
    const first = failures[0];
    throw new Error(first ? `No files could be added to the ZIP. First failure: ${first.sourceUrl}: ${first.error}` : 'No downloadable files were returned.');
  }
  setProgress(progressId, 67, 'Preparing ZIP archive',
    `${entries.length} files included · ${failures.length} skipped · ${(total / 1024 / 1024).toFixed(1)} MB to package`);
  const manifestText = JSON.stringify({
    generatedBy: 'WebXtract Universal Web Inspector 4.3.1',
    generatedAt: new Date().toISOString(),
    note: 'Only publicly accessible resources requested by the user are included.',
    resources: manifest,
    skipped: failures
  }, null, 2);
  entries.push({ name: 'manifest.json', data: Buffer.from(manifestText) });
  const archive = await makeZip(entries, progressId);
  setProgress(progressId, 97, 'ZIP ready · sending to browser',
    `${manifest.length} files included · ${failures.length} skipped · ${(archive.length / 1024 / 1024).toFixed(1)} MB`);
  return archive;
}

function serveStatic(req, res, pathname) {
  const routes = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/styles.css': 'styles.css',
    '/app.js': 'app.js'
  };
  const file = routes[pathname];
  if (!file) return json(res, 404, { error: 'Not found.' });
  const full = path.join(ROOT, file);
  fs.readFile(full, (error, data) => {
    if (error) return json(res, 500, { error: 'Could not read application file.' });
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' :
      file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Progress polling is local, read-only status traffic; don't let it consume
  // the user's scan/download request budget.
  if (requestUrl.pathname !== '/progress' && !rateLimit(req, res)) return;
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    return json(res, 200, {
      status: 'online',
      name: 'WebXtract Universal Web Inspector',
      version: '4.3.1',
      host: HOST,
      limits: { maxResources: MAX_RESOURCES, maxPages: MAX_PAGES, maxDepth: MAX_DEPTH, maxScanBytes: MAX_SCAN_BYTES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, configurableScanResources: true, browserScan: (() => { try { require.resolve('playwright'); return true; } catch { return false; } })() }
    });
  }
  if (req.method === 'GET' && requestUrl.pathname === '/progress') {
    const id = requestUrl.searchParams.get('id') || '';
    return json(res, 200, getProgress(id));
  }

  // Local server-side proxy: the browser talks to localhost, while Node fetches
  // the public remote URL. This avoids browser CORS restrictions for permitted
  // public resources; it does not bypass authentication, DRM or access controls.
  if (req.method === 'GET' && requestUrl.pathname === '/proxy') {
    try {
      const targetValue = requestUrl.searchParams.get('url');
      if (!targetValue) throw new Error('Missing url query parameter.');
      const allowHttp = requestUrl.searchParams.get('allowHttp') === '1';
      const target = await validateTarget(targetValue);
      if (target.url.protocol !== 'https:' && !allowHttp) {
        throw new Error('HTTP proxying requires allowHttp=1 and should only be used for a site you trust.');
      }
      const result = await fetchBuffer(target.url.href, { maxBytes: MAX_FILE_BYTES, allowHttp });
      res.writeHead(200, {
        'Content-Type': result.contentType || 'application/octet-stream',
        'Content-Length': result.buffer.length,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end(result.buffer);
    } catch (error) {
      return json(res, 400, { error: error.message || 'Proxy request failed.' });
    }
  }

  if (req.method === 'OPTIONS' && requestUrl.pathname === '/proxy') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }

  if (req.method === 'GET') return serveStatic(req, res, requestUrl.pathname);

  if (req.method === 'POST' && requestUrl.pathname === '/scan') {
    try {
      const body = await readJson(req);
      const progressId = String(req.headers['x-progress-id'] || '');
      setProgress(progressId, 1, 'Starting scan', 'Preparing website inspection');
      if (typeof body.url !== 'string') throw new Error('Enter a website URL.');
      const target = await validateTarget(body.url);
      if (target.url.protocol !== 'https:' && body.allowHttp !== true) {
        throw new Error('For safety, scanning requires HTTPS. Enable the HTTP option only for a site you trust.');
      }
      const result = await scanWebsite(target.url.href, body, progressId);
      return json(res, 200, result);
    } catch (error) {
      setProgress(String(req.headers['x-progress-id'] || ''), 100, 'Scan failed', error.message || 'Scan failed');
      return json(res, 400, { error: error.message || 'Scan failed.' });
    }
  }

  if (req.method === 'POST' && requestUrl.pathname === '/browser-scan') {
    try {
      const body = await readJson(req);
      const progressId = String(req.headers['x-progress-id'] || '');
      setProgress(progressId, 1, 'Starting browser scan', 'Preparing browser inspection');
      if (typeof body.url !== 'string') throw new Error('Enter a website URL.');
      const target = await validateTarget(body.url);
      if (target.url.protocol !== 'https:' && body.allowHttp !== true) throw new Error('Browser scan requires HTTPS unless HTTP is explicitly enabled.');
      const result = await browserScan(target.url.href, body, progressId);
      return json(res, 200, result);
    } catch (error) { setProgress(String(req.headers['x-progress-id'] || ''), 100, 'Browser scan failed', error.message || 'Browser scan failed'); return json(res, 400, { error: error.message || 'Browser scan failed.' }); }
  }

  if (req.method === 'POST' && requestUrl.pathname === '/download-zip') {
    try {
      const body = await readJson(req);
      const progressId = String(req.headers['x-progress-id'] || '');
      const zip = await downloadZip(body.urls, body.allowHttp === true, progressId);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="webxtract-resources.zip"',
        'Content-Length': zip.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      return res.end(zip);
    } catch (error) {
      setProgress(String(req.headers['x-progress-id'] || ''), 100, 'ZIP failed', error.message || 'ZIP creation failed');
      return json(res, 400, { error: error.message || 'ZIP creation failed.' });
    }
  }

  return json(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`WebXtract Universal Web Inspector 4.3.1`);
  console.log(`Local UI: http://${HOST}:${PORT}/`);
  console.log(`Health:   http://${HOST}:${PORT}/health`);
  console.log(`Listening only on ${HOST}. Set HOST explicitly if you understand the network exposure risk.`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3002 node server.js`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
