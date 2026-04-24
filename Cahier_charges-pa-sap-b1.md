# Prompt Lovable — Passerelle « Plateforme Agréée ↔ SAP Business One »

> Copie/colle l'intégralité du bloc ci-dessous dans Lovable.
> Les zones marquées `[À COMPLÉTER]` doivent être renseignées avant lancement (couleurs IT-Spirit, URL SAP, etc.).

---

## 1. Contexte & objectif

Je veux construire une **application web** servant de **passerelle** entre une **Plateforme Agréée de facturation électronique (PA)** et **SAP Business One (SAP B1)**.

Elle permet à un comptable / gestionnaire AP (Accounts Payable) de :

1. Recevoir automatiquement les **factures et avoirs fournisseurs** transmis par la PA (via SFTP ou API).
2. Les **visualiser** dans un cockpit clair (liste + détail + PDF côte à côte).
3. **Vérifier et/ou corriger** le fournisseur et les comptes comptables avant intégration dans SAP B1.
4. Déclencher la **création dans SAP B1** via **Service Layer**, au choix :
   - Facture/avoir de **service** (oPurchaseInvoices / oPurchaseCreditNotes, DocType = dDocument_Service).
   - Ou directement **écriture au journal** (oJournalEntries).
5. **Renvoyer le statut** (`VALIDATED` / `REJECTED` + motif) à la PA.
6. **Apprendre** au fur et à mesure les mappages de comptes pour ne plus avoir à les refaire.
7. **Logger toutes les actions** pour audit.

L'application est **installée on-premise** chez le client, sur **son serveur**. Elle **ne gère pas ses propres utilisateurs** : l'authentification est déléguée à **SAP Business One Service Layer** (les droits applicatifs découlent directement des droits SAP B1 de l'utilisateur connecté).

L'interface est **en français uniquement**.

---

## 2. Stack technique attendue

- **Front-end** : React 18 + TypeScript + Vite, Tailwind CSS, **shadcn/ui**, lucide-react (icônes), react-hook-form + zod (formulaires), TanStack Query (data fetching), React Router.
- **Back-end** : **Node.js + Fastify (ou NestJS)** en TypeScript. API REST documentée OpenAPI. C'est lui qui parle à SAP B1 Service Layer et à la PA (aucun appel direct depuis le navigateur vers SAP B1).
- **Base de données** : **PostgreSQL 15+** (toutes les tables de l'app, y compris la table `audit_log` et les règles de mappage).
- **Fichiers** : stockage local sur le serveur (`/var/lib/pa-sap-bridge/files/`) pour les PDF, XML, pièces jointes reçus de la PA.
- **Scheduler** : worker Node (BullMQ + Redis **ou** simple cron interne) pour la **récupération périodique** SFTP/API PA et les **retries**.
- **Containerisation** : fournir un `docker-compose.yml` (app web, API, worker, Postgres, Redis) et un `.env.example`. L'app doit tourner **100 % on-premise**, sans dépendance SaaS.
- **Licences** : tout doit être **open source** ou libre d'usage commercial.

> ⚠️ **Ne pas** utiliser Supabase, Clerk, Auth0 ni aucun service d'authentification externe. L'auth passe exclusivement par SAP B1 Service Layer.

---

## 3. Authentification & sécurité

### 3.1 Login utilisateur

Écran de connexion unique avec 3 champs :

- **CompanyDB** (base SAP, ex. `SBODEMOFR`) — mémorisable via cookie/localStorage.
- **UserName** (utilisateur SAP B1).
- **Password**.

À la soumission, l'API back-end appelle :

```
POST {SL_BASE_URL}/b1s/v1/Login
Body: { "CompanyDB": "...", "UserName": "...", "Password": "..." }
```

- Si succès : on récupère `SessionId` + `SessionTimeout` + cookies `B1SESSION` et `ROUTEID`. Le back-end **stocke la session chiffrée (AES-GCM) côté serveur**, associée à un **JWT d'app** (court, httpOnly, SameSite=Strict) renvoyé au front. Le front n'a **jamais** accès directement au `B1SESSION`.
- Chaque appel Service Layer passe par le back-end, qui réinjecte les cookies SAP.
- **Keep-alive** : renouvellement automatique de la session SAP avant expiration (`SessionTimeout`).
- **Logout** : appel `POST /b1s/v1/Logout` + destruction du JWT.

### 3.2 Autorisations

- Les droits effectifs = ceux de l'utilisateur SAP B1 (visibles via les erreurs Service Layer).
- Le back-end **ne contourne jamais** un refus SAP.
- Pas de rôles applicatifs supplémentaires dans un premier temps.

### 3.3 Sécurité transport & secrets

- **HTTPS obligatoire** (reverse proxy nginx / Traefik fourni en exemple).
- Secrets (clés API PA, clé de chiffrement sessions, credentials SFTP) dans **variables d'environnement** et/ou fichier `.env` avec permissions `600`. Jamais en base non chiffrés.
- Protection CSRF (double-submit token), en-têtes sécurité (CSP strict, HSTS, X-Frame-Options DENY).
- Rate limiting sur `/api/auth/login`.

---

## 4. Modèle de données (PostgreSQL)

Tables principales (schéma `pasap`) :

### 4.1 `invoices`

- `id` (uuid, PK)
- `pa_message_id` (text, unique) — identifiant du message dans la PA
- `pa_source` (text) — nom/id du canal PA
- `direction` (enum : `INVOICE`, `CREDIT_NOTE`)
- `format` (enum : `FACTUR_X`, `UBL`, `CII`, `PDF_ONLY`, `CSV`, `OTHER`)
- `received_at` (timestamptz)
- `supplier_pa_identifier` (text) — SIREN/SIRET/VAT reçu de la PA
- `supplier_name_raw` (text)
- `supplier_b1_cardcode` (text, nullable) — BP matché dans SAP B1
- `supplier_match_confidence` (int 0-100)
- `doc_number_pa` (text)
- `doc_date` (date)
- `due_date` (date, nullable)
- `currency` (char 3)
- `total_excl_tax` (numeric 19,4)
- `total_tax` (numeric 19,4)
- `total_incl_tax` (numeric 19,4)
- `status` (enum : `NEW`, `TO_REVIEW`, `READY`, `POSTED`, `REJECTED`, `ERROR`)
- `status_reason` (text, nullable)
- `integration_mode` (enum : `SERVICE_INVOICE`, `JOURNAL_ENTRY`, nullable tant que non choisi)
- `sap_doc_entry` (int, nullable)
- `sap_doc_num` (int, nullable)
- `sap_attachment_entry` (int, nullable) — AbsoluteEntry de la pièce jointe SAP B1
- `sap_attachment_uploaded_at` (timestamptz, nullable)
- `pa_status_sent_at` (timestamptz, nullable)
- `created_at`, `updated_at`

### 4.2 `invoice_lines`

- `id`, `invoice_id` (FK)
- `line_no`
- `description`
- `quantity` (numeric)
- `unit_price` (numeric)
- `amount_excl_tax`, `tax_code`, `tax_rate`, `tax_amount`, `amount_incl_tax`
- `suggested_account_code` (text) — compte proposé par moteur de règles
- `suggested_account_confidence` (int 0-100)
- `suggested_cost_center` (text, nullable)
- `chosen_account_code` (text) — compte effectivement retenu
- `chosen_cost_center` (text, nullable)
- `chosen_tax_code_b1` (text)

### 4.3 `invoice_files`

- `id`, `invoice_id`, `kind` (`PDF`, `XML`, `ATTACHMENT`), `path`, `size_bytes`, `sha256`

### 4.4 `suppliers_cache`

Cache local des BP SAP B1 pour auto-complétion rapide : `cardcode`, `cardname`, `federaltaxid`, `vatregnum`, `sync_at`.

### 4.5 `mapping_rules` — cœur de l'apprentissage

- `id`
- `scope` (enum : `GLOBAL`, `SUPPLIER`) — règle globale ou spécifique fournisseur
- `supplier_cardcode` (nullable si GLOBAL)
- `match_keyword` (text, nullable) — mot-clé recherché dans la description (ILIKE, insensible accents)
- `match_tax_rate` (numeric, nullable) — ex. 20.00, 5.50
- `match_amount_min`, `match_amount_max` (nullable)
- `account_code` (text) — compte SAP à appliquer
- `cost_center` (text, nullable)
- `tax_code_b1` (text, nullable)
- `confidence` (int 0-100) — score actuel, évolutif
- `usage_count` (int)
- `last_used_at` (timestamptz)
- `created_by_user` (text)
- `active` (bool)

### 4.6 `audit_log`

- `id`, `occurred_at`, `sap_user`, `action` (enum : `LOGIN`, `LOGOUT`, `FETCH_PA`, `VIEW_INVOICE`, `EDIT_MAPPING`, `APPROVE`, `REJECT`, `POST_SAP`, `SEND_STATUS_PA`, `SYSTEM_ERROR`, `CONFIG_CHANGE`)
- `entity_type` (`INVOICE`, `RULE`, `CONFIG`, `SYSTEM`)
- `entity_id` (uuid/text)
- `payload_before` (jsonb), `payload_after` (jsonb)
- `ip_address`, `user_agent`
- `outcome` (`OK`, `ERROR`), `error_message`

### 4.7 `pa_channels`

Configurations des sources PA : `name`, `protocol` (`SFTP` / `API`), `host`, `port`, `user`, `password_encrypted`, `remote_path_in`, `remote_path_processed`, `api_base_url`, `api_auth_type`, `api_credentials_encrypted`, `poll_interval_seconds`, `active`.

### 4.8 `settings`

Clés/valeurs pour : URL Service Layer, CompanyDB par défaut, mapping TVA PA→B1, comptes par défaut, préférences UI.

---

## 5. Flux fonctionnel end-to-end

1. **Ingestion (worker)**
   - Scrute les canaux PA actifs toutes les N secondes.
   - Télécharge factures/avoirs + pièces jointes. Déplace les fichiers traités vers `processed/`.
   - Parse Factur-X / UBL / CII → insère `invoices` + `invoice_lines` + `invoice_files` (status `NEW`).
2. **Pré-matching automatique**
   - Matching fournisseur sur SIREN / VAT / nom (cache `suppliers_cache`). Score de confiance.
   - Application des `mapping_rules` (plus spécifique d'abord : supplier + keyword + taux TVA), remplit `suggested_account_code`.
   - Si tout est résolu avec confiance ≥ seuil config (par défaut 90) → status `READY`. Sinon `TO_REVIEW`.
3. **Revue utilisateur**
   - Liste filtrable/triable, détail côte-à-côte (PDF ↔ formulaire).
   - L'utilisateur corrige fournisseur / comptes / TVA. Chaque correction crée ou renforce une `mapping_rule` (usage_count++, confidence recalculée).
4. **Validation → SAP B1**
   - Bouton **« Valider et intégrer »** → choix _Facture de service_ ou _Écriture au journal_ (par défaut = préférence stockée sur le fournisseur ou globale).
   - Étape 1 : **upload du UBL** (+ PDF / Factur-X / annexes) via `POST /b1s/v1/Attachments2`. On récupère l'`AbsoluteEntry`. Si échec → statut `ERROR`, pas d'intégration.
   - Étape 2 : appel Service Layer pour créer le document (voir §7), avec `AttachmentEntry = {AbsoluteEntry}`.
   - En succès : statut `POSTED`, stockage `sap_doc_entry` / `sap_doc_num` / `sap_attachment_entry`.
5. **Rejet**
   - Bouton **« Rejeter »** → motif obligatoire, statut `REJECTED`.
6. **Retour PA**
   - Job envoie le statut final à la PA (API ou dépôt SFTP d'un fichier de statut selon le canal). `pa_status_sent_at` renseigné.
7. **Log**
   - Chaque étape ci-dessus écrit une ligne dans `audit_log`.

---

## 6. Écrans à produire

> Design **sobre et professionnel, inspiration SAP Fiori**, aux couleurs **IT-Spirit** : couleur primaire `[À COMPLÉTER — ex. #0A2540]`, accent `[À COMPLÉTER — ex. #00A8E8]`, fond clair `#F7F8FA`, texte `#1F2937`. Typo **Inter**. Coins arrondis `rounded-xl`, ombres discrètes, densité d'info élevée mais lisible. Logo IT-Spirit en haut à gauche (placeholder `/public/logo-itspirit.svg`).

### 6.1 `/login`

Carte centrée, champs CompanyDB / User / Password. Souvenir CompanyDB. Message d'erreur Service Layer en clair. Pas de « mot de passe oublié » (géré dans SAP B1).

### 6.2 `/` — **Cockpit** (dashboard)

- KPIs en haut : _À traiter_, _Prêtes_, _Intégrées aujourd'hui_, _En erreur_, _Rejetées_.
- Graphe barres 30j (reçues vs intégrées).
- Activité récente (5 dernières actions depuis `audit_log`).

### 6.3 `/invoices` — **Liste des factures & avoirs reçus**

- Filtres : statut, direction (facture/avoir), fournisseur, canal PA, période, montant, « nécessite revue ».
- Colonnes : date doc, n° doc PA, fournisseur (avec pastille de match), montant TTC, TVA, statut (badge coloré), canal PA, actions rapides.
- Actions de masse : Valider les « READY », Exporter CSV, Relancer le statut PA.
- Pagination serveur, recherche plein texte.

### 6.4 `/invoices/:id` — **Détail facture** (écran principal)

Layout 2 colonnes :

- **Gauche (50 %)** : viewer PDF de la facture reçue (pdf.js), onglets pour _PDF_, _XML source_, _Pièces jointes_.
- **Droite (50 %)** : panneau d'édition en 4 blocs :
  1. **En-tête** : fournisseur (combobox lié à `suppliers_cache`, bouton « Voir dans SAP B1 » ouvrant sur le CardCode), n° doc PA, date, échéance, devise.
     - Si pas de match : zone « Créer le fournisseur dans SAP B1 » ouvrant un sous-formulaire (appel `POST /BusinessPartners` avec les champs critiques — CardCode à proposer, CardName, FederalTaxID/TaxId0, adresse).
  2. **Lignes** : tableau éditable — description, quantité, PU, HT, code TVA SAP, TVA, TTC, **compte comptable** (combobox liée au plan comptable SAP B1, affiche `AcctCode — AcctName`), centre de coût.
     - Colonne **Suggestion** : chip coloré selon score (`vert` ≥ 90, `orange` 60-89, `rouge` < 60), avec icône info au survol expliquant la règle qui a matché.
     - Actions par ligne : _Accepter la suggestion_, _Modifier_, _Créer une règle_.
  3. **Récapitulatif TVA** : par taux, contrôle cohérence total PA vs total calculé (alerte si écart > 0,01 €).
  4. **Intégration SAP** : radio _Facture de service_ / _Écriture au journal_, sélecteur série (Series), date de comptabilisation (TaxDate / DocDate), référence (NumAtCard = n° PA), commentaire. Boutons : **Valider et intégrer** (primary), **Rejeter** (destructive), **Enregistrer le brouillon**.

Barre latérale droite rétractable : **Historique d'audit** de la facture (qui a fait quoi quand).

### 6.5 `/mapping-rules` — **Règles de mappage apprises**

- Tableau : portée (Global / Fournisseur), fournisseur, mot-clé, taux TVA, fourchette, compte, centre de coût, code TVA B1, confiance (barre), utilisations, dernière utilisation, active (toggle).
- Actions : éditer, désactiver, supprimer, **tester** (formulaire qui évalue la règle sur un libellé+montant+TVA fictifs).
- Import/export CSV.

### 6.6 `/suppliers` — **Fournisseurs**

- Miroir du cache `suppliers_cache` avec bouton **Resynchroniser depuis SAP B1**.
- Chaque ligne montre nb factures reçues, mappage par défaut, mode d'intégration par défaut.

### 6.7 `/logs` — **Journal d'audit**

- Filtres action / utilisateur SAP / entité / période / outcome.
- Ligne cliquable → modal avec diff JSON `payload_before` / `payload_after`.
- Export CSV.

### 6.8 `/settings`

- **Service Layer SAP B1** : URL, CompanyDB par défaut, timeout, test de connexion.
- **Canaux PA** : CRUD SFTP / API (champ password masqué, test de connexion).
- **Mappage TVA PA → B1** : tableau (ex. `20.00 → S1`, `5.50 → S3`…).
- **Comptes & séries par défaut** : compte d'attente, compte TVA déductible par taux, série de document par défaut.
- **Seuils** : seuil d'auto-validation (par défaut 90), seuil d'alerte écart (0,01).
- **Sécurité** : durée de session, IP allow-list (optionnel).

---

## 7. Intégration SAP B1 Service Layer — règles de mapping

### 7.1 Service Invoice (`POST /b1s/v1/PurchaseInvoices`)

```json
{
  "CardCode": "{supplier_b1_cardcode}",
  "DocType": "dDocument_Service",
  "DocDate": "{doc_date}",
  "DocDueDate": "{due_date | doc_date}",
  "TaxDate": "{doc_date}",
  "NumAtCard": "{doc_number_pa}",
  "Comments": "PA: {pa_source} / msg {pa_message_id}",
  "AttachmentEntry": "{attachment_entry}",
  "DocumentLines": [
    {
      "ItemDescription": "{description}",
      "AccountCode": "{chosen_account_code}",
      "LineTotal": "{amount_excl_tax}",
      "TaxCode": "{chosen_tax_code_b1}",
      "CostingCode": "{chosen_cost_center}"
    }
  ]
}
```

Même structure pour `PurchaseCreditNotes` en cas d'avoir.

### 7.2 Journal Entry (`POST /b1s/v1/JournalEntries`)

- `ReferenceDate` = doc_date, `DueDate` = due_date, `Reference` = doc_number_pa.
- `JournalEntryLines` : une ligne crédit sur le compte fournisseur (`ShortName` = CardCode), une ligne débit par compte de charge (montant HT), une ligne débit TVA par taux (compte de TVA déductible du mapping TVA).
- Contrôle débit = crédit avant envoi.
- Champ `AttachmentEntry` renseigné avec l'ID retourné par l'upload (§7.3).

### 7.3 Pièce jointe UBL / Factur-X / PDF dans SAP B1 — **obligatoire**

Pour **toute** facture de service, avoir ou écriture au journal créé par l'application, le(s) fichier(s) source reçus de la PA doivent être **attachés au document SAP B1** :

- **Fichier principal** : le **UBL (XML)** reçu de la PA — c'est la preuve légale de la facture électronique.
- **Fichiers secondaires** (si présents) : PDF de visualisation, Factur-X complet, pièces jointes complémentaires reçues de la PA (bons de livraison, etc.).

**Flux technique (Service Layer) :**

1. **Upload de la pièce jointe** :

   ```
   POST /b1s/v1/Attachments2
   Content-Type: multipart/form-data
   Body: fichier(s) UBL + PDF + annexes éventuelles
   ```

   → Réponse : `{ "AbsoluteEntry": 123, "Attachments2_Lines": [ ... ] }`.

   > Variante alternative : écrire d'abord le fichier dans le **Attachments Folder** configuré dans SAP B1 (chemin partagé accessible par le Service Layer), puis créer l'`Attachments2` avec `AttachmentPath` pointant dessus. À utiliser si le dossier est accessible par le serveur applicatif.

2. **Référencement** : insérer `"AttachmentEntry": {AbsoluteEntry}` dans le payload de la `PurchaseInvoice` / `PurchaseCreditNote` / `JournalEntry`.

3. **Ajout ultérieur** (au cas par cas, ex. pièce complémentaire reçue après intégration) : `PATCH /b1s/v1/Attachments2({AbsoluteEntry})` pour ajouter des lignes dans `Attachments2_Lines`.

**Règles applicatives :**

- Conventions de nommage des fichiers uploadés : `{pa_message_id}_{direction}_{docnum}.xml` / `.pdf`. Préserver le nom d'origine en commentaire.
- Si l'upload de pièce jointe **échoue** → l'intégration SAP B1 est **bloquée** (statut `ERROR`, pas d'envoi du statut à la PA). Une facture ne doit **jamais** être créée dans SAP sans son UBL attaché.
- Dans la table `invoices`, ajouter les champs : `sap_attachment_entry` (int) + `sap_attachment_uploaded_at` (timestamptz).
- Dans `audit_log`, tracer l'upload (`action=POST_SAP`, `entity_type=ATTACHMENT`, `payload_after` = `{AbsoluteEntry, files: [...]}`).
- Dans l'écran **Détail facture**, afficher un indicateur « 📎 UBL attaché dans SAP (AttachmentEntry #123) » une fois l'intégration réussie, cliquable pour ouvrir le fichier depuis l'app (lien vers `/api/invoices/:id/files/xml`).

### 7.4 Erreurs Service Layer

- Capturer `error.code` / `error.message.value` → afficher en clair, enregistrer `audit_log.outcome=ERROR`, statut facture `ERROR`, **pas** de retour vers la PA tant que non résolu.
- Bouton **Réessayer** disponible sur les factures `ERROR`.

---

## 8. Moteur de règles de mappage (apprentissage)

Algorithme simple, **explicable, sans ML** :

1. Sur chaque ligne de facture :
   a. Filtrer les règles `active=true` dont les critères renseignés sont tous satisfaits :
   - `supplier_cardcode` correspond (une règle SUPPLIER l'emporte sur GLOBAL).
   - `match_keyword` présent dans `description` (ILIKE, insensible accents/casse).
   - `match_tax_rate` = taux de la ligne.
   - Montant dans `[match_amount_min, match_amount_max]` si définis.
     b. Score = `confidence` × bonus spécificité (SUPPLIER +20, keyword +15, tax_rate +10, fourchette +5, plafond 100).
     c. Retenir la règle au plus haut score comme suggestion.
2. **Apprentissage** à chaque validation :
   - Si l'utilisateur **accepte** la suggestion → `usage_count++`, `confidence = min(100, confidence + 2)`.
   - Si l'utilisateur **modifie** vers un autre compte → créer (ou renforcer) une règle SUPPLIER + keyword (mot le plus discriminant de la description) + tax_rate ciblant le nouveau compte, confidence initiale 60 ; la règle précédente perd 5 points de confidence.
   - Bouton explicite « **Créer une règle à partir de cette ligne** » pour forcer la création d'une règle plus large (GLOBAL) avec prévisualisation.
3. **Nettoyage** : une tâche hebdo désactive les règles dont `confidence < 20` et `last_used_at` > 180j.

Toute création/modif/désactivation de règle est tracée dans `audit_log` (`action=EDIT_MAPPING`).

---

## 9. Retour de statut vers la PA

- **API** : `POST {pa_api_base}/invoices/{pa_message_id}/status` avec body `{ status, reason, sap_doc_num, posted_at }`.
- **SFTP** : dépôt d'un fichier `status_{pa_message_id}.json` dans `remote_path_out`.

Retry exponentiel (1min, 5min, 30min, 2h, 12h) avec journalisation, jusqu'à succès ou abandon manuel.

---

## 10. Journalisation (audit log) — exigences

- **Toute** action mutatrice OU sensible est loggée : login/logout, consultation d'une facture, édition de règle, validation/rejet, appel SAP (OK/KO + payload tronqué), envoi statut PA, modif config.
- Logs **immuables** (pas de suppression ni d'édition depuis l'UI, seul un job de rétention configurable peut archiver > 24 mois vers du cold storage JSON).
- Vue `/logs` consultable par tout utilisateur connecté (filtrage par utilisateur SAP si besoin).
- Export CSV horodaté.
- Tous les logs incluent l'`ip_address` et le `user_agent`.

---

## 11. UX — principes à respecter

- **Navigation principale** : barre latérale gauche, 6 entrées (Cockpit, Factures, Règles, Fournisseurs, Logs, Paramètres). Repliable.
- **Raccourcis clavier** : `J`/`K` pour naviguer entre factures, `V` valider, `R` rejeter, `/` focus recherche, `?` affiche l'aide.
- **Feedback instantané** : toasts discrets (succès vert, erreur rouge, info bleu IT-Spirit). Jamais d'alert() natives.
- **États vides** illustrés (empty states) avec CTA explicite.
- **Chargements** : squelettes (skeletons), pas de spinner plein écran sauf login.
- **Accessibilité** : contrastes AA min, focus visible, navigation clavier complète, labels aria sur toutes les actions.
- **Responsive** : desktop first (1280+), mais utilisable à 1024 px. Pas de besoin mobile.
- **i18n-ready** (clés de traduction centralisées via `react-i18next`), mais une seule langue active : **français**.

---

## 12. Configuration & déploiement

Livrer :

- `docker-compose.yml` avec services `web`, `api`, `worker`, `postgres`, `redis`.
- `Dockerfile` multi-stage pour front et back.
- `.env.example` documenté (toutes les variables : `SL_BASE_URL`, `DB_URL`, `REDIS_URL`, `APP_SECRET`, `SESSION_ENC_KEY`, `FILE_STORAGE_PATH`, etc.).
- Script `npm run migrate` (Prisma ou Drizzle) qui crée/upgrade le schéma.
- Script `npm run seed` qui charge un jeu de données de démo (désactivé en prod).
- `README.md` d'installation on-premise : prérequis (Node 20, Postgres 15, Redis 7, accès HTTPS vers Service Layer), étapes d'install, mise à jour, sauvegarde, restauration.
- Healthchecks : `/api/health` (DB + Redis + Service Layer ping optionnel).

---

## 13. Tests attendus

- **Unit** : parseurs Factur-X/UBL/CII, moteur de règles, calcul de scores, mapping vers payload Service Layer, contrôle équilibre journal entry.
- **Intégration** : endpoints REST, flux login/logout, cycle de vie d'une facture (NEW → POSTED), création de règles à la volée.
- **E2E (Playwright)** : login, ingestion d'une facture fixture, revue, validation, vérification du POST Service Layer (mock), envoi statut PA (mock).
- Coverage cible ≥ 70 % sur `api/`.

---

## 14. Livrables

1. Code source versionné (monorepo : `apps/web`, `apps/api`, `apps/worker`, `packages/shared`).
2. Schéma de base documenté (migration + diagramme Mermaid dans le README).
3. Captures d'écran des principaux écrans (Cockpit, Liste, Détail, Règles, Logs).
4. Documentation utilisateur FR (`/docs/user-guide.md`) : 1 page par écran.
5. Documentation admin FR (`/docs/admin-guide.md`) : installation, maintenance, rotation des secrets, stratégie de sauvegarde DB + fichiers.
6. Postman collection pour les endpoints back-end.

---

## 15. Contraintes de qualité

- **Pas** de données mock en dur dans le front : tout passe par l'API.
- **Pas** d'appel direct Service Layer depuis le navigateur.
- Aucun secret en clair dans le code, aucune URL SAP commitée.
- Code TypeScript strict (`"strict": true`), ESLint + Prettier + commit hooks.
- Messages d'erreur utilisateur en français, **jamais** de stacktrace affichée côté UI.
- Internationalisation prête même si une seule langue.

---

## 16. Ce sur quoi je veux que tu me poses des questions avant de coder

Si une information te manque, demande-moi plutôt que d'inventer :

1. Version exacte de SAP B1 + Service Layer (SQL / HANA) et version d'API cible.
2. Format(s) exact(s) produit(s) par la PA (Factur-X profil MINIMUM/BASIC/EN16931/EXTENDED ? UBL 2.1 ? CII ?).
3. Règles TVA spécifiques client (taux applicables, codes SAP existants).
4. Plan comptable cible (extrait PCG ou spécifique).
5. Politique de nommage CardCode pour la création automatique de fournisseurs.
6. Charte graphique IT-Spirit (codes hex définitifs, logo SVG).

---

Construis cette application de bout en bout en suivant ce cahier des charges. Commence par l'ossature (docker-compose, schéma DB, auth Service Layer, squelette des 7 écrans), puis itère écran par écran en commençant par `/invoices` + `/invoices/:id` qui sont le cœur du produit.
