# Installation locale Windows Server 2019

## Prérequis

- Windows Server 2019
- Node.js 20 ou 22
- npm 9+
- PostgreSQL 14+ ou 15+
- Accès réseau au SAP Business One Service Layer
- Git

## Répertoires conseillés

- Code : `C:\Apps\pa-sap-bridge`
- Fichiers applicatifs : `C:\ProgramData\pa-sap-bridge\files`
- Logs PM2 éventuels : `C:\ProgramData\pa-sap-bridge\logs`

## Installation

```powershell
git clone <repo> C:\Apps\pa-sap-bridge
cd C:\Apps\pa-sap-bridge
npm install
copy .env.example .env
```

Renseigner ensuite `.env`.

## Configuration minimale

### Base de données

Créer la base :

```sql
CREATE DATABASE pa_sap_bridge;
```

Puis configurer `DATABASE_URL`.

### Stockage fichiers

Créer le répertoire défini par `FILE_STORAGE_PATH`.

Exemple recommandé :

```powershell
New-Item -ItemType Directory -Force C:\ProgramData\pa-sap-bridge\files
```

Sous-répertoires créés automatiquement par l’application :

- `inbox`
- `processed`
- `error`
- `invoices`
- `status-out` si `STATUS_OUT_PATH` n’est pas défini

### SAP Business One

Variables à renseigner pour le login réel :

- `SAP_REST_BASE_URL`
- `SAP_CLIENT`
- `SAP_USER`
- `SAP_CLIENT_PASSWORD`

Si le Service Layer utilise un certificat auto-signé en environnement local :

- `SAP_IGNORE_SSL=true` seulement en dev ou recette locale

## Préparation locale

```powershell
npm run local:prepare
```

Ce script :

- valide `.env`
- génère Prisma
- applique les migrations

## Lancement

### Développement

```powershell
npm run local:dev
```

### Exécution locale stabilisée

```powershell
npm run local:prod
```

### Raccourcis PowerShell

- [scripts/windows/prepare-local.ps1](C:/Users/PPZ/BILLING/scripts/windows/prepare-local.ps1)
- [scripts/windows/start-dev.ps1](C:/Users/PPZ/BILLING/scripts/windows/start-dev.ps1)
- [scripts/windows/start-prod.ps1](C:/Users/PPZ/BILLING/scripts/windows/start-prod.ps1)
- [scripts/windows/check-local.ps1](C:/Users/PPZ/BILLING/scripts/windows/check-local.ps1)

## PM2

PM2 est prêt via [ecosystem.config.cjs](C:/Users/PPZ/BILLING/ecosystem.config.cjs).

Exemple :

```powershell
npm install -g pm2
npm run build
npm run pm2:start
pm2 save
```

Point d’attention :

- `pm2 startup` n’offre pas la même intégration native que sous Linux. Sur Windows Server, prévoir soit PM2 relancé au logon d’un compte de service, soit une tâche planifiée, soit NSSM.

## Vérifications après installation

```powershell
npm run local:env:check
npm run test
npm run build
```
