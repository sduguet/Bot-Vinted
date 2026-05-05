import https from 'https';
import http  from 'http';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Cookie cache (mémoire, dure le temps de l'instance Vercel) ──────────────
let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function fetchRaw(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Trop de redirections'));
    const lib = url.startsWith('https') ? https : http;
    const { headers = {}, method = 'GET' } = options;
    const req = lib.request(url, { method, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.vinted.fr${res.headers.location}`;
        // Accumulate Set-Cookie across redirects
        const setCookies = res.headers['set-cookie'] || [];
        res.resume();
        return fetchRaw(next, { ...options, headers: { ...headers } }, redirectCount + 1)
          .then(r => resolve({ ...r, setCookies: [...setCookies, ...(r.setCookies || [])] }))
          .catch(reject);
      }
      let data = Buffer.alloc(0);
      res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: data.toString('utf8'),
        headers: res.headers,
        setCookies: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout (15s)')); });
    req.end();
  });
}

// ── Obtenir un cookie de session anonyme depuis Vinted ──────────────────────
async function getVintedCookie() {
  if (cachedCookie && Date.now() - cookieFetchedAt < COOKIE_TTL_MS) {
    return cachedCookie;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  const result = await fetchRaw('https://www.vinted.fr', { headers });
  const allCookies = result.setCookies || [];

  if (!allCookies.length) {
    throw new Error('Impossible d\'obtenir un cookie depuis Vinted');
  }

  // Parse et recomposer le cookie string (nom=valeur seulement)
  const cookieParts = allCookies
    .map(c => c.split(';')[0].trim())
    .filter(Boolean);

  cachedCookie = cookieParts.join('; ');
  cookieFetchedAt = Date.now();
  return cachedCookie;
}

// ── Requête vers l'API catalogue Vinted ─────────────────────────────────────
function fetchUrl(url, headers, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Trop de redirections'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.vinted.fr${res.headers.location}`;
        res.resume();
        return fetchUrl(next, headers, redirectCount + 1).then(resolve).catch(reject);
      }
      // Mettre à jour le cache cookie si Vinted en envoie de nouveaux
      const newCookies = res.headers['set-cookie'];
      if (newCookies && newCookies.length) {
        const parts = newCookies.map(c => c.split(';')[0].trim()).filter(Boolean);
        // Fusionner avec le cookie existant
        const existing = (cachedCookie || '').split('; ').filter(Boolean);
        const map = {};
        existing.forEach(p => { const [k] = p.split('='); map[k] = p; });
        parts.forEach(p => { const [k] = p.split('='); map[k] = p; });
        cachedCookie = Object.values(map).join('; ');
        cookieFetchedAt = Date.now();
      }
      let data = Buffer.alloc(0);
      res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      res.on('end', () => resolve({ status: res.statusCode, body: data.toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout (15s)')); });
  });
}

function buildHeaders(cookie, searchText) {
  return {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Referer':         `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(searchText || '')}`,
    'Origin':          'https://www.vinted.fr',
    'DNT':             '1',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'same-origin',
    'Cookie':          cookie,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { search_text, price_from, price_to, per_page, order } = req.query;

  let cookie;
  try {
    cookie = await getVintedCookie();
  } catch (err) {
    return res.status(503).json({ error: 'Impossible d\'obtenir un cookie Vinted', detail: err.message });
  }

  const params = new URLSearchParams({
    search_text: search_text || '',
    catalog_ids: '',
    price_from:  price_from  || '',
    price_to:    price_to    || '',
    per_page:    per_page    || 15,
    order:       order       || 'newest_first',
  });

  const url = `https://www.vinted.fr/api/v2/catalog/items?${params}`;

  try {
    const result = await fetchUrl(url, buildHeaders(cookie, search_text));

    if (result.status === 200) {
      try {
        return res.json(JSON.parse(result.body));
      } catch {
        return res.status(500).json({ error: 'Réponse Vinted non-JSON', raw: result.body.slice(0, 300) });
      }
    }

    // Si 401/403 : vider le cache cookie pour forcer un nouveau au prochain appel
    if ([401, 403].includes(result.status)) {
      cachedCookie = null;
      cookieFetchedAt = 0;
    }

    return res.status(result.status).json({
      error: `Vinted a répondu ${result.status}`,
      detail: result.body.slice(0, 300),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
