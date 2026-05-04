# VintedBot 🎲

Surveillance d'annonces Vinted — déployable sur Vercel.

## Structure

```
vintedbot/
├── public/
│   └── index.html       # Frontend (interface du bot)
├── api/
│   ├── ping.js          # Healthcheck de l'API
│   ├── vinted.js        # Proxy vers l'API Vinted
│   └── set-credentials.js
├── vercel.json          # Config de routage Vercel
├── package.json
└── README.md
```

## Déploiement sur Vercel

### 1. Mettre le code sur GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON_USER/vintedbot.git
git push -u origin main
```

### 2. Déployer sur Vercel

1. Va sur [vercel.com](https://vercel.com) et connecte ton compte GitHub
2. Clique sur **"Add New Project"**
3. Importe ton repository `vintedbot`
4. Vercel détecte automatiquement la config — clique **"Deploy"**

C'est tout. Ton bot sera accessible à l'URL fournie par Vercel.

### 3. Configurer le cookie Vinted

Le cookie est stocké dans le **localStorage de ton navigateur** et envoyé à chaque requête.

1. Ouvre ton app déployée
2. Clique sur **"🔑 Configurer le cookie"**
3. Récupère ton cookie Vinted via F12 (onglet Réseau > requête `catalog/items` > header `Cookie`)
4. Colle-le et enregistre

> ⚠️ Le cookie Vinted expire régulièrement (quelques heures). Si tu as une erreur 401/403, répète l'opération.

## Différences avec la version locale

| Version locale | Version Vercel |
|---|---|
| `proxy.js` stocke le cookie en mémoire serveur | Le cookie est stocké dans le `localStorage` du navigateur |
| Proxy Node.js persistant | Fonctions serverless (stateless) |
| `http://localhost:3000` | URL Vercel publique |
| Cookie partagé entre tous les onglets via le serveur | Cookie propre à chaque navigateur/utilisateur |
