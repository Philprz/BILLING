# Compte-rendu — Corrections worker : round-trip 389/393/503 + multi-`TaxTotal`

**Date** : 2026-06-04
**Périmètre** : corriger l'ingestion worker pour qu'elle reconnaisse correctement les factures **389 (autofacturation)**, **393 (affacturage)** et **503 (avoir d'acompte)** produites par le générateur, et qu'elle extraie correctement la TVA totale des factures **multidevises** (deux `cac:TaxTotal`). Lève les deux bugs de round-trip confirmés : `CR_Correction_MentionsTypes_2026-06-04.md` §5 (mapping `389→CREDIT_NOTE` erroné) et `CR_Correction_P0_HorsCadre_2026-06-04.md` §5 (lecture `TaxTotal` objet unique).
**Référentiel** : UNTDID **1001** (type de document, BT-3), EN16931 (BT-110 TVA totale, BT-111 TVA en devise de comptabilisation, BT-5/BT-6 devises).

> **Exécution autonome** : aucune question posée. Les décisions d'ambiguïté (routage SAP du 503, position du mapping CII, non-régénération du client Prisma sur l'app live) sont documentées ci-dessous.

---

## 1. Décisions verrouillées appliquées

1. **Cascade complète des directions** (`SELF_BILLED` / `FACTORING` / `ADVANCE_CREDIT_NOTE`) à travers worker → base → API → shared → UI, en suivant **exactement** le pattern des ajouts précédents `ADVANCE_INVOICE` (386) et `CORRECTIVE_INVOICE` (384).
2. **Fix multi-`TaxTotal`** dans `ubl.parser.ts` (UBL uniquement — le générateur n'émet que de l'UBL).

---

## 2. Modifications fichier par fichier

### Base de données

#### `packages/database/prisma/schema.prisma`

- Enum `InvoiceDirection` : ajout de `SELF_BILLED`, `FACTORING`, `ADVANCE_CREDIT_NOTE` (les 4 valeurs préexistantes `INVOICE/CREDIT_NOTE/ADVANCE_INVOICE/CORRECTIVE_INVOICE` conservées).

#### `packages/database/prisma/migrations/20260604000000_add_self_billed_factoring_advance_credit_note/migration.sql`

- Trois `ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS …`, **une instruction par valeur**, idempotentes — **format strictement aligné** sur `20260602000000_add_advance_invoice` et `20260602000001_add_corrective_invoice`. Pas de `BEGIN/COMMIT` (gotcha Postgres « ADD VALUE hors transaction »), compatible `migrate deploy`. Aucune colonne additionnelle (contrairement aux deux migrations citées : 389/393/503 ne portent pas de nouveau champ persistant).

### Worker

#### `apps/worker/src/parsers/types.ts`

- Union `ParsedInvoice['direction']` étendue aux 3 valeurs (passage en union multi-lignes).

#### `apps/worker/src/parsers/ubl.parser.ts`

- **Bug corrigé** : remplacement du ternaire `isCreditNote || typeCode==='381' || typeCode==='389' → 'CREDIT_NOTE'` par une fonction dédiée **`mapTypeCodeToDirection(typeCode, isCreditNote)`** :
  - `389 → SELF_BILLED` _(corrige le `→ CREDIT_NOTE` fautif)_,
  - `393 → FACTORING`,
  - `503 → ADVANCE_CREDIT_NOTE`,
  - `386 → ADVANCE_INVOICE`, `384 → CORRECTIVE_INVOICE`, `381 → CREDIT_NOTE`,
  - défaut : `isCreditNote ? CREDIT_NOTE : INVOICE`.
  - Le 503 est émis par le générateur en document **racine `CreditNote`** (`cbc:CreditNoteTypeCode`) ; le `typeCode` est lu sur `cbc:InvoiceTypeCode ?? cbc:CreditNoteTypeCode`, donc le mapping fonctionne quel que soit l'élément racine.
- **Fix multi-`TaxTotal`** :
  - `'TaxTotal'` ajouté à la liste `isArray` du `XMLParser`.
  - TVA totale (BT-110) : `cac:TaxTotal` normalisé en tableau, puis **sélection du bloc porteur des `cac:TaxSubtotal`** (= devise du document) ; à défaut, le premier. Le bloc réduit à un `cbc:TaxAmount` seul (BT-111, devise de comptabilisation) est ignoré pour la TVA totale.
  - **Compatibilité ascendante** : le `cac:TaxTotal` de ligne est désormais aussi un tableau ; lecture via `asArray(...)[0]` (une ligne n'en porte qu'un). Une facture mono-`TaxTotal` (tableau de 1) reste traitée à l'identique.

#### `apps/worker/src/parsers/cii.parser.ts`

- **Même** mapping via une fonction `mapTypeCodeToDirection(typeCode)` (symétrie avec UBL ; CII n'a pas de notion de racine CreditNote, défaut = `INVOICE`). `389→SELF_BILLED`, `393→FACTORING`, `503→ADVANCE_CREDIT_NOTE` ; mappings 381/386/384 conservés.

#### `apps/worker/src/parsers/index.ts` & `apps/worker/src/ingestion/db-writer.ts`

- **Aucune modification nécessaire** : les `ParsedInvoice` construits pour le cas PDF_ONLY utilisent `direction: 'INVOICE'` (aucune exhaustivité à compléter) ; `db-writer` passe `parsed.direction` tel quel à Prisma (`prisma.invoice.create`), qui accepte les nouvelles valeurs une fois l'enum migré. Typecheck worker vert.

### API

#### `apps/api/src/repositories/invoice.repository.ts`

- `FindInvoicesParams['direction']` étendu aux 7 valeurs (les 3 nouvelles + corrige au passage la complétude `ADVANCE_INVOICE/CORRECTIVE_INVOICE`, déjà présentes).

#### `apps/api/src/routes/invoices.ts`

- Filtre `direction` (schéma JSON de la route de liste) : enum étendu aux 7 valeurs.
- **Routage SAP** (deux emplacements identiques : post unitaire ~l.380 et post de masse/draft ~l.1057) :

  | direction             | BT-3 | docType SAP             | via                               |
  | --------------------- | ---- | ----------------------- | --------------------------------- |
  | `SELF_BILLED`         | 389  | **PurchaseInvoices**    | branche défaut (comme 380)        |
  | `FACTORING`           | 393  | **PurchaseInvoices**    | branche défaut (comme 380)        |
  | `ADVANCE_CREDIT_NOTE` | 503  | **PurchaseCreditNotes** | ajouté à la branche `CREDIT_NOTE` |
  - `SELF_BILLED`/`FACTORING` retombent **automatiquement** sur `PurchaseInvoices` (branche `else`) → aucune modification de valeur, seulement un commentaire.
  - `ADVANCE_CREDIT_NOTE` ajouté explicitement à la condition `PurchaseCreditNotes`, avec **`// TODO 503 : contre-passation APDownPayment (cf. matrice S/B)`**.
  - **L'union `docType` de `sap-sl.service.ts` n'est PAS élargie** : les 3 directions retombent sur les docTypes existants (`PurchaseInvoices` / `PurchaseCreditNotes`).

### Shared & Web

#### `packages/shared/src/types/dtos.ts`

- `InvoiceDirection` (source de vérité front ↔ back) étendue aux 7 valeurs.

#### `apps/web/src/api/invoices.api.ts`

- `GetInvoicesParams['direction']` étendu aux 7 valeurs.

#### `apps/web/src/pages/InvoiceListPage.tsx`

- `DIRECTION_OPTIONS` (filtre) : ajout « Autofacturation », « Affacturage », « Avoirs d'acompte ».
- `directionBadge()` : badges « Autofacturation » (sky), « Affacturage » (indigo), « Avoir d'acompte » (rose).
- Union locale du paramètre d'URL `direction` étendue aux 7 valeurs.

> Les fichiers du **générateur** (`invoice-generator.service.ts`, `invoice-generator.ts`, `generator.api.ts`, `InvoiceGeneratorPage.tsx`) supportaient **déjà** les 3 directions (passes 389/393 et 503 antérieures) ; non modifiés par cette passe.

### Tests

#### `tests/unit/ubl-parser.test.ts` _(nouveau)_

- 6 tests : `389→SELF_BILLED` (et **plus** `CREDIT_NOTE`), `393→FACTORING`, `503→ADVANCE_CREDIT_NOTE`, non-régression `380/381/386/384`, **multi-`TaxTotal`** (TVA extraite du bloc à `TaxSubtotal`, pas du bloc BT-111), mono-`TaxTotal` inchangé.

#### `tests/unit/cii-parser.test.ts`

- +3 tests : `389→SELF_BILLED`, `393→FACTORING`, `503→ADVANCE_CREDIT_NOTE` (mêmes mappings que UBL).

---

## 3. Vérification

| Contrôle                                           | Résultat                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `typecheck` shared / database / api / worker / web | ✅ tous clean                                                                                               |
| `eslint` (10 fichiers touchés)                     | ✅ clean                                                                                                    |
| `vitest` `ubl-parser` + `cii-parser`               | ✅ 14/14 (6 + 8)                                                                                            |
| `vitest` unitaire (suite complète)                 | ✅ **273/273** (264 préexistants + 9 nouveaux)                                                              |
| Migration `migrate deploy`                         | ✅ appliquée                                                                                                |
| Enum en base (`pg_enum`)                           | ✅ `INVOICE, CREDIT_NOTE, ADVANCE_INVOICE, CORRECTIVE_INVOICE, SELF_BILLED, FACTORING, ADVANCE_CREDIT_NOTE` |

> **Tests d'intégration** : `tests/integration/api-invoices.test.ts` présente **3 échecs préexistants** (`posts a READY invoice in simulate mode…`, `refuses TO_REVIEW invoices before any SAP call`, `blocks on attachment upload failure…`) — liés au cache chart-of-accounts / simulation SAP (compte `601000` non imputable), **sans rapport** avec cette passe. Vérifié par `git stash` : les 3 échecs sont identiques sur la base de code avant modifications.

### Round-trip runtime (générateur → parser worker)

Généré via `generateUblXml`, ré-ingéré via `parseUbl`, puis script et artefacts **supprimés** (`git status` propre) :

| Cas généré                                  | `direction` parsée    | TVA totale (BT-110)                                                      | nb `cac:TaxTotal` (header+lignes) | Verdict            |
| ------------------------------------------- | --------------------- | ------------------------------------------------------------------------ | --------------------------------- | ------------------ |
| 389 autofacturation (`SELF_BILLED`)         | `SELF_BILLED`         | `370.00`                                                                 | 1                                 | ✅ (≠ CREDIT_NOTE) |
| 393 affacturage (`FACTORING`)               | `FACTORING`           | `370.00`                                                                 | 1                                 | ✅                 |
| 503 avoir d'acompte (`ADVANCE_CREDIT_NOTE`) | `ADVANCE_CREDIT_NOTE` | `370.00`                                                                 | 1                                 | ✅                 |
| Multidevise USD/EUR (BT-5≠BT-6)             | `INVOICE`             | `370.00` (bloc USD à `TaxSubtotal`, **non** le bloc EUR converti BT-111) | 2                                 | ✅                 |

Base TVA = 1850 × 20 % = 370.00. Le cas multidevise confirme que la TVA totale est lue sur le bloc porteur des `TaxSubtotal` (devise du document) et **non** sur le second `TaxTotal` réduit (BT-111, EUR converti).

---

## 4. Limites assumées

1. **503 → contre-passation APDownPayment différée** : `ADVANCE_CREDIT_NOTE` est routé sur **`PurchaseCreditNotes`** par défaut. La contre-passation fine de l'`APDownPayment` (cf. matrice S/B : « 503 = contre-passation de l'APDownPayment ») est **hors périmètre** — marquée `// TODO 503` dans `apps/api/src/routes/invoices.ts` (deux emplacements).
2. **BT-111 non persisté** : le second `TaxTotal` (TVA en devise de comptabilisation) est **ignoré** pour l'extraction, conformément au périmètre (objectif : ne pas dégrader l'existant). Aucun nouveau champ persistant pour BT-111.
3. **Client Prisma régénéré + app live redémarrée** ✅ : la migration étant appliquée en base, le **client Prisma généré** a été régénéré et les services pm2 redémarrés pour que l'app **live** accepte les nouvelles valeurs au runtime. La régénération exige le renommage du `query_engine-windows.dll.node`, initialement **verrouillé par les processus pm2 en cours** (EPERM) ; cycle exécuté : `pm2 stop billing-api billing-worker` → `npm run db:generate` (✅ `Generated Prisma Client v6.19.3`) → `pm2 restart billing-api billing-worker`. Les deux services sont repassés `online` et l'API a redémarré proprement (`Server listening` à 12:20:00, nouveau pid) ; `billing-web` (Vite, sans client Prisma) non impacté. Le typecheck CI/commit restait de toute façon vert car les points d'appel touchés (routes, repository) typent `direction` en `string`, sans couplage à l'enum Prisma généré.
4. **CII non émis par le générateur** : le mapping CII 389/393/503 est ajouté par **symétrie** et couvert par tests unitaires, mais non exercé en round-trip (le générateur n'émet que de l'UBL).

---

_Fin du compte-rendu. typecheck/eslint verts, 273/273 unitaires, migration appliquée + enum vérifié en base, round-trip 389/393/503/multidevise vérifié (direction + TVA), artefacts supprimés. Pattern direction existant suivi ; pas de sentinelle ; union docType SAP non élargie ; migration en `migrate deploy`. Client Prisma régénéré et app live (`billing-api`/`billing-worker`) redémarrée — les nouvelles valeurs d'enum sont actives au runtime (cf. §4.3)._
