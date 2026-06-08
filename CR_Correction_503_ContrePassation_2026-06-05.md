# Compte-rendu — Correction 503 : contre-passation de l'acompte (avoir d'acompte), partielle ou totale

**Date** : 2026-06-05
**Périmètre** : écart **P1** identifié dans `CR_Audit_Traitement_Flux_SAP_2026-06-05.md` (§3 n°2, §4.1) — un **503** (avoir d'acompte, `direction = ADVANCE_CREDIT_NOTE`) était routé en `PurchaseCreditNotes` **générique** (`// TODO contre-passation APDownPayment`), **sans lien** avec l'acompte 386 d'origine → l'acompte SAP n'était jamais soldé/réduit, et l'avoir était mal imputé (comptes de charge/TVA déductible au lieu des comptes d'avance).
**Décision métier verrouillée** : le 503 doit réduire l'acompte **partiellement OU totalement** (montant variable = celui porté par le 503).
**Mode** : exécution autonome. SAP joignable (serveur PROD), accès **lecture seule confirmé** (Login + GET uniquement) ; **aucune écriture** SAP. Aucune migration. Le mot de passe n'a jamais été loggué.

---

## 1. Étape 1 — Confirmation LIVE du mécanisme SAP (lecture seule)

Script reproductible : `scripts/inspect-creditnote-downpayment.ts` (Login + `GET /$metadata` + `GET` documents exemples). SL réel : `SBODemoFR @ 141.94.132.62:50000/b1s/v1`.

### 1.1 Mécanisme retenu — `DownPaymentsToDraw` sur l'avoir (partiel supporté) ✅

- La collection **`DownPaymentsToDraw`** (type `DownPaymentToDraw`) est déclarée sur l'entité **`Document`** du `$metadata`, donc **partagée** par `PurchaseInvoices` **et** `PurchaseCreditNotes`. Confirmé en runtime : `GET /PurchaseCreditNotes?$select=DownPaymentsToDraw` → **HTTP 200** (champ valide sur l'avoir).
- Champs de l'élément : `DocEntry : Edm.Int32`, **`AmountToDraw : Edm.Double`** (+ `GrossAmountToDraw`, `Tax`, `DownPaymentType`…). `AmountToDraw` étant un **Double**, le **tirage partiel est structurellement supporté** → on peut contre-passer un **montant variable** = total du 503 (partiel **ou** total).
- C'est **le même mécanisme SL que F3** (tirage d'acompte sur la facture définitive), appliqué cette fois à l'**avoir d'achat**. Conclusion : **la décision métier « partiel » est réalisable** ; on **n'est donc pas** dans le cas de blocage « seule l'annulation totale est possible » → on implémente.

### 1.2 Adossement ligne à ligne (BaseType/BaseEntry/BaseLine) — non retenu

Les `DocumentLine` exposent bien `BaseType`/`BaseEntry`/`BaseLine`, mais **`DownPaymentsToDraw` est le mécanisme dédié et documenté** pour l'application/contre-passation d'acompte (pas besoin d'adosser une ligne d'avoir à un down payment via BaseType). On référence l'acompte par son **`DocEntry`** dans `DownPaymentsToDraw` → lien direct et traçable au 386.

### 1.3 Comptes d'avance en jeu (déterminations SAP, non posés par NOVA)

Champs document-level relevés dans `$metadata` : `DownPaymentVATAcctPurch` (TVA sur acompte), `DownPaymentPClearingAcct` (compte de compensation d'acompte achat), `DownPaymentTaxOffsetAccount`, `DownPaymentInterimAccount`. Ces comptes sont pilotés par les **déterminations G/L de SAP** : c'est SAP qui passe les écritures de contre-passation lors du tirage — NOVA ne les renseigne pas.

### 1.4 Constats annexes

- **EntitySet réel = `PurchaseDownPayments`** (GET 200). **`APDownPayments` → HTTP 400 « Unrecognized resource path »**. Le code historique (`createPurchaseDoc`, routage `ADVANCE_INVOICE`) utilise `APDownPayments` → **le post d'un 386 échouerait**. ⚠️ **Hors périmètre 503** (flux 386 = lot distinct) — **signalé, non corrigé ici**. Sans impact sur le 503 : le tirage référence l'acompte par `DocEntry`, pas par nom d'entité, et l'avoir est posté sur `PurchaseCreditNotes` (GET 200).
- **0 `PurchaseDownPayments`** dans la base de démo → l'**effet comptable** réel du tirage sur un avoir **n'est pas testable sans écriture**. Conformément à la consigne (lecture seule en autonomie), **aucune écriture de test n'a été faite** ; un essai manuel encadré est décrit au §6, et le traitement comptable est soumis à validation expert-comptable (§7).

---

## 2. Décisions appliquées

1. **Détection 503** : `direction === 'ADVANCE_CREDIT_NOTE'` (`isAdvanceCreditNote`).
2. **Clé de rapprochement** (réutilisation stricte du pattern F3, BT-25) : acompte = facture `ADVANCE_INVOICE`, **même** `supplierPaIdentifier`, `docNumberPa === correctedInvoiceRef` du 503, **statut `POSTED`** (→ `sapDocEntry` = `DocEntry` du `PurchaseDownPayments`). Pas de dépendance au PO/BT-13.
3. **Montant à contre-passer** = `totalInclTax` du 503 (en valeur absolue ; un avoir peut être stocké en magnitude). Contrôles : `> 0` et **`≤` montant de l'acompte d'origine** (marge 0,01 €). Le **partiel** (montant < acompte) est explicitement autorisé.
4. **Non rapprochable → blocage** : aucun post, facture en **`TO_REVIEW`** + `statusReason`, **y compris en `simulate`**. Jamais d'avoir générique qui mésimpute l'acompte.
5. **Mode `JOURNAL_ENTRY` + 503 → blocage** (motif dédié) : le mode écriture inverse aujourd'hui le sens du 503 (audit §2.6) ; correctif JE = lot distinct. Pas de post d'une écriture fausse.

---

## 3. Modifications fichier par fichier

### 3.1 `apps/api/src/services/down-payment.service.ts`

- **Factorisation** : extraction d'un helper privé `findPostedAdvance(supplierPaIdentifier, correctedInvoiceRef)` — **source unique** du rapprochement de l'acompte 386 POSTED (clé BT-25 + fournisseur, contrôle `sapDocEntry`). `resolveDownPaymentDraw` (F3) le réutilise désormais (comportement inchangé).
- **Nouveau** `isAdvanceCreditNote(invoice)` → détection 503.
- **Nouveau** `resolveAdvanceForCreditNote(invoice)` → `{ ok:true, advanceDocEntry, advanceInvoiceId, amount }` ou `{ ok:false, reason }`. Montant = `|totalInclTax|` du 503 ; blocages : montant nul, BT-25 absente, acompte introuvable / non POSTED / sans `sapDocEntry`, montant > acompte.

### 3.2 `apps/api/src/services/sap-invoice-builder.ts`

- **Aucun changement fonctionnel.** Le 5ᵉ paramètre `downPaymentDraw?: { docEntry; amountToDraw }` est **déjà** agnostique du `docType` : passé pour un 503, il ajoute la collection **`DownPaymentsToDraw: [{ DocEntry, AmountToDraw }]`** au payload posté vers `PurchaseCreditNotes`. Commentaires généralisés (F3 _et_ 503).

### 3.3 `apps/api/src/services/sap-validation.service.ts`

- `InvoiceForSapValidation` étendu d'un champ **optionnel** `totalInclTax` (absent = comportement inchangé).
- **Nouveau contrôle pré-intégration 503** (symétrique de F3) : pour un `ADVANCE_CREDIT_NOTE`, en `JOURNAL_ENTRY` → anomalie bloquante ; en `SERVICE_INVOICE` → `resolveAdvanceForCreditNote`, si `ok:false` → anomalie bloquante. Réutilise le code **`DOWN_PAYMENT_DRAW`** (déjà exclu des `hardErrors` génériques côté routes) → l'anomalie est visible **avant** l'intégration (validation / simulation).

### 3.4 `apps/api/src/routes/invoices.ts` (les **2** points d'intégration)

- **Bulk** (`POST /api/invoices/bulk-post`, SERVICE_INVOICE forcé) : après le bloc F3, **bloc 503** → `resolveAdvanceForCreditNote`. `ok:false` ⇒ `TO_REVIEW` + `statusReason` + audit `503_ADVANCE_REVERSAL_UNRESOLVED`, non posté. `ok:true` ⇒ `downPaymentDraw` transmis au builder + lien de traçabilité.
- **Unitaire** (`POST /api/invoices/:id/post`) : **nouveau bloc 2d** (après le 2c F3), avant la simulation. 503 en `JOURNAL_ENTRY` ⇒ blocage motivé ; 503 non rapprochable ⇒ blocage. Dans les deux cas : `TO_REVIEW` + `statusReason` + audit `503_ADVANCE_REVERSAL_BLOCKED` + réponse 422. **Exécuté avant la branche `simulate`** → la simulation signale aussi le problème. `ok:true` ⇒ `downPaymentDraw` transmis au builder.
- **Traçabilité** : le lien 503 → acompte 386 (`advanceDocEntry`, `advanceInvoiceId`) est consigné dans l'**audit** du post réussi (`payloadAfter.advanceReversal`). Pas de relation DB dédiée → **aucune migration** (cf. §2.4 audit, le champ `replacesInvoiceId` est réservé au 384/supersession).
- Commentaires de routage `// TODO 503` **supprimés** (la contre-passation est désormais portée par les blocs dédiés ; `docType` 503 → `PurchaseCreditNotes` + `DownPaymentsToDraw`).
- **Correctif de cohérence** : la ré-évaluation des `hardErrors` après auto-patch FederalTaxID exclut désormais aussi `DOWN_PAYMENT_DRAW` (alignée sur le filtre principal) — sinon un F3/503 corrigé sur la TVA serait routé au 422 générique au lieu des blocs dédiés (`TO_REVIEW`).
- Factures **non-503** (et non-F3) : **aucun changement** de comportement.

---

## 4. Structure `DownPaymentsToDraw` retenue (avoir 503)

`PurchaseCreditNotes.DownPaymentsToDraw` = collection `{ DocEntry, AmountToDraw }`, où `DocEntry` = `DocEntry` SAP du `PurchaseDownPayments` (386) à contre-passer et `AmountToDraw` = montant TTC du 503 (≤ acompte). Champs additionnels (`GrossAmountToDraw`, `AmountToDrawFC`, `Tax`, `DownPaymentToDrawDetails`…) **non requis** ici. Structure **confirmée présente** sur `PurchaseCreditNotes` (§1.1).

---

## 5. Scénarios de test (vitest — verts)

`tests/unit/down-payment.test.ts` :

- `isAdvanceCreditNote` : détecte 503, rejette `CREDIT_NOTE`/`INVOICE`/`ADVANCE_INVOICE` ;
- `resolveAdvanceForCreditNote` : rapprochement OK (DocEntry + invoiceId + amount), **partiel** autorisé, **total** (= acompte) autorisé, montant en valeur absolue (avoir négatif) ; blocages : montant nul, BT-25 absente, acompte introuvable, acompte sans `sapDocEntry`, montant > acompte.

`tests/unit/sap-invoice-builder.test.ts` :

- 503 (direction `ADVANCE_CREDIT_NOTE`) avec draw → `DownPaymentsToDraw:[{DocEntry:4242, AmountToDraw:50}]` (partiel).

`tests/unit/sap-validation.test.ts` :

- 503 rapprochable → pas d'anomalie `DOWN_PAYMENT_DRAW`, `ok:true` ;
- 503 non rapprochable → anomalie bloquante `DOWN_PAYMENT_DRAW` (ERROR) ;
- 503 en `JOURNAL_ENTRY` → bloqué sans appeler la résolution ;
- avoir simple (381 `CREDIT_NOTE`) → non traité comme 503.

**Résultats** : `vitest run tests/unit` → **322 tests passés** (307 → 322, **aucune régression**). `npm run typecheck` (5 workspaces) **clean**. `eslint` sur les fichiers modifiés **clean**.

---

## 6. Essai manuel encadré requis (validation du mécanisme, AVANT go-live)

L'effet comptable du tirage sur un avoir **n'a pas pu être vérifié en autonomie** (0 acompte en base + écritures interdites). Avant d'activer le post réel d'un 503 en production, **exécuter manuellement, en environnement de test SAP** :

1. Poster un `PurchaseDownPayments` (386) de référence (ex. TTC 120) → noter son `DocEntry` et son `OpenAmount`.
2. Poster un `PurchaseCreditNotes` portant `DownPaymentsToDraw:[{DocEntry:<386>, AmountToDraw:50}]` (partiel).
3. **Vérifier** : (a) l'`OpenAmount` du 386 passe de 120 → 70 ; (b) les écritures touchent les comptes d'avance/`DownPaymentVATAcctPurch` (et **non** les comptes de charge/TVA déductible) ; (c) le sens comptable est bien un **crédit** de l'acompte. Puis répéter en **total** (AmountToDraw = 120).

Ces postings sont **à réaliser manuellement** (non en autonomie). Tant qu'ils ne sont pas validés, traiter le post réel 503 comme **non confirmé** (le mode `simulate` et les blocages restent sûrs).

---

## 7. Note pour validation expert-comptable

Le traitement retenu — **un avoir d'achat (`PurchaseCreditNotes`) qui « tire » l'acompte 386 via `DownPaymentsToDraw` pour un montant = total du 503** — relève d'une **décision comptable** (audit §4.1) à **valider par l'expert-comptable** :

- **Imputation** : la contre-passation doit mouvementer les **comptes d'avance** (compensation d'acompte + TVA sur acompte), pas les comptes de charge. C'est SAP qui pilote ces comptes via ses déterminations ; à confirmer que la détermination configurée correspond bien au schéma comptable attendu pour un avoir d'acompte fournisseur.
- **Sens** : un 503 doit **réduire** (créditer) l'acompte ouvert. À confirmer que le tirage sur avoir produit ce sens (cf. §6.3c).
- **Partiel** : un 503 < 386 réduit l'acompte du montant du 503 et **laisse le solde ouvert** pour un tirage ultérieur (F3) ou une nouvelle contre-passation. Comportement à valider.
- **Lien documentaire** : la traçabilité 503 ↔ 386 est portée par l'audit (`advanceReversal`) ; si une relation persistée est souhaitée (reporting), prévoir un champ dédié (migration distincte — **non faite ici**).

---

## 8. Limites / différé

- **Mode `JOURNAL_ENTRY` + 503** : volontairement **bloqué** (différé, lot JE).
- **Validation empirique du posting** : non réalisée (lecture seule, 0 acompte en base) → §6.
- **Bug entity-set `APDownPayments`** (le vrai nom est `PurchaseDownPayments`) : **signalé**, casse le post d'un 386 — **hors périmètre 503** (lot 386), non corrigé.
- **Hors périmètre** (lots ultérieurs, inchangés) : 393 (PayToCode factor), payload 386, niveau payé S/B niveau 2, clôture PA du 384.

---

_Fin du CR — correctif 503 (P1). Mécanisme partiel confirmé LIVE en lecture seule ; aucune écriture SAP ; aucun post d'un 503 non rapproché ; non-503 inchangés ; aucune migration. Effet comptable du posting à valider par essai manuel encadré (§6) + expert-comptable (§7)._
