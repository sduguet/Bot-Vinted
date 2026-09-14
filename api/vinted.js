import https from 'https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Auth "client iOS" (même méthode que vintedpy) ────────────────────────────
// Vinted expose un endpoint OAuth utilisé par son app iOS. En s'authentifiant
// comme ce client officiel, on récupère un Bearer token directement, sans
// avoir à simuler une session web (page d'accueil → cookies → Datadome…).
const IOS_USER_AGENT = 'vinted-ios Vinted/22.6.1 (lt.manodrabuziai.fr; build:21794; iOS 15.2.0) iPhone10,6';
const APP_VERSION     = '22.6.1';
const DEVICE_MODEL    = 'iPhone10,6';

// ── ZenRows ───────────────────────────────────────────────────────────────────
// Les requêtes vers vinted.fr ne partent plus directement de Vercel (IP
// datacenter systématiquement challengée par Cloudflare). Elles transitent
// par l'API ZenRows, qui les fait passer par une IP résidentielle propre.
const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY;
const ZENROWS_ENDPOINT = 'https://api.zenrows.com/v1/';

let session = null; // { access_token, refresh_token, expiration_date }
let lastOauthFailure = null; // { status, body, at } — pour le mode debug

// Construit l'URL d'appel à ZenRows pour une cible donnée.
// - premium_proxy : IP résidentielle (indispensable ici, sinon même souci qu'avant)
// - custom_headers : transmet nos headers (User-Agent iOS, Authorization…) à Vinted
// - original_status : renvoie le vrai code HTTP de Vinted (pas celui de ZenRows)
// - allowed_status_codes : renvoie quand même le corps même si Vinted répond en erreur,
//   utile pour continuer à débugger comme avant
function buildZenrowsUrl(targetUrl) {
  if (!ZENROWS_API_KEY) {
    throw new Error('ZENROWS_API_KEY manquante dans les variables d\'environnement');
  }
  const qs = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: targetUrl,
    premium_proxy: 'true',
    custom_headers: 'true',
    original_status: 'true',
    allowed_status_codes: '400,401,403,404,429,500,502,503',
  });
  return `${ZENROWS_ENDPOINT}?${qs.toString()}`;
}

// POST JSON, relayé via ZenRows. Le body JSON et les headers custom (User-Agent…)
// sont transmis tels quels à l'URL cible grâce à custom_headers=true.
function postJsonViaZenrows(targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(buildZenrowsUrl(targetUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers, // ex: User-Agent iOS -> transmis à Vinted par ZenRows
      },
    }, (res) => {
      let chunks = Buffer.alloc(0);
      res.on('data', c => { chunks = Buffer.concat([chunks, c]); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout (20s)')); });
    req.write(data);
    req.end();
  });
}

// GET, relayé via ZenRows, mêmes principes.
function getJsonViaZenrows(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(buildZenrowsUrl(targetUrl), { headers }, (res) => {
      let chunks = Buffer.alloc(0);
      res.on('data', c => { chunks = Buffer.concat([chunks, c]); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout (20s)')); });
  });
}

// ── Obtenir (ou rafraîchir) le token OAuth ───────────────────────────────────
async function getOauthToken() {
  const payload = { grant_type: 'password', client_id: 'ios', scope: 'public' };

  if (session && session.refresh_token) {
    payload.grant_type = 'refresh_token';
    payload.refresh_token = session.refresh_token;
  }

  const res = await postJsonViaZenrows('https://www.vinted.fr/oauth/token', payload, {
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

  let res = await getJsonViaZenrows(url, headers);

  // Token expiré/invalide entre deux scans → on retente une seule fois après renouvellement
  if (res.status === 401) {
    console.error(
      `[vinted-catalog] HTTP 401 avec le token en cache — renouvellement puis retry\n` +
      `  body (500 premiers car.): ${res.body.slice(0, 500)}`
    );
    session = null;
    const s2 = await ensureSession();
    res = await getJsonViaZenrows(url, { ...headers, 'Authorization': `Bearer ${s2.access_token}` });
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