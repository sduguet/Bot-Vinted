import https from 'https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Auth "client iOS" (même méthode que vintedpy) ────────────────────────────
// Vinted expose un endpoint OAuth utilisé par son app iOS. En s'authentifiant
// comme ce client officiel, on récupère un Bearer token directement, sans
// avoir à simuler une session web complète (login, etc.).
const IOS_USER_AGENT = 'vinted-ios Vinted/22.6.1 (lt.manodrabuziai.fr; build:21794; iOS 15.2.0) iPhone10,6';
const APP_VERSION     = '22.6.1';
const DEVICE_MODEL    = 'iPhone10,6';

// ── Requêtes directes ─────────────────────────────────────────────────────────
// On appelle vinted.fr directement (plus de proxy tiers). Pour limiter les
// blocages anti-bot (Datadome / Cloudflare), on "bootstrap" d'abord une vraie
// session en visitant la page d'accueil pour récupérer les cookies qu'un
// navigateur/app obtiendrait normalement, puis on les réutilise sur toutes
// les requêtes suivantes (OAuth + catalogue). On les rafraîchit aussi à partir
// des en-têtes Set-Cookie renvoyés par chaque réponse.

let session = null;         // { access_token, refresh_token, expiration_date }
let cookieJar = {};         // { nom_cookie: valeur } — persiste tant que la fonction reste "chaude"
let lastOauthFailure = null; // { status, body, at } — pour le mode debug

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse les en-têtes Set-Cookie d'une réponse HTTP en objet { nom: valeur }
function parseSetCookieHeaders(setCookieArr) {
  if (!setCookieArr) return {};
  const arr = Array.isArray(setCookieArr) ? setCookieArr : [setCookieArr];
  const out = {};
  for (const line of arr) {
    const first = line.split(';')[0];
    const idx = first.indexOf('=');
    if (idx === -1) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function cookieJarToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Requête HTTPS générique (remplace les anciens helpers ZenRows).
function request(method, targetUrl, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const reqHeaders = { ...headers };
    if (data) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = data.length;
    }

    const req = https.request(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let chunks = Buffer.alloc(0);
        res.on('data', (c) => { chunks = Buffer.concat([chunks, c]); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.toString('utf8') }));
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout (${timeoutMs}ms)`)); });
    if (data) req.write(data);
    req.end();
  });
}

// Enveloppe `request` avec des retries (backoff exponentiel) sur les erreurs
// réseau/timeouts et sur les codes typiques d'un souci temporaire côté Vinted
// (429/502/503/504). On ne retente PAS ici les 401/403, gérés plus haut
// dans la logique métier (renouvellement de session / cookies).
async function requestWithRetry(method, targetUrl, opts = {}, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await request(method, targetUrl, opts);
      if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        await sleep(400 * Math.pow(3, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(400 * Math.pow(3, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Bootstrap de session ──────────────────────────────────────────────────────
// Visite la page d'accueil pour obtenir un premier lot de cookies (anon_id,
// datadome, etc.). `force=true` permet de forcer un renouvellement complet
// si on soupçonne que les cookies en cache sont grillés.
async function bootstrapCookies(force = false) {
  if (!force && Object.keys(cookieJar).length) return cookieJar;

  try {
    const res = await requestWithRetry('GET', 'https://www.vinted.fr/', {
      headers: {
        'User-Agent': IOS_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeoutMs: 15000,
    });
    const fresh = parseSetCookieHeaders(res.headers['set-cookie']);
    cookieJar = force ? fresh : { ...cookieJar, ...fresh };
  } catch (err) {
    console.error(`[vinted-bootstrap] échec de récupération des cookies initiaux: ${err.message}`);
    // On continue quand même : certaines requêtes peuvent réussir sans cookie.
  }

  return cookieJar;
}

// ── Obtenir (ou rafraîchir) le token OAuth ───────────────────────────────────
async function getOauthToken() {
  await bootstrapCookies();

  const payload = { grant_type: 'password', client_id: 'ios', scope: 'public' };

  if (session && session.refresh_token) {
    payload.grant_type = 'refresh_token';
    payload.refresh_token = session.refresh_token;
  }

  const res = await requestWithRetry('POST', 'https://www.vinted.fr/oauth/token', {
    headers: {
      'User-Agent': IOS_USER_AGENT,
      'Accept': 'application/json',
      'Cookie': cookieJarToHeader(cookieJar),
    },
    body: payload,
  });

  Object.assign(cookieJar, parseSetCookieHeaders(res.headers['set-cookie']));

  if (res.status !== 200) {
    console.error(
      `[vinted-oauth] échec (${payload.grant_type}) HTTP ${res.status}\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
    lastOauthFailure = {
      grant_type: payload.grant_type,
      status: res.status,
      headers: res.headers || null,
      body: res.body.slice(0, 2000),
      at: new Date().toISOString(),
    };

    // Si le refresh échoue, on repart sur un password grant propre,
    // avec des cookies fraîchement re-bootstrappés (le blocage vient
    // parfois d'une session cookie expirée plutôt que du token lui-même).
    if (payload.grant_type === 'refresh_token') {
      session = null;
      await bootstrapCookies(true);
      return getOauthToken();
    }
    throw new Error(`Échec de l'authentification OAuth (HTTP ${res.status})`);
  }

  let content;
  try { content = JSON.parse(res.body); }
  catch {
    console.error(`[vinted-oauth] réponse 200 mais non-JSON: ${res.body.slice(0, 500)}`);
    lastOauthFailure = {
      grant_type: payload.grant_type,
      status: res.status,
      headers: res.headers || null,
      body: res.body.slice(0, 2000),
      at: new Date().toISOString(),
      note: 'HTTP 200 mais corps non-JSON',
    };
    throw new Error('Réponse OAuth non-JSON');
  }

  session = {
    access_token: content.access_token,
    refresh_token: content.refresh_token,
    expiration_date: content.created_at + content.expires_in,
  };
  return session;
}

async function ensureSession() {
  const now = Date.now() / 1000;
  if (!session || session.expiration_date < now) {
    await getOauthToken();
  }
  return session;
}

// ── Requête catalogue ────────────────────────────────────────────────────────
// `manualCookie` : cookie collé manuellement par l'utilisateur depuis son
// navigateur (fallback UI côté front) — prioritaire sur le cookie jar interne
// quand il est fourni, car il vient d'une vraie session validée par Datadome.
async function fetchCatalog(params, manualCookie) {
  const s = await ensureSession();
  const url = `https://www.vinted.fr/api/v2/catalog/items?${params}`;

  const buildHeaders = (accessToken) => ({
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': IOS_USER_AGENT,
    'x-app-version': APP_VERSION,
    'x-device-model': DEVICE_MODEL,
    'short-bundle-version': APP_VERSION,
    'Accept': 'application/json',
    'Cookie': manualCookie || cookieJarToHeader(cookieJar),
  });

  let res = await requestWithRetry('GET', url, { headers: buildHeaders(s.access_token) });
  Object.assign(cookieJar, parseSetCookieHeaders(res.headers['set-cookie']));

  // Token expiré/invalide → on retente une seule fois après renouvellement
  if (res.status === 401) {
    console.error(
      `[vinted-catalog] HTTP 401 avec le token en cache — renouvellement puis retry\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
    session = null;
    const s2 = await ensureSession();
    res = await requestWithRetry('GET', url, { headers: buildHeaders(s2.access_token) });
    Object.assign(cookieJar, parseSetCookieHeaders(res.headers['set-cookie']));
  }

  // 403/503 sans cookie manuel → probable challenge Datadome, on retente une
  // fois avec des cookies fraîchement bootstrappés avant d'abandonner.
  if ([403, 503].includes(res.status) && !manualCookie) {
    console.error(
      `[vinted-catalog] HTTP ${res.status} — nouveau bootstrap de cookies puis retry\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
    await bootstrapCookies(true);
    res = await requestWithRetry('GET', url, { headers: buildHeaders(s.access_token) });
    Object.assign(cookieJar, parseSetCookieHeaders(res.headers['set-cookie']));
  }

  if (res.status !== 200) {
    console.error(
      `[vinted-catalog] HTTP ${res.status}\n` +
      `  url: ${url}\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
  }

  return res;
}

// ── Handler Vercel ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { search_text, price_from, price_to, per_page, order, debug, cookie } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const manualCookie = typeof cookie === 'string' && cookie.trim() ? cookie.trim() : null;

  const params = new URLSearchParams({
    search_text: search_text || '',
    catalog_ids: '',
    price_from:  price_from  || '',
    price_to:    price_to    || '',
    per_page:    per_page    || 15,
    order:       order       || 'newest_first',
  });

  try {
    const result = await fetchCatalog(params, manualCookie);

    if (result.status === 200) {
      try {
        return res.json(JSON.parse(result.body));
      } catch {
        return res.status(500).json({ error: 'Réponse Vinted non-JSON', raw: result.body.slice(0, 300) });
      }
    }

    return res.status(result.status).json({
      error: `Vinted a répondu ${result.status}`,
      detail: result.body.slice(0, 500),
      ...(isDebug ? { debug: lastOauthFailure } : {}),
    });

  } catch (err) {
    console.error(`[vinted-handler] exception: ${err.message}`, err.stack);
    return res.status(500).json({
      error: err.message,
      ...(isDebug ? { debug: lastOauthFailure } : {}),
    });
  }
}