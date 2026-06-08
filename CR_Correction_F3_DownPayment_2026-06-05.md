# Compte-rendu — Correction F3 : déduction de l'acompte (DownPaymentsToDraw) à l'intégration SAP

**Date** : 2026-06-05
**Périmètre** : écart **P0** de justesse comptable identifié dans `CR_Audit_Traitement_Flux_SAP_2026-06-05.md` (§3 n°1) — une facture définitive après acompte (**F3**, `direction=INVOICE` portant un `prepaidAmount` BT-113) était postée en `PurchaseInvoices` **à son TTC plein**, sans tirer l'acompte SAP (`DownPaymentsToDraw` absent) → **double comptage** de l'acompte.
**Mode** : exécution autonome, aucune écriture SAP de test. Réutilisation des données existantes (`prepaidAmount` / `correctedInvoiceRef` / `sapDocEntry`), **aucune migration**.

---

## 1. Décisions appliquées (verrouillées par le prompt)

1. **Détection F3** : `direction === 'INVOICE'` **et** `prepaidAmount > 0`.
2. **Clé de rapprochement de l'acompte** : facture `direction='ADVANCE_INVOICE'`, **même** `supplierPaIdentifier`, `docNumberPa === correctedInvoiceRef` (BT-25) de la définitive, **statut `POSTED`** (donc `sapDocEntry` renseigné). Pas de dépendance au PO/BT-13 (non parsé).
3. **Acompte non rapprochable** → **blocage** : aucun post SAP, facture passée en **`TO_REVIEW`** + `statusReason` explicite. **Jamais** de post à TTC plein, **y compris en mode `simulate`**.
4. **Mode `JOURNAL_ENTRY`** + F3 → **blocage** (déduction d'acompte non exprimable proprement en écriture, compte d'avance non modélisé). Motif dédié. Correctif complet du mode écriture = lot P1 distinct.

---

## 2. Modifications fichier par fichier

### 2.1 `apps/api/src/services/down-payment.service.ts` — **nouveau**

Service dédié, source unique de la logique F3 :

- `isFinalInvoiceWithDownPayment(invoice)` → `boolean` : détection F3 (décision 1).
- `resolveDownPaymentDraw(invoice)` → `Promise<{ ok: true; docEntry; amountToDraw } | { ok: false; reason }>` :
  - vérifie `prepaidAmount > 0`, présence de `correctedInvoiceRef` (BT-25) ;
  - recherche l'acompte via `prisma.invoice.findFirst` sur la clé décision 2 (`ADVANCE_INVOICE` + `supplierPaIdentifier` + `docNumberPa=ref` + `status=POSTED`) ;
  - contrôle `sapDocEntry != null` et **cohérence du montant** (`amountToDraw ≤ totalInclTax` de l'acompte, marge 0,01 €) ;
  - retourne le `DocEntry` SAP de l'acompte + le montant à tirer, ou un motif lisible de blocage.

### 2.2 `apps/api/src/services/sap-invoice-builder.ts`

- `buildPurchaseDocPayload` accepte un 5ᵉ paramètre **optionnel** `downPaymentDraw?: { docEntry; amountToDraw }`.
- Quand présent, ajoute au payload la collection **`DownPaymentsToDraw: [{ DocEntry, AmountToDraw }]`**. SAP réduit alors le net à payer du montant tiré.
- **Le `prepaidAmount` n'est PAS soustrait des lignes HT** : c'est le tirage `DownPaymentsToDraw` qui porte la déduction (documenté en commentaire). Comportement des factures non-F3 strictement inchangé (collection absente).

### 2.3 `apps/api/src/routes/invoices.ts` (les **2** points d'intégration)

- **Bulk** (`POST /api/invoices/bulk-post`, SERVICE_INVOICE forcé) : après validation, si F3 → `resolveDownPaymentDraw`. `ok:false` ⇒ `TO_REVIEW` + `statusReason` + audit `F3_DOWN_PAYMENT_UNRESOLVED`, facture non postée. `ok:true` ⇒ `downPaymentDraw` transmis au builder.
- **Unitaire** (`POST /api/invoices/:id/post`) : bloc **2c** avant la simulation. F3 en `JOURNAL_ENTRY` ⇒ blocage motivé ; F3 en `SERVICE_INVOICE` non rapprochable ⇒ blocage (`resolveDownPaymentDraw`). Dans les deux cas : `TO_REVIEW` + `statusReason` + audit `F3_DOWN_PAYMENT_BLOCKED` + réponse 422. **Le bloc s'exécute avant la branche `simulate`** → la simulation signale aussi le problème. `ok:true` ⇒ `downPaymentDraw` transmis au builder.
- Les filtres `hardErrors` des deux routes **excluent** désormais le code `DOWN_PAYMENT_DRAW` : l'anomalie F3 est traitée par le bloc dédié (qui pose `TO_REVIEW`) et non par le 422 de validation générique (qui ne changeait pas le statut). Évite la divergence et garantit le statut `TO_REVIEW`.
- Factures **non-F3** : aucun changement de comportement.

### 2.4 `apps/api/src/services/sap-validation.service.ts`

- Nouveau code d'anomalie `DOWN_PAYMENT_DRAW` (severity `ERROR`).
- `InvoiceForSapValidation` étendu de champs **optionnels** (`direction`, `prepaidAmount`, `correctedInvoiceRef`, `supplierPaIdentifier`) — absents = pas un F3, comportement inchangé pour tous les autres flux.
- **Contrôle pré-intégration par type** : pour un F3, en `JOURNAL_ENTRY` → anomalie bloquante ; en `SERVICE_INVOICE` → `resolveDownPaymentDraw`, et si `ok:false` → anomalie bloquante avec le motif. C'est le garde-fou qui manquait (l'audit notait « rien ne détecte ni n'alerte le double comptage F3 »). L'anomalie est désormais visible **avant** l'intégration (validation / simulation).

---

## 3. Structure `DownPaymentsToDraw` retenue

`PurchaseInvoices.DownPaymentsToDraw` = collection d'objets `{ DocEntry, AmountToDraw }`, où `DocEntry` est l'identifiant de l'`APDownPayments` (386) à tirer et `AmountToDraw` le montant déduit. C'est la **structure standard SAP B1 Service Layer** pour le tirage d'acompte sur document d'achat (champs additionnels disponibles : `AmountToDrawFC`, `BaseAbsEntry`, `BaseType`… non requis ici).

> **Confirmé contre le `$metadata` LIVE (2026-06-05, lecture seule)** : voir l'addendum `CR_Confirm_DownPayment_Metadata_2026-06-05.md`. La collection sur le `Document` (donc `PurchaseInvoices`) est bien **`DownPaymentsToDraw`** (pluriel), typée `Collection(SAPB1.DownPaymentToDraw)`, et le `ComplexType DownPaymentToDraw` expose `DocEntry : Edm.Int32` et `AmountToDraw : Edm.Double`. Le payload `[{ DocEntry, AmountToDraw }]` posé par le correctif est **exact** — aucun changement de code nécessaire.

---

## 4. Scénarios de test (vitest — verts)

`tests/unit/down-payment.test.ts` (nouveau) :

- détection F3 (INVOICE+prepaid ; rejet des autres directions / prepaid nul) ;
- rapprochement OK (DocEntry + amountToDraw) ; blocages : prepaid nul, BT-25 absente, acompte introuvable, acompte sans `sapDocEntry`, montant incohérent (> acompte).

`tests/unit/sap-invoice-builder.test.ts` :

- F3 rapprochable → `DownPaymentsToDraw:[{DocEntry:4242, AmountToDraw:30}]` ;
- facture normale → pas de `DownPaymentsToDraw`.

`tests/unit/sap-validation.test.ts` :

- F3 rapprochable → pas d'anomalie `DOWN_PAYMENT_DRAW`, `ok:true` ;
- F3 non rapprochable → anomalie bloquante `DOWN_PAYMENT_DRAW` (ERROR) ;
- F3 en `JOURNAL_ENTRY` → bloqué sans appeler la résolution ;
- facture normale (prepaid null) → non traitée comme F3.

**Résultats** : `vitest run tests/unit` → **307 tests passés** (aucune régression). `npm run typecheck` (5 workspaces) **clean**. `eslint` sur les fichiers modifiés **clean**.

---

## 5. Limites / différé

- **Mode `JOURNAL_ENTRY` + F3** : volontairement **bloqué** (différé). Le tirage d'acompte n'est pas modélisé en écriture comptable directe — lot P1 distinct.
- **Confirmation `$metadata`** : ✅ réalisée en LIVE le 2026-06-05 (Login + GET, lecture seule) — structure exacte confirmée, voir §3 et l'addendum `CR_Confirm_DownPayment_Metadata_2026-06-05.md`.
- **Hors périmètre** (lots ultérieurs, inchangés) : 503 (contre-passation APDownPayment), 393 (PayToCode factor), payload 386, niveau payé S/B niveau 2.

---

_Fin du CR — correctif F3 (P0). Aucune écriture SAP de test ; aucun post d'un F3 non rapproché ; comportement des non-F3 inchangé ; aucune migration._
