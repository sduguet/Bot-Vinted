export default function handler(req, res) {
  // Le cookie est géré côté client (localStorage) et envoyé dans chaque requête
  // On répond simplement que l'API est disponible
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', hasCookie: true, hasCsrf: false });
}
