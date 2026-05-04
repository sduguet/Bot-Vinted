export default function handler(req, res) {
  // Sur Vercel, les fonctions sont stateless : le cookie ne peut pas être
  // stocké côté serveur entre les requêtes. Il est géré en localStorage
  // côté client et transmis directement dans chaque appel à /api/vinted.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, hasCookie: true, hasCsrf: false });
}
