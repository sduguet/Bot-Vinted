import https from 'https';
import http  from 'http';

// Désactive la vérification TLS (comme dans le proxy local)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

  const { search_text, price_from, price_to, per_page, order, cookie } = req.query;

  // Le cookie est transmis par le frontend dans le paramètre "cookie"
  if (!cookie) {
    return res.status(401).json({
      error: 'Cookie manquant',
      hint: 'Configure ton cookie Vinted via l\'interface.',
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
    const result = await fetchUrl(url, buildHeaders(cookie, search_text));

    if (result.status === 200) {
      try {
        return res.json(JSON.parse(result.body));
      } catch {
        return res.status(500).json({ error: 'Réponse Vinted non-JSON', raw: result.body.slice(0, 300) });
      }
    }

    res.status(result.status).json({
      error: `Vinted a répondu ${result.status}`,
      detail: result.body.slice(0, 300),
      hint: [401, 403, 500].includes(result.status)
        ? 'Cookie expiré — récupère-en un nouveau via F12 > Réseau sur vinted.fr'
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
