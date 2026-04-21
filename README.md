# PA-SAP Bridge

Passerelle locale entre une plateforme de facturation électronique et SAP Business One, prévue pour une exploitation on-premise sur Windows Server 2019.

## État actuel

- API Fastify, worker et front React lançables localement.
- Base PostgreSQL Prisma migrée et exploitable.
- Ingestion locale de fichiers, revue facture, intégration SAP simulée, rejet, audit et retour de statut PA simulé.
- Tests unitaires, intégration API et smoke E2E locaux exécutables.
- Retour PA réel API/SFTP et automatisation navigateur non finalisés.

## Démarrage rapide

```powershell
copy .env.example .env
# éditer .env
npm install
npm run local:prepare
npm run local:dev
```

Applications en local :

- Front : `http://localhost:5173`
- API : `http://localhost:3001`
- Preview front de type "prod locale" : `http://localhost:4173`

## Scripts principaux

### Développement

- `npm run local:env:check` : vérifie `.env` et les répertoires critiques
- `npm run local:prepare` : vérifie l’env, génère Prisma et applique les migrations
- `npm run local:dev` : lance API + worker + front Vite

### Exécution locale stabilisée

- `npm run build`
- `npm run start:local`
- `npm run local:prod`

### PM2

- `npm run pm2:start`
- `npm run pm2:restart`
- `npm run pm2:stop`

Le fichier [`ecosystem.config.cjs`](C:/Users/PPZ/BILLING/ecosystem.config.cjs) prépare `api`, `worker` et `web` pour PM2. PM2 n’est pas embarqué globalement par Windows : installation séparée requise sur le serveur.

### Tests et contrôles

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test`
- `npm run test:coverage`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run check:lot9`

## Documentation

- Installation locale Windows : [docs/installation-locale-windows.md](C:/Users/PPZ/BILLING/docs/installation-locale-windows.md)
- Exploitation locale : [docs/exploitation-locale.md](C:/Users/PPZ/BILLING/docs/exploitation-locale.md)
- Bilan tests et couverture : [docs/tests-et-couverture.md](C:/Users/PPZ/BILLING/docs/tests-et-couverture.md)

## Variables d’environnement

Le template complet est dans [`.env.example`](C:/Users/PPZ/BILLING/.env.example).

Variables clés :

- `DATABASE_URL`
- `FILE_STORAGE_PATH`
- `STATUS_OUT_PATH`
- `SESSION_COOKIE_SECRET`
- `SAP_REST_BASE_URL`
- `SAP_CLIENT`
- `SAP_USER`
- `SAP_CLIENT_PASSWORD`
- `SAP_IGNORE_SSL`
- `PA_STATUS_MAX_RETRIES`
- `PA_STATUS_RETRY_DELAYS_MS`

## Limites connues

- Le login SAP réel dépend d’un Service Layer accessible et correctement configuré.
- Le retour de statut PA reste simulé par fichier JSON.
- Le front de type "prod locale" repose sur `vite preview`, utile pour exploitation interne mais pas encore durci comme un vrai serveur frontal.
- Les tests n’incluent pas encore d’automatisation navigateur Playwright.
