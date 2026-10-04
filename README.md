# HpronoIA – version serveur v2

Serveur Node.js sans dépendance (Node 18 ou plus) : cotes en direct, pronostics figés et chaînés, résultats vérifiés en continu, précision par niveau de confiance, abonnement VIP par Orange Money et panneau administrateur.

## Démarrage local
```bash
cp .env.example .env
npm install
npm start
```
- Site public : http://localhost:3000
- Administration : http://localhost:3000/admin
- Sans clé API, le serveur tourne en mode démo avec des données fictives.

## Variables d'environnement
```env
ODDS_API_KEY=
PORT=3000
ADMIN_TOKEN=123ADMINHPRONOS
REGIONS=eu
MARKETS=h2h,totals
SPORTS=
MAX_SPORTS=3
REFRESH_MIN=360
RESULT_POLL_MIN=10
LIVE=0
CREDIT_FLOOR=25
TRUST_PROXY=0
```

## Déploiement
Ce projet est un serveur Node.js. Il n'est pas un site statique pur et n'est donc pas bien adapté à GitHub Pages.

Pour un déploiement simple :
- Render
- Railway
- Fly.io
- VPS / PM2

Vercel n'est pas recommandé pour ce projet sans adaptation, car il utilise un stockage local JSON (`data/db.json`) et un serveur HTTP persistant.
