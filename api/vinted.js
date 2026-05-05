import https from 'https';
import http  from 'http';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Cookie cache ─────────────────────────────────────────────────────────────
let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 8 * 60 * 1000; // 8 minutes

// ── HTTP helper ──────────────────────────────────────────────────────────────
function fetchRaw(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Trop de redirections'));
    const lib = url.startsWith('https') ? https : http;
    const { headers = {}, method = 'GET' } = options;

    const req = lib.request(url, { method, headers }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.vinted.fr${res.headers.location}`;
        res.resume();
        return fetchRaw(next, { ...options, headers }, redirectCount + 1)
          .then(r => resolve({ ...r, setCookies: [...setCookies, ...(r.setCookies || [])] }))
          .catch(reject);
      }

      let data = Buffer.alloc(0);
      res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: data.toString('utf8'),
        responseHeaders: res.headers,
        setCookies,
      }));
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout (20s)')); });
    req.end();
  });
}

// ── Parse Set-Cookie headers → objet clé/valeur ──────────────────────────────
function parseCookies(setCookieArray) {
  const map = {};
  for (const line of setCookieArray) {
    const part = line.split(';')[0].trim();
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

function cookieMapToString(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Obtenir un cookie de session valide ──────────────────────────────────────
async function getVintedCookie() {
  if (cachedCookie && Date.now() - cookieFetchedAt < COOKIE_TTL_MS) {
    return cachedCookie;
  }

  const baseHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'DNT':             '1',
    'Connection':      'keep-alive',
  };

  // Étape 1 : charger la page d'accueil → récupère les cookies de base
  const step1 = await fetchRaw('https://www.vinted.fr', {
    headers: {
      ...baseHeaders,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  let cookieMap = parseCookies(step1.setCookies || []);

  if (!Object.keys(cookieMap).length) {
    throw new Error('Vinted n\'a retourné aucun cookie à l\'étape 1');
  }

  // Courte pause pour simuler un vrai navigateur
  await new Promise(r => setTimeout(r, 800));

  // Étape 2 : appel à /api/v2/sessions pour obtenir _vinted_fr_session
  const step2 = await fetchRaw('https://www.vinted.fr/api/v2/sessions', {
    headers: {
      ...baseHeaders,
      'Accept':           'application/json, text/plain, */*',
      'Referer':          'https://www.vinted.fr/',
      'Origin':           'https://www.vinted.fr',
      'Sec-Fetch-Dest':   'empty',
      'Sec-Fetch-Mode':   'cors',
      'Sec-Fetch-Site':   'same-origin',
      'Cookie':           cookieMapToString(cookieMap),
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const newCookies2 = parseCookies(step2.setCookies || []);
  cookieMap = { ...cookieMap, ...newCookies2 };

  // Vérifier qu'on a bien _vinted_fr_session
  if (!cookieMap['_vinted_fr_session']) {
    // Étape 2b : essayer /api/v2/users/me comme fallback
    await new Promise(r => setTimeout(r, 400));
    const step2b = await fetchRaw('https://www.vinted.fr/api/v2/users/me', {
      headers: {
        ...baseHeaders,
        'Accept':         'application/json, text/plain, */*',
        'Referer':        'https://www.vinted.fr/',
        'Origin':         'https://www.vinted.fr',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cookie':         cookieMapToString(cookieMap),
      },
    });
    const newCookies2b = parseCookies(step2b.setCookies || []);
    cookieMap = { ...cookieMap, ...newCookies2b };
  }

  if (!cookieMap['_vinted_fr_session']) {
    throw new Error('Impossible d\'obtenir _vinted_fr_session depuis Vinted');
  }

  cachedCookie = cookieMapToString(cookieMap);
  cookieFetchedAt = Date.now();
  return cachedCookie;
}

// ── Requête catalogue ────────────────────────────────────────────────────────
function fetchCatalog(url, cookie, searchText) {
  const headers = {
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

  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      // Mettre à jour les cookies si Vinted en envoie de nouveaux
      const newCookies = res.headers['set-cookie'];
      if (newCookies && newCookies.length && cachedCookie) {
        const currentMap = {};
        cachedCookie.split('; ').forEach(p => {
          const eq = p.indexOf('=');
          if (eq !== -1) currentMap[p.slice(0, eq)] = p.slice(eq + 1);
        });
        const fresh = parseCookies(newCookies);
        cachedCookie = cookieMapToString({ ...currentMap, ...fresh });
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

// ── Handler Vercel ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { search_text, price_from, price_to, per_page, order } = req.query;

  let cookie;
  try {
    cookie = await getVintedCookie();
  } catch (err) {
    return res.status(503).json({
      error: 'Impossible d\'obtenir un cookie Vinted',
      detail: err.message,
    });
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
    const result = await fetchCatalog(url, cookie, search_text);

    if (result.status === 200) {
      try {
        return res.json(JSON.parse(result.body));
      } catch {
        return res.status(500).json({ error: 'Réponse Vinted non-JSON', raw: result.body.slice(0, 300) });
      }
    }

    // Cookie invalide → vider le cache pour forcer un renouvellement
    if ([401, 403].includes(result.status)) {
      cachedCookie = null;
      cookieFetchedAt = 0;
    }

    return res.status(result.status).json({
      error: `Vinted a répondu ${result.status}`,
      detail: result.body.slice(0, 500),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}