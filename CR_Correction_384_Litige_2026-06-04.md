# Compte-rendu — Flux 384 (rectificative) lié au litige, côté ingestion

**Date** : 2026-06-04
**Périmètre** : faire en sorte qu'une **facture rectificative 384** reçue de la PA soit **reliée** à l'originale mise en litige, **acceptée** (et non rejetée comme doublon), que l'originale soit **clôturée/supersédée**, et que le 384 suive le flux normal. Avant cette passe, un 384 réutilisant le n° de l'originale était **silencieusement écarté** par le dédoublon métier `docNumber+supplier` (`db-writer.ts` L.52-67).
**Référentiel** : règle métier interview 2026-06-04 (décisions verrouillées) ; EN16931 BT-25 (BillingReference, `correctedInvoiceRef`) ; UNTDID 1001 (384) ; AFNOR XP Z12-012 (cadre BT-23).

> **Exécution autonome** : aucune question posée. Les points d'ambiguïté ont été tranchés et sont documentés en §5.

---

## 1. Décisions verrouillées appliquées

1. **Sort de l'originale** : nouveau statut terminal **`SUPERSEDED`** (« Remplacée par une rectificative 384 »), distinct de `REJECTED`, avec **lien** `replacesInvoiceId` porté par le 384.
2. **Matching de l'originale** : même `supplierPaIdentifier` **et** `docNumberPa == correctedInvoiceRef` **et** `status == 'DISPUTED'`.
3. **Échec de matching** (introuvable ou pas DISPUTED) : le 384 est créé en **`TO_REVIEW`** avec un `statusReason` explicite, **sans** supersession. On ne perd jamais la facture.
4. **Dédoublon** : seul le dédoublon **métier** `docNumber+supplier` est contourné, et **uniquement** pour `direction == CORRECTIVE_INVOICE` **avec** `correctedInvoiceRef`. Les dédoublons d'**idempotence** (`paMessageId`) et de **contenu** (SHA-256) restent actifs en tête.

---

## 2. Modifications fichier par fichier

### Base — `packages/database/prisma/schema.prisma`

- **Enum `InvoiceStatus`** : ajout **`SUPERSEDED`** (commentaire : « Remplacée par une facture rectificative 384 »).
- **Model `Invoice`** :
  - colonne `replacesInvoiceId String? @db.Uuid @map("replaces_invoice_id")` ;
  - **self-relation `"Correction"`** : `replaces Invoice? @relation(..., onDelete: SetNull)` (porté par le 384) + back-relation `supersededBy Invoice[]`.
  - **Contrainte d'unicité** : `@@unique([docNumberPa, supplierPaIdentifier])` **retirée** au profit d'un **INDEX UNIQUE PARTIEL** `WHERE status <> 'SUPERSEDED'` créé en SQL brut (Prisma ne sait pas exprimer les index partiels), + un `@@index([docNumberPa, supplierPaIdentifier])` plein pour les lookups de dédoublon. Voir §5.1.

### Migrations (`packages/database/prisma/migrations/`) — pattern enum existant suivi

- **`20260604120000_add_superseded_status_and_replaces/migration.sql`** :
  - `ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';`
  - `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "replaces_invoice_id" UUID;`
  - FK self `invoices_replaces_invoice_id_fkey` (`ON DELETE SET NULL`) + index sur la colonne FK.
- **`20260604120100_partial_unique_doc_supplier/migration.sql`** (séparée car elle **utilise** la valeur d'enum `SUPERSEDED` — interdit dans la même transaction que son `ADD VALUE`) :
  - `DROP CONSTRAINT IF EXISTS` (ancien + nouveau nom historique de la contrainte pleine) ;
  - `CREATE INDEX idx_invoices_doc_supplier` (plein, non unique) ;
  - `CREATE UNIQUE INDEX uq_invoices_doc_supplier_active ... WHERE "status" <> 'SUPERSEDED'`.

### Worker — `apps/worker/src/ingestion/db-writer.ts`

- **`buildInvoiceCreateData(...)`** _(nouveau)_ : extraction du mapping `ParsedInvoice → Prisma.InvoiceCreateInput`, paramétrable par `overrides` (status / statusReason / replaces). Évite la duplication entre flux normal et 384.
- **`handleCorrectiveInvoice(parsed, buildData)`** _(nouveau)_ : recherche de l'originale DISPUTED ; si trouvée → **transaction** (supersession de l'originale **puis** création du 384 `NEW` + `replaces.connect`) ; sinon → 384 en `TO_REVIEW` + `statusReason`.
- **`writeInvoice`** : la branche 384 (`direction === 'CORRECTIVE_INVOICE' && correctedInvoiceRef`) est insérée **après** les dédoublons `paMessageId` / SHA-256 et **avant** le dédoublon métier (inchangé). Les `fs.unlinkSync` factorisés dans `deleteStoredFile`.

### Générateur — `apps/api/src/services/invoice-generator.service.ts`

- `computeCadre` : **`384` ajouté à `COMMERCIAL_TYPES`** → le cadre BT-23 du 384 peut être **1/2/4** (4 si `prepaidAmount > 0`), comme un 380. Commentaire de la matrice mis à jour (384 = nouvelle facture de remplacement, pas un avoir).

### API — DTO / repository / routes

- **`packages/shared/src/types/dtos.ts`** : `InvoiceStatus` += `'SUPERSEDED'` ; nouveau type **`InvoiceSupersedeRef`** ; `InvoiceDetail` += `replaces` / `supersededBy`.
- **`apps/api/src/repositories/invoice.repository.ts`** : `InvoiceDetailDto` += `replaces` / `supersededBy` ; `findInvoiceById` **inclut** les relations `replaces` (select léger) et `supersededBy` (`take: 1`) + mapper `mapSupersedeRef`.
- **`apps/api/src/routes/invoices.ts`** : `SUPERSEDED` ajouté à `INVOICE_STATUSES` (filtre liste) et à **`TERMINAL_STATUSES`** + à `nonLinkableStatuses` (Voie B) → **aucune action SAP / modification** sur une facture SUPERSEDED.

### Web — `apps/web`

- **`components/ui/badge.tsx`** : entrée `SUPERSEDED` (label « Remplacée », teinte ardoise/gris).
- **`pages/InvoiceListPage.tsx`** : option de filtre « Remplacées ».
- **`pages/InvoiceDetailPage.tsx`** : bandeau de supersession — sur le 384 « Cette facture rectificative (384) remplace la facture {n°} » (lien) ; sur l'originale « Facture remplacée par la rectificative (384) {n°} » (lien).

---

## 3. Comportement (scénarios de test)

| Cas                             | Entrée                                                          | Résultat                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 384 + originale **DISPUTED**    | `direction=CORRECTIVE_INVOICE`, `correctedInvoiceRef=<n° orig>` | 384 créé `NEW`, `replaces=orig` ; originale → **`SUPERSEDED`** (`statusReason`) ; **dédoublon métier contourné** (même si n° identique) |
| 384 **sans** originale DISPUTED | `correctedInvoiceRef` introuvable / pas DISPUTED                | 384 créé **`TO_REVIEW`** + `statusReason` « Rectificative 384 sans facture en litige correspondante (réf. …) », pas de supersession     |
| 384 = **renvoi identique**      | même `paMessageId` **ou** même SHA-256                          | **ignoré** (`created:false`) — idempotence/contenu préservés                                                                            |
| **380** avec n° déjà existant   | facture normale                                                 | **écartée** comme doublon métier (comportement **inchangé**)                                                                            |
| Générateur — **cadre 384**      | `CORRECTIVE_INVOICE`                                            | `S1` (non payée), `S2` (payée), **`B4`** (acompte sur biens)                                                                            |

---

## 4. Vérification

| Contrôle                                         | Résultat                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma validate`                                | ✅ schéma valide                                                                                                                                                                                        |
| `typecheck` (shared, database, api, worker, web) | ✅ **clean** (les types du client Prisma ont bien été régénérés ; voir §5.2)                                                                                                                            |
| `eslint` (10 fichiers touchés)                   | ✅ clean                                                                                                                                                                                                |
| `vitest` **unitaire** (suite complète)           | ✅ **292/292** (285 + 7 nouveaux)                                                                                                                                                                       |
| `migrate deploy`                                 | ✅ 2 migrations appliquées                                                                                                                                                                              |
| Vérification SQL post-migration                  | ✅ enum `SUPERSEDED` présent ; index partiel `uq_invoices_doc_supplier_active (… WHERE status <> 'SUPERSEDED')` ; colonne `replaces_invoice_id` (uuid, null) ; ancienne contrainte pleine **supprimée** |

**Tests ajoutés** :

- `tests/unit/db-writer-corrective.test.ts` _(nouveau, 6 tests)_ — flux 384 (mock Prisma) : supersession à n° identique, fallback TO_REVIEW, idempotence `paMessageId`/SHA-256, non-régression 380.
- `tests/unit/invoice-generator.test.ts` — +1 test cadre 384 (S1/S2/B4).

**Échecs hors périmètre (pré-existants)** : `tests/integration/api-invoices.test.ts` et `tests/e2e/local-smoke.test.ts` échouent en l'absence d'une base de test migrée dans cet environnement (erreur DB « column … does not exist » dans `tests/helpers/fixtures.ts`). **Vérifié** : ils échouent **à l'identique** avec mes modifications mises de côté (`git stash`) → ce ne sont **pas** des régressions de cette passe.

---

## 5. Décisions d'ambiguïté & limites assumées

1. **Index unique PARTIEL plutôt que contrainte pleine (écart documenté vs. brief)** : le brief ne mentionnait, pour le dédoublon, que le code métier (`db-writer.ts` L.52-67). Or il existait aussi une **contrainte d'unicité DB** `(doc_number_pa, supplier_pa_identifier)`. La décision verrouillée « le 384 doit pouvoir **coexister** avec l'originale, même à n° identique » est **impossible** sous une contrainte pleine (deux lignes persistées avec la même clé). J'ai donc remplacé la contrainte par un **index unique partiel** `WHERE status <> 'SUPERSEDED'` : l'originale supersédée sort du périmètre d'unicité, et **le dédoublon des factures actives (donc de toutes les non-384) reste strictement inchangé**. Aucun code n'utilisait le sélecteur composé `docNumberPa_supplierPaIdentifier` (vérifié) → pas d'impact. **Ordre transactionnel** : on supersède l'originale **avant** de créer le 384 (écart vs. l'ordre « créer puis superséder » du brief), requis par l'index partiel pour le cas n° identique ; résultat fonctionnel identique.
2. **Régénération du client Prisma & app live** : `npm run db:generate` a échoué sur le **swap du binaire du query engine** (`EPERM … query_engine-windows.dll.node`) car **pm2 (`billing-api`) tourne et verrouille la DLL**. Les **types TypeScript** du client ont en revanche bien été régénérés (écrits avant l'étape du binaire) → `typecheck` est valide. Le **binaire runtime reste l'ancien** : c'est sans effet pour l'app live qui tourne encore **l'ancien code + l'ancien moteur** (le schéma additif ne casse rien). **Je n'ai pas arrêté pm2** (app live traitant des factures = action potentiellement disruptive). Voir §6.
3. **Migration appliquée mais runtime non testé en bout-en-bout** : `migrate deploy` est **additif/idempotent** et **sans risque de violation d'unicité** (l'ancienne contrainte garantissait déjà l'unicité), donc appliqué et vérifié en SQL. En revanche le **test runtime d'injection** (facture en litige → 384 → supersession/lien) nécessite que le **worker** charge le **nouveau code + nouveau moteur** : impossible sans `pm2 restart`. Couverture assurée par les tests unitaires (mock Prisma) + la vérification SQL ; le test runtime reste à faire en fenêtre de maintenance (§6).
4. **`replaces` via `connect`** : la création du 384 lie l'originale par `replaces: { connect: { id } }` (relation Prisma) plutôt que d'écrire `replacesInvoiceId` en brut — sémantiquement équivalent, idiomatique.
5. **`supersededBy` = `take: 1`** : une originale n'est, en pratique, supersédée que par un seul 384 ; le mapper renvoie la première (ou `null`).
6. **Actions SAP sur SUPERSEDED** : bloquées via `TERMINAL_STATUSES` (modif/intégration) et `nonLinkableStatuses` (Voie B). L'intégration directe (POST SAP) n'est de toute façon ouverte qu'au statut `READY`, inatteignable depuis `SUPERSEDED`.

---

## 6. ⚠️ Étape post-déploiement (à exécuter en fenêtre de maintenance)

La migration DB est **déjà appliquée**. Restent les étapes qui nécessitent d'**arrêter l'app live** (DLL du query engine verrouillée par pm2) :

```sh
pm2 stop ecosystem.config.cjs        # ou: npm run pm2:stop
npm run db:generate                  # régénère le binaire du query engine (échoue si pm2 tourne → EPERM)
npm run build                        # recompile api/worker/web avec le nouveau code
npm run pm2:start                    # ou pm2:restart
```

**Vérification runtime à faire ensuite** (§3, ligne 1) : injecter une facture en litige (`DISPUTED`) puis un **384** la référençant via `correctedInvoiceRef` ; contrôler que le 384 ressort `NEW`/`replaces` renseigné, l'originale `SUPERSEDED`, le lien visible côté détail, et que le 384 suit le flux normal vers SAP.

---

## 7. Contraintes respectées

- Dédoublon des factures **non-384 inchangé** (index partiel n'exclut que les SUPERSEDED ; code métier `db-writer.ts` intact pour les non-384).
- Idempotence `paMessageId` / doublon SHA-256 **préservés** (en tête de `writeInvoice`).
- **Pattern de migration d'enum existant suivi** (`ADD VALUE IF NOT EXISTS`, valeur d'enum non utilisée dans la transaction de son ajout → migration de l'index partiel séparée).
- Pas de sentinelle ; tout écart documenté (§5).

---

_Fin du compte-rendu. typecheck/eslint verts, 292/292 unitaires, migration appliquée et vérifiée en SQL (enum + index partiel + colonne + drop de l'ancienne contrainte). Runtime end-to-end et reload du moteur Prisma = étape de maintenance (§6), app live non interrompue._
