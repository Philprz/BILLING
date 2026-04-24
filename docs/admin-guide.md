# Guide administrateur — PA-SAP Bridge

## À qui s'adresse ce guide ?

Aux administrateurs système et aux intégrateurs responsables de l'installation, la configuration et la maintenance de PA-SAP Bridge.

---

## 1. Prérequis

| Composant                      | Version minimale               |
| ------------------------------ | ------------------------------ |
| Node.js                        | 20 LTS                         |
| PostgreSQL                     | 16                             |
| SAP Business One Service Layer | 10.0                           |
| Docker + Docker Compose        | 24+ (déploiement conteneurisé) |

---

## 2. Architecture

```
Internet / Réseau interne
        │
   ┌────▼────┐
   │  nginx  │  :80/:443 — sert le SPA React + proxy API
   └────┬────┘
        │ /api/*
   ┌────▼────┐        ┌──────────┐
   │   API   │◄──────►│ PostgreSQL│
   │(Fastify)│        │   :5432  │
   └────┬────┘        └──────────┘
        │                   ▲
   ┌────▼────┐              │
   │ Worker  │──────────────┘
   │(polling)│
   └─────────┘
        │
   SAP B1 Service Layer (HTTPS)
```

- **API** (port 3000) : REST JSON, sessions cookie HttpOnly, rate limiting
- **Worker** : boucle de polling PA (SFTP/API), intégration, retour statut, nettoyage règles
- **Web** : SPA React servie par nginx, proxy `/api/*` vers l'API

---

## 3. Variables d'environnement

### API (`apps/api/.env`)

| Variable                | Obligatoire | Description                                        | Exemple                                        |
| ----------------------- | ----------- | -------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`          | ✅          | URL PostgreSQL complète                            | `postgresql://user:pass@db:5432/pa_sap_bridge` |
| `SAP_REST_BASE_URL`     | ✅          | URL de base SAP B1 Service Layer                   | `https://sap-server:50000/b1s/v1`              |
| `SESSION_COOKIE_SECRET` | ✅          | Secret HMAC sessions (≥ 32 chars)                  | `prod-secret-à-changer-impérativement`         |
| `SESSION_ENC_KEY`       | ✅          | Clé AES-GCM 32 octets hex pour chiffrement         | `a1b2c3d4e5f60718...` (64 hex chars)           |
| `CORS_ORIGIN`           | ✅          | Origine autorisée pour CORS                        | `https://billing.exemple.com`                  |
| `SAP_IGNORE_SSL`        | —           | Désactive la vérification SSL SAP (dev uniquement) | `true`                                         |
| `SAP_ATTACHMENT_POLICY` | —           | `strict` / `warn` / `skip`                         | `warn`                                         |
| `SAP_POST_POLICY`       | —           | `real` / `simulate` / `disabled`                   | `real`                                         |
| `NODE_ENV`              | —           | `production` active HSTS                           | `production`                                   |
| `LOG_LEVEL`             | —           | `info` / `debug` / `warn`                          | `info`                                         |

### Worker (`apps/worker/.env`)

| Variable            | Obligatoire | Description                                                  |
| ------------------- | ----------- | ------------------------------------------------------------ |
| `DATABASE_URL`      | ✅          | Même base que l'API                                          |
| `SAP_REST_BASE_URL` | ✅          | Idem API                                                     |
| `POLL_INTERVAL_MS`  | —           | Intervalle de boucle principale (défaut : `10000`)           |
| `INBOX_PATH`        | —           | Dossier de dépôt local (défaut : `data/inbox`)               |
| `PROCESSED_PATH`    | —           | Dossier après traitement (défaut : `data/processed`)         |
| `STATUS_OUT_PATH`   | —           | Dossier retour statut FILE_STUB (défaut : `data/status-out`) |
| `SESSION_ENC_KEY`   | ✅          | Même clé que l'API                                           |

---

## 4. Installation

### 4.1 Docker Compose (recommandé)

```bash
# Copier et adapter les variables d'environnement
cp .env.example .env
# Éditer .env avec vos valeurs réelles

# Premier démarrage
docker compose up -d

# Vérifier les logs
docker compose logs -f api
docker compose logs -f worker
```

Le service `migrate` s'exécute automatiquement au premier démarrage et applique les migrations Prisma.

### 4.2 Installation locale (développement)

```bash
npm install
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
npm run dev -w apps/api    # port 3000
npm run dev -w apps/web    # port 5173
npm run dev -w apps/worker
```

---

## 5. Configuration applicative (Settings)

Les paramètres métier sont modifiables depuis l'interface **Paramètres** de l'application ou via l'API :

```http
PUT /api/settings/TAX_RATE_MAPPING
Content-Type: application/json

{ "value": { "5.5": "S2", "10": "S3", "20": "S1" } }
```

| Clé                              | Valeur par défaut  | Description                                            |
| -------------------------------- | ------------------ | ------------------------------------------------------ |
| `AUTO_VALIDATION_THRESHOLD`      | `80`               | Score minimum (%) pour promotion automatique NEW→READY |
| `TAX_RATE_MAPPING`               | `{}`               | Map taux TVA % → code TVA SAP B1                       |
| `AP_TAX_ACCOUNT_MAP`             | `{}`               | Map code TVA B1 → compte TVA à déduire                 |
| `AP_ACCOUNT_CODE`                | `"40100000"`       | Compte fournisseur par défaut                          |
| `SAP_POST_POLICY`                | `"real"`           | Override global de la politique d'intégration          |
| `SAP_ATTACHMENT_POLICY`          | `"warn"`           | Comportement si upload PJ SAP échoue                   |
| `PA_STATUS_RETRY_DELAYS_MINUTES` | `[1,5,30,120,720]` | Délais retry retour statut PA                          |
| `PA_STATUS_MAX_RETRIES`          | `5`                | Nombre maximum de tentatives                           |

---

## 6. Canaux PA (Sources de factures)

### Créer un canal SFTP

```http
POST /api/pa-channels
Content-Type: application/json

{
  "name": "CHORUS-PRO-SFTP",
  "protocol": "SFTP",
  "host": "sftp.chorus-pro.gouv.fr",
  "port": 22,
  "user": "monlogin",
  "passwordEncrypted": "motdepasse",
  "remotePathIn": "/in/factures",
  "remotePathProcessed": "/in/traites",
  "remotePathOut": "/out/statuts",
  "pollIntervalSeconds": 300
}
```

### Créer un canal API

```http
POST /api/pa-channels
Content-Type: application/json

{
  "name": "CHORUS-PRO-API",
  "protocol": "API",
  "apiBaseUrl": "https://api.chorus-pro.gouv.fr/v1",
  "apiAuthType": "BASIC",
  "apiCredentialsEncrypted": "{\"user\":\"login\",\"password\":\"pass\"}",
  "pollIntervalSeconds": 60
}
```

> **Note :** Les mots de passe et credentials sont chiffrés en AES-GCM avec `SESSION_ENC_KEY` avant stockage.

---

## 7. Synchronisation du cache fournisseurs

Pour initialiser ou rafraîchir le cache SAP B1 des fournisseurs :

```http
POST /api/suppliers-cache/sync
```

Ou depuis l'interface : **Fournisseurs > Synchroniser depuis SAP B1**.

Cette opération pull tous les `BusinessPartners` (CardType=cSupplier, actifs) et upsert en base locale. À planifier en cron quotidien.

---

## 8. Maintenance

### Nettoyage automatique des règles stagnantes

Le worker exécute automatiquement une tâche hebdomadaire qui désactive les règles de mappage dont :

- `confidence < 20`
- `lastUsedAt` est null ou > 180 jours

Aucune action manuelle requise. Les règles désactivées restent en base pour audit.

### Purge des logs d'audit

Les logs d'audit ne sont jamais purgés automatiquement (journal immuable). Pour une purge manuelle après archivage :

```sql
DELETE FROM audit_log WHERE occurred_at < NOW() - INTERVAL '2 years';
```

### Sauvegarde

Éléments à sauvegarder :

- Base PostgreSQL (pg_dump quotidien recommandé)
- Dossier `data/` (factures, fichiers traités, statuts)

---

## 9. Sécurité

| Mesure        | Détail                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| Sessions      | Cookie HttpOnly + SameSite Strict, signé HMAC, durée 60 min                     |
| Rate limiting | 300 req/min globales · 10 tentatives/15 min sur `/api/auth/login`               |
| Headers HTTP  | X-Frame-Options DENY, nosniff, HSTS (prod), Referrer-Policy, Permissions-Policy |
| CSP frontend  | `default-src 'self'`, script-src self, unsafe-inline styles seulement           |
| Chiffrement   | Credentials PA chiffrés AES-GCM en base                                         |
| TLS           | Requis en production ; configurer nginx avec certificat valide                  |
| SSL SAP       | `SAP_IGNORE_SSL=true` interdit en production                                    |

---

## 10. Endpoints API — référence rapide

| Méthode  | Route                                     | Description                  |
| -------- | ----------------------------------------- | ---------------------------- |
| `POST`   | `/api/auth/login`                         | Connexion SAP B1             |
| `POST`   | `/api/auth/logout`                        | Déconnexion                  |
| `POST`   | `/api/auth/keepalive`                     | Renouvellement de session    |
| `GET`    | `/api/invoices`                           | Liste paginée avec filtres   |
| `GET`    | `/api/invoices/export.csv`                | Export CSV                   |
| `GET`    | `/api/invoices/stats/daily`               | Statistiques 30 jours        |
| `POST`   | `/api/invoices/bulk-post`                 | Intégration de masse         |
| `POST`   | `/api/invoices/upload`                    | Import manuel XML/PDF        |
| `GET`    | `/api/invoices/:id`                       | Détail facture               |
| `POST`   | `/api/invoices/:id/post`                  | Intégration SAP individuelle |
| `POST`   | `/api/invoices/:id/reject`                | Rejet                        |
| `POST`   | `/api/invoices/:id/send-status`           | Retour statut PA             |
| `PATCH`  | `/api/invoices/:id/supplier`              | Correction fournisseur       |
| `POST`   | `/api/invoices/:id/re-enrich`             | Ré-analyse matching          |
| `GET`    | `/api/invoices/:id/files/:fileId/content` | Contenu fichier              |
| `GET`    | `/api/suppliers-cache`                    | Cache fournisseurs           |
| `POST`   | `/api/suppliers-cache/sync`               | Synchronisation SAP          |
| `POST`   | `/api/suppliers/create-in-sap`            | Créer fournisseur SAP B1     |
| `GET`    | `/api/mapping-rules`                      | Règles de mappage            |
| `POST`   | `/api/mapping-rules`                      | Créer règle                  |
| `DELETE` | `/api/mapping-rules/:id`                  | Supprimer règle              |
| `GET`    | `/api/pa-channels`                        | Canaux PA                    |
| `POST`   | `/api/pa-channels`                        | Créer canal                  |
| `PUT`    | `/api/pa-channels/:id`                    | Modifier canal               |
| `GET`    | `/api/settings`                           | Paramètres                   |
| `PUT`    | `/api/settings/:key`                      | Modifier paramètre           |
| `GET`    | `/api/audit`                              | Journal d'audit              |
| `GET`    | `/api/audit/export.csv`                   | Export audit CSV             |
| `GET`    | `/api/worker/status`                      | État des canaux worker       |

---

## 11. Dépannage

**Le worker ne démarre pas.**  
→ Vérifier `DATABASE_URL` et `SAP_REST_BASE_URL`. Tester la connexion DB : `npx prisma db pull`.

**Les factures ne sont pas récupérées du SFTP.**  
→ Vérifier les logs worker (`[Worker][...] Erreur sur le canal ...`). Tester la connexion SFTP avec un client externe. Vérifier que `remotePathIn` contient des fichiers `.xml` ou `.pdf`.

**L'intégration SAP échoue avec HTTP 401.**  
→ La session SAP a expiré. L'utilisateur doit se reconnecter. Vérifier que le keep-alive fonctionne (logs API : `POST /api/auth/keepalive`).

**Erreur "SAP_POST_POLICY=disabled".**  
→ La variable `SAP_POST_POLICY` ou le setting BDD est à `disabled`. Modifier via `PUT /api/settings/SAP_POST_POLICY {"value": "real"}`.
