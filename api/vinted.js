import https from 'https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Auth "client iOS" (même méthode que vintedpy) ────────────────────────────
// Vinted expose un endpoint OAuth utilisé par son app iOS. En s'authentifiant
// comme ce client officiel, on récupère un Bearer token directement, sans
// avoir à simuler une session web (page d'accueil → cookies → Datadome…).
const IOS_USER_AGENT = 'vinted-ios Vinted/22.6.1 (lt.manodrabuziai.fr; build:21794; iOS 15.2.0) iPhone10,6';
const APP_VERSION     = '22.6.1';
const DEVICE_MODEL    = 'iPhone10,6';

let session = null; // { access_token, refresh_token, expiration_date }
let lastOauthFailure = null; // { status, body, at } — pour le mode debug

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
    }, (res) => {
      let chunks = Buffer.alloc(0);
      res.on('data', c => { chunks = Buffer.concat([chunks, c]); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout (15s)')); });
    req.write(data);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let chunks = Buffer.alloc(0);
      res.on('data', c => { chunks = Buffer.concat([chunks, c]); });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks.toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout (15s)')); });
  });
}

// ── Obtenir (ou rafraîchir) le token OAuth ───────────────────────────────────
async function getOauthToken() {
  const payload = { grant_type: 'password', client_id: 'ios', scope: 'public' };

  if (session && session.refresh_token) {
    payload.grant_type = 'refresh_token';
    payload.refresh_token = session.refresh_token;
  }

  const res = await postJson('https://www.vinted.fr/oauth/token', payload, {
    'User-Agent': IOS_USER_AGENT,
  });

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

    // Si le refresh échoue, on repart sur un password grant propre
    if (payload.grant_type === 'refresh_token') {
      session = null;
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

  // Succès : on peut effacer l'échec précédent (optionnel, garde l'historique sinon)
  // lastOauthFailure = null;

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
async function fetchCatalog(params) {
  const s = await ensureSession();

  const url = `https://www.vinted.fr/api/v2/catalog/items?${params}`;
  const headers = {
    'Authorization': `Bearer ${s.access_token}`,
    'User-Agent': IOS_USER_AGENT,
    'x-app-version': APP_VERSION,
    'x-device-model': DEVICE_MODEL,
    'short-bundle-version': APP_VERSION,
    'Accept': 'application/json',
  };

  let res = await getJson(url, headers);

  // Token expiré/invalide entre deux scans → on retente une seule fois après renouvellement
  if (res.status === 401) {
    console.error(
      `[vinted-catalog] HTTP 401 avec le token en cache — renouvellement puis retry\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
    session = null;
    const s2 = await ensureSession();
    res = await getJson(url, { ...headers, 'Authorization': `Bearer ${s2.access_token}` });
    if (res.status !== 200) {
      console.error(
        `[vinted-catalog] retry après renouvellement toujours en échec, HTTP ${res.status}\n` +
        `  body (500 premiers car.): ${res.body.slice(0, 500)}`
      );
    }
  } else if (res.status !== 200) {
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

  const { search_text, price_from, price_to, per_page, order, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';

  const params = new URLSearchParams({
    search_text: search_text || '',
    catalog_ids: '',
    price_from:  price_from  || '',
    price_to:    price_to    || '',
    per_page:    per_page    || 15,
    order:       order       || 'newest_first',
  });

  try {
    const result = await fetchCatalog(params);

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