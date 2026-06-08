# Compte-rendu — Correction 386 : EntitySet acompte (`PurchaseDownPayments`) + payload `DownPaymentType`

**Date** : 2026-06-05
**Périmètre** : bug **bloquant** découvert pendant le correctif 503 (`CR_Correction_503_ContrePassation_2026-06-05.md` §1.4) — le code postait l'acompte 386 sur l'EntitySet **`APDownPayments`**, **inexistant** dans le Service Layer cible → `GET/POST APDownPayments` = **HTTP 400 « Unrecognized resource path »**. Le bon EntitySet est **`PurchaseDownPayments`**. De plus, le payload acompte était strictement générique (pas de `DownPaymentType`).
**Impact** : le POST d'un 386 échouait en production → aucun acompte n'atteignait `POSTED` (`sapDocEntry`), rendant **F3 et 503** (qui exigent un 386 `POSTED` pour retrouver son `DocEntry`) **inopérants**. Ce correctif débloque toute la chaîne acompte.
**Mode** : exécution autonome. SAP joignable (PROD), accès **lecture seule confirmé** (Login + GET) ; **aucune écriture** SAP. Aucune migration. Mot de passe jamais loggué.

---

## 1. Étape 1 — Renommage de l'entité (`APDownPayments` → `PurchaseDownPayments`)

Occurrences code recensées (grep exhaustif) et corrigées :

| Fichier                                                           | Avant                         | Après                          |
| ----------------------------------------------------------------- | ----------------------------- | ------------------------------ |
| `apps/api/src/routes/invoices.ts` (routage bulk)                  | `… ? 'APDownPayments'`        | `'PurchaseDownPayments'`       |
| `apps/api/src/routes/invoices.ts` (routage unitaire)              | `… ? 'APDownPayments'`        | `'PurchaseDownPayments'`       |
| `apps/api/src/services/sap-sl.service.ts` (union `docType`)       | `… \| 'APDownPayments'`       | `… \| 'PurchaseDownPayments'`  |
| `apps/api/src/services/sap-sl.service.ts` (commentaire)           | « partage la même structure » | corrigé (cf. §3)               |
| `apps/api/src/services/down-payment.service.ts` (commentaire doc) | `386 \`APDownPayments\``      | `386 \`PurchaseDownPayments\`` |

Vérifications : **aucune** autre référence `APDownPayments` dans `apps/` (hormis le commentaire explicatif du bug dans `sap-sl.service.ts`), **aucune** dans `tests/`, **aucun** type résiduel. Les CR historiques et les scripts d'inspection ne sont pas réécrits (traces d'audit).

---

## 2. Étape 2 — Confirmation LIVE de la structure `PurchaseDownPayments` (lecture seule)

Script reproductible : `scripts/inspect-purchasedownpayment-metadata.ts` (Login + `GET /$metadata` + `GET` exemples). SL réel : `SBODemoFR @ 141.94.132.62:50000/b1s/v1`.

### 2.1 EntitySet

`GET /PurchaseDownPayments` → **HTTP 200** ; `GET /APDownPayments` → **HTTP 400** (confirme le bug). Sets liés présents : `PurchaseDownPayments`, `PurchaseInvoices`, `PurchaseCreditNotes`, `DownPayments`.

### 2.2 `DownPaymentTypeEnum` (champ distinctif)

Valeurs admissibles relevées dans `$metadata` :

```
DownPaymentTypeEnum
   dptRequest      ← demande d'acompte
   dptInvoice      ← facture d'acompte (montant ferme)
```

Le 386 de la réforme est une **facture d'acompte** (montant ferme reçu du fournisseur) → **`DownPaymentType = 'dptInvoice'`** (et non `dptRequest`). L'acompte porte un **montant** (TTC du 386), pas un pourcentage (`DownPaymentAmount`/`DownPaymentPercentage` non requis : le montant est porté par les lignes).

### 2.3 `DocType`

`BoDocumentTypes` = `{ dDocument_Items, dDocument_Service }`. L'acompte de service reste en **`dDocument_Service`** (lignes `acAccount`) — inchangé vs le builder générique.

### 2.4 Delta vs `PurchaseInvoices`

`PurchaseDownPayments` est, comme `PurchaseInvoices`/`PurchaseCreditNotes`, l'entité SL **`Document`** : la structure (lignes `acAccount`, `DocType: dDocument_Service`, TVA, `CardCode`, `U_PA_REF`) est **identique**. **Le seul écart confirmé est `DownPaymentType`**. → branche minimale dans le builder générique (pas de builder dédié nécessaire).

### 2.5 Limite

**0 `PurchaseDownPayments`** en base de démo → structure persistée (lignes, TVA d'acompte) **non inspectable sans écriture**. Aucune écriture faite en autonomie ; validation du POST réel → essai manuel encadré (§5).

---

## 3. Étape 3 — Adaptation du payload 386

### 3.1 `apps/api/src/services/sap-invoice-builder.ts`

- Nouveau paramètre **optionnel** `isDownPayment?: boolean` sur `buildPurchaseDocPayload` (6ᵉ position, après `downPaymentDraw`).
- Quand `true` → ajoute **`DownPaymentType: 'dptInvoice'`** au payload. Aucun autre champ modifié (lignes, DocType, TVA, traçabilité `U_PA_REF` identiques à une facture d'achat).
- Quand absent/`false` → **aucun** champ émis : `PurchaseInvoices` / `PurchaseCreditNotes` **strictement inchangés**.

### 3.2 `apps/api/src/routes/invoices.ts` (2 points d'intégration)

- Aux deux appels `buildPurchaseDocPayload`, passage de `docType === 'PurchaseDownPayments'` au paramètre `isDownPayment`. Un 386 (`ADVANCE_INVOICE`) est désormais posté sur `PurchaseDownPayments` avec `DownPaymentType: 'dptInvoice'`.

### 3.3 `apps/api/src/services/sap-sl.service.ts`

- Union `docType` mise à jour ; commentaire corrigé : le payload acompte reprend la structure `PurchaseInvoices` **+ `DownPaymentType`** (la mention « même structure » était fausse vis-à-vis de ce champ).

---

## 4. Étape 4 — Validation (checks verts)

`tests/unit/sap-invoice-builder.test.ts` (ajouts) :

- 386 (`isDownPayment = true`) → payload porte `DownPaymentType: 'dptInvoice'`, `DocType: 'dDocument_Service'`, lignes inchangées, **pas** de `DownPaymentsToDraw` ;
- facture normale → **pas** de `DownPaymentType`.

Le routage `ADVANCE_INVOICE → 'PurchaseDownPayments'` est porté par les deux blocs `docType` de `routes/invoices.ts` (vérifié par lecture ; les routes elles-mêmes ne disposent pas de test unitaire isolé sur le `docType` — couverture déléguée à l'essai manuel §5).

**Résultats** : `vitest run tests/unit` → **324 tests passés** (322 → 324, **aucune régression**). `npm run typecheck` (5 workspaces) **clean**. `eslint` (fichiers modifiés) **clean**.

---

## 5. Essai manuel encadré (NON autonome — écriture) : valide TOUTE la chaîne acompte

À exécuter **manuellement** en environnement de test SAP (POST interdits en autonomie) :

1. **386** — poster un `PurchaseDownPayments` (montant ex. 120 TTC, `DownPaymentType: 'dptInvoice'`) via le flux `ADVANCE_INVOICE` → doit **réussir** (plus de HTTP 400) et atteindre **`POSTED`** avec `sapDocEntry` renseigné, `OpenAmount = 120`.
2. **F3** — poster une facture définitive (`INVOICE` + `prepaidAmount`) tirant cet acompte via `DownPaymentsToDraw` → net à payer réduit, `OpenAmount` du 386 décrémenté.
3. **503** — poster un avoir d'acompte réduisant le 386 (partiel puis total) → cf. réserves §6/§7 du `CR_Correction_503_ContrePassation_2026-06-05.md`.
4. **Vérifier** les écritures et comptes d'avance (`DownPaymentVATAcctPurch`, compensation d'acompte) — **validation expert-comptable**.

Tant que cet essai n'est pas validé, traiter le POST réel acompte comme **non confirmé** (le mode `simulate` reste sûr).

---

## 6. Limites / différé

- **Structure persistée** du 386 (lignes, TVA d'acompte) non inspectée (0 acompte en base, lecture seule) → §5.
- **Champs d'acompte avancés** (`DownPaymentVATAcctPurch`, etc.) : pilotés par les **déterminations G/L de SAP**, non renseignés par NOVA (à confirmer côté config SAP lors de l'essai §5).
- **Hors périmètre** (inchangés) : 393 (PayToCode factor), mode `JOURNAL_ENTRY`, niveau payé S/B 2, clôture PA du 384. Lots F3/503 inchangés (le présent correctif les **débloque** sans modifier leur logique).

---

_Fin du CR — correctif 386 (P1, bloquant). EntitySet corrigé (`PurchaseDownPayments`), `DownPaymentType: 'dptInvoice'` confirmé LIVE en lecture seule ; aucune écriture SAP ; non-386 inchangés ; aucune migration. POST réel de la chaîne acompte à valider par essai manuel encadré (§5) + expert-comptable._
