# Compte-rendu — Niveau payé (matrice S/B 2) : paiement sortant + lettrage (A) & suivi U_NOVA_Statut (B)

**Date** : 2026-06-05
**Périmètre** : audit `CR_Audit_Traitement_Flux_SAP_2026-06-05.md` §4.3 — le **niveau 2** de la matrice S/B (« NOVA gère le paiement ») était **inexistant** (`OutgoingPayments`, lettrage et `U_NOVA_Statut` = 0 occurrence). Spec : interview matrice S/B du 2026-06-03.
**Mode** : exécution autonome, aucune question. **Lecture seule SAP** en autonomie (`POST /Login` + `GET`). **Aucune écriture SAP** (le `POST` paiement / `PATCH` UDF sont codés mais exécutés manuellement, cf. §6). **Aucune migration appliquée** sur la base (fichier de migration créé, `prisma generate` seul lancé pour typer le client).

> ⚠️ **Lot le plus sensible : il déplace de l'argent.** Le paiement n'est créé que sur **action explicite « Payer »** (jamais automatique), borné par `SAP_POST_POLICY`, avec **blocage au moindre doute** et **idempotence stricte** (un seul paiement par facture). En autonomie : **code + confirmation des structures en lecture seule uniquement**.

---

## 0. Confirmation LIVE (lecture seule, avant de coder)

Trois scripts `scripts/inspect-*` (pattern existant, `Login` + `GET`, jamais de mot de passe loggé, **aucune écriture**) exécutés contre le SL réel (`SBODemoFR`) :

| Script                                   | Confirme                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `inspect-outgoingpayment-metadata.ts`    | EntityType `Payment`, enums `BoRcptInvTypes` / `BoPaymentsObjectType`, collection `PaymentInvoices`   |
| `inspect-bp-paymentmethod-novastatut.ts` | champs moyen/banque du BP, état de règlement `PurchaseInvoices`, **absence** de l'UDF `U_NOVA_Statut` |
| `inspect-payment-complextypes.ts`        | ComplexType `PaymentInvoice`, enums `BoRcptTypes` / `BoStatus`, moyen réel d'un fournisseur           |

**Structures retenues (sourcées `$metadata` + GET d'instances réelles) :**

- **OutgoingPayments** (EntityType `Payment`) :
  `DocObjectCode = 'bopot_OutgoingPayments'` · `DocType = 'rSupplier'` (enum `BoRcptTypes` = rCustomer/rAccount/**rSupplier**) · `CardCode` · `DocCurrency`/`DocRate`.
  **Moyen** : virement = `TransferAccount` + `TransferSum` + `TransferDate` ; espèces = `CashAccount` + `CashSum`.
  **Lettrage** : `PaymentInvoices: [{ DocEntry, InvoiceType, SumApplied }]` (ComplexType `PaymentInvoice`). `InvoiceType` ∈ `BoRcptInvTypes` → **`it_PurchaseInvoice`** (acompte = `it_PurchaseDownPayment`).
- **BusinessPartner — moyen / banque par défaut** :
  `PeymentMethodCode` ⚠️ **(typo SAP d'origine — `PaymentMethodCode` renvoie HTTP 400)** · `DefaultBankCode` · `HouseBank` · `HouseBankAccount` · `HouseBankIBAN`. La méthode (sens + moyen) se lit sur **`WizardPaymentMethods`** : `Type` (`boptOutgoing`/`boptIncoming`) + `PaymentMeans` (`bopmBankTransfer`/`bopmCheck`/`bopmCash`/`bopmBillOfExchange`). Donnée live : `F00001 → PeymentMethodCode="Chèque fourn"`, `HouseBank="30003"`.
- **PurchaseInvoices — état de règlement** :
  **pas d'`OpenAmount` exposé** → **montant ouvert = `DocTotal − PaidToDate`**. `DocumentStatus` ∈ {`bost_Open`, `bost_Close`} (enum `BoStatus`). Donnée live : DocEntry 433, DocTotal 1698.32, PaidToDate 0, `bost_Open`.
- **UDF `U_NOVA_Statut`** : **ABSENTE** sur `OPCH` → création requise (mirror de `createSapUdfPaRef`).

---

## 1. Décision verrouillée structurante (sécurité argent)

**Le compte GL de décaissement n'est JAMAIS inventé.** Le **moyen et la banque** sont lus du BP ; mais le **compte de trésorerie** à débiter (qui n'est pas porté par le fournisseur) provient de la **configuration d'environnement** :

- `SAP_PAYMENT_TRANSFER_ACCOUNT` (compte de la banque de décaissement — virement) ;
- `SAP_PAYMENT_CASH_ACCOUNT` (caisse — espèces).

Conséquences (toutes **bloquantes**, jamais de paiement) :

- BP sans `PeymentMethodCode` → bloqué (« moyen non configuré ») ;
- virement sans banque par défaut (`HouseBank`) côté fournisseur → bloqué ;
- compte de décaissement non configuré en env → bloqué ;
- **moyen chèque / effet (`bopmCheck`, `bopmBillOfExchange`) → bloqué** : « non automatisé par NOVA — règlement manuel » (créer un chèque/effet en sécurité exige des structures hors périmètre de ce lot) ;
- méthode non sortante (`boptIncoming`) → bloqué.

---

## 2. Partie A — Paiement sortant + lettrage (« Payer »)

### 2.1 `apps/api/src/services/sap-payment.service.ts` (nouveau)

- `getPaymentAccountsConfig()` — lit les comptes de décaissement en env.
- `resolveSupplierPaymentMeans(bp, method, accounts)` — **PUR**, applique les règles §1 → `{ ok, means:'TRANSFER'|'CASH', account }` ou `{ ok:false, reason }`.
- `buildOutgoingPaymentPayload(input)` — **PUR**, construit le payload `OutgoingPayments` + ligne `PaymentInvoices` qui **solde le poste** (`SumApplied = montant ouvert`).
- `preparePayment(cookie, invoice, accounts)` — orchestration (lectures seules) + validations bloquantes :
  1. **idempotence** (`sapPaymentDocEntry != null` → 409) ;
  2. direction payable (INVOICE/SELF_BILLED/FACTORING — pas acompte/avoir) ;
  3. facture **intégrée** (POSTED/LINKED, `sapDocEntry` présent) ;
  4. **montant ouvert lu EN DIRECT** (`DocTotal − PaidToDate`) > 0 (jamais une valeur stockée) ;
  5. moyen BP exploitable.
     Ne crée **rien** : renvoie le payload prêt ou un blocage motivé.

### 2.2 `apps/api/src/services/sap-sl.service.ts` (étendu)

Fonctions ajoutées (toutes sourcées des structures live §0) :

- `fetchSupplierPaymentConfig` (GET BP — `PeymentMethodCode`, `HouseBank`…) ;
- `fetchPaymentMethod` (GET `WizardPaymentMethods` — `Type`, `PaymentMeans`) ;
- `fetchPurchaseInvoiceSettlement` (GET — `DocTotal`, `PaidToDate`, `DocumentStatus` ; calcule `openAmount`) ;
- `createOutgoingPayment` (**POST** `OutgoingPayments`) ;
- `createSapUdfNovaStatut` (**POST** `UserFieldsMD` OPCH, idempotent code −2035) ;
- `patchSapUdfNovaStatut` (**PATCH** UDF de suivi).

### 2.3 `apps/api/src/routes/invoices.ts` — `POST /api/invoices/:id/pay`

Action **explicite** « Payer ». Respecte `SAP_POST_POLICY` :

- `disabled` → 409 (jamais de paiement) ;
- pré-paiement bloqué → code HTTP du blocage + audit `PAYMENT_BLOCKED` ;
- `simulate` → **prévisualise** le payload sans créer (audit `PAYMENT_SIMULATED`) ;
- `real` → `createOutgoingPayment`, puis persiste `sapPaymentDocEntry`/`sapPaymentDocNum` + `novaPaymentStatus='SOLDE'` (poste soldé par le lettrage), audit `PAYMENT_OK`.

### 2.4 `apps/api/src/routes/sap.ts` — `POST /api/sap/setup/udf-nova-statut`

Setup manuel de l'UDF `U_NOVA_Statut` (mirror de `udf-pa-ref`).

---

## 3. Partie B — Suivi U_NOVA_Statut

### 3.1 `packages/database/src/nova-statut.ts` (nouveau, PUR)

- Échelle ordonnée **NON_PAYE < PROGRAMME < PARTIEL < PAYE < SOLDE** (`NOVA_STATUT_SCALE`, `novaStatutRank`, `isNovaStatut`).
- `mapSapSettlementToNovaStatut({docTotal, paidToDate, documentStatus})` : `bost_Close` ou réglé total → **SOLDE** ; rien réglé → **NON_PAYE** ; partiel → **PARTIEL**. (SAP ne produit **jamais** PROGRAMME/PAYE, réservés à la PA.)
- `mapPaLifecycleToNovaStatut(paStatus)` : libellés PA → échelle (programmé→PROGRAMME, encaissé→PAYE…), tolérant, `null` si non interprétable.
- `consolidateNovaStatut(candidates)` : **l'état le plus avancé gagne** (départage à rang égal par horodatage le plus récent), renvoie `{ value, source, at }`.
  Exporté depuis `packages/database/src/index.ts`.

### 3.2 `apps/worker/src/sap/sap-worker-client.ts` (nouveau)

Le worker n'a pas de session utilisateur → **login compte de service** (env, comme les scripts d'inspection ; cache + re-login sur 401). Surface minimale : `fetchInvoiceSettlement` (lecture seule), `ensureUdfNovaStatut` (idempotent), `patchUdfNovaStatut` (PATCH de suivi). **Aucun paiement.**

### 3.3 `apps/worker/src/jobs/payment-status-job.ts` (nouveau)

Pour chaque facture intégrée (POSTED/LINKED, `sapDocEntry` présent) **non SOLDE** :

1. lit l'état SAP (poll SL) → candidat SAP ;
2. candidat PA depuis `paPaymentStatus` (mappé) ;
3. **consolide** (le plus avancé gagne, source + horodatage) ;
4. **si la valeur change** : `PATCH U_NOVA_Statut` (uniquement en `real`) **et** met à jour le miroir base (`novaPaymentStatus`/`Source`/`At`). **Inchangé → aucune écriture.**
   Cadence : `PAYMENT_STATUS_POLL_INTERVAL_MS` (défaut **15 min**) ; gating dans `runCycle` (mirror du nettoyage hebdo). Câblé dans `apps/worker/src/index.ts` (`maybeRunPaymentStatusJob`).

---

## 4. Modèle de données

`packages/database/prisma/schema.prisma` (modèle `Invoice`) + migration `20260605120000_add_payment_level_s2` — **colonnes additives nullables uniquement** (`migrate deploy`-safe, pas d'`ALTER TYPE`, pas de backfill) :

| Colonne                                         | Rôle                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `sap_payment_doc_entry` / `sap_payment_doc_num` | résultat du paiement (idempotence A)                         |
| `nova_payment_status` (+ `_source`, `_at`)      | miroir base du suivi U_NOVA_Statut (B)                       |
| `pa_payment_status`                             | candidat de consolidation issu du cycle de vie PA (source 2) |

`prisma generate` lancé (types client à jour) ; **migration NON appliquée** (cf. [[project_invoice_unique_partial_index]] « ne pas migrate dev »).

---

## 5. Vérification

| Check                                  | Résultat                                              |
| -------------------------------------- | ----------------------------------------------------- |
| `vitest run tests/unit`                | **359 tests** (327 → 359, **+32**, aucune régression) |
| `npm run typecheck` (5 workspaces)     | **clean**                                             |
| `eslint` (fichiers modifiés + scripts) | **clean**                                             |
| Confirmation live (§0)                 | 3 scripts lecture seule, **aucune écriture**          |

Tests ajoutés :

- **A** — `tests/unit/sap-payment.test.ts` : moyen virement résolu ; blocages (BP sans moyen / banque absente / compte non configuré / chèque non automatisé / méthode entrante) ; builder lettrage ; `preparePayment` (idempotence, direction non payable, non intégrée, poste soldé, cas nominal, moyen non exploitable 422).
- **B** — `tests/unit/nova-statut.test.ts` : échelle, mappings SAP/PA, consolidation (SAP>PA, PA>SAP, départage horodatage) ; `tests/unit/payment-status-job.test.ts` : sélection, PATCH si changement, **pas de PATCH si inchangé**, consolidation PA gagne, `simulate` = pas de PATCH SAP mais miroir mis à jour.

---

## 6. Essai manuel encadré (NON autonome — écritures réelles)

À exécuter en **environnement de test SAP**, **avec validation expert-comptable**, avant tout `SAP_POST_POLICY=real` sur les paiements :

1. **Setup UDF** : `POST /api/sap/setup/udf-nova-statut` → crée `U_NOVA_Statut` sur OPCH (idempotent).
2. **Config env** : définir `SAP_PAYMENT_TRANSFER_ACCOUNT` (compte de banque de décaissement réel, validé par l'expert-comptable). Vérifier qu'un fournisseur de test a une **méthode sortante virement** (`WizardPaymentMethods.Type=boptOutgoing`, `PaymentMeans=bopmBankTransfer`) et une **banque par défaut** (`HouseBank`).
3. **Simulate d'abord** : `POST /api/invoices/:id/pay` avec `SAP_POST_POLICY=simulate` → vérifier le **payload prévisualisé** (CardCode, TransferAccount = compte attendu, `PaymentInvoices[0].SumApplied` = montant ouvert).
4. **Réel** : passer en `real`, rejouer « Payer » → un `OutgoingPayments` est créé, **adossé à la facture** ; le poste passe à **soldé** (`DocTotal − PaidToDate → 0`, `DocumentStatus → bost_Close`).
5. **Suivi** : laisser tourner le job (ou abaisser `PAYMENT_STATUS_POLL_INTERVAL_MS`) → `U_NOVA_Statut` reflète l'état (NON_PAYE → … → SOLDE). Vérifier la règle « le plus avancé gagne » en injectant un `pa_payment_status` PA concurrent (ex. `PAYE` alors que SAP = `NON_PAYE`).
6. **Idempotence** : rejouer « Payer » sur la même facture → **409** (un seul paiement).

### Note pour validation expert-comptable

- **Compte de banque débité** = `SAP_PAYMENT_TRANSFER_ACCOUNT` (à confirmer : le bon compte de trésorerie, pas un compte d'attente).
- **Contrepartie fournisseur soldée** : le lettrage `PaymentInvoices` doit ramener le poste fournisseur à zéro (sens correct, montant = montant ouvert lu en direct).
- **Sens de l'écriture** : décaissement (crédit banque / débit fournisseur) cohérent avec un paiement sortant.
- Le **moyen** (virement) provient du BP ; tout autre moyen (chèque/effet) est **bloqué** côté NOVA et reste à régler manuellement dans SAP.

---

## 7. Choix & écarts (exécution autonome)

- **GL de décaissement par configuration env** (et non inventé ni dérivé d'une lookup HouseBanks non disponible dans ce SL — `HouseBanks` renvoie HTTP 400) : seul moyen sûr de respecter « ne pas inventer de compte » tout en lisant moyen+banque du BP.
- **Chèque/effet bloqués** (non automatisés) : périmètre volontairement restreint au **virement** pour la sécurité argent ; les autres moyens restent manuels.
- **Client SAP worker dédié** (login service) plutôt qu'import inter-workspace `apps/api` : surface minimale, isolée, alignée sur le pattern des scripts d'inspection.
- **Action `POST_SAP` réutilisée** pour l'audit (paiement + suivi), avec `stage` discriminant (`PAYMENT_*`, `NOVA_STATUT_*`) — pas de nouvelle valeur d'enum, pas de migration d'enum.

---

## 8. Limites / différé

- **Câblage source PA** : `pa_payment_status` est consommé par la consolidation mais son **alimentation par l'ingestion du cycle de vie réforme** (flux entrant PA → niveau payé) est un branchement à part (la pipeline PA actuelle est sortante). Champ + mapping + consolidation prêts ; le wire-up entrant est hors périmètre, signalé.
- **Moyens non-virement** (chèque, effet, prélèvement) : non automatisés (blocage explicite).
- **Runtime de bout en bout** (paiement réel + PATCH UDF) : non exécuté en autonomie (aucune écriture SAP) ; couvert par tests unitaires + protocole §6 à rejouer sur env de test.
- **Hors périmètre** (inchangés) : lots 393 / `JOURNAL_ENTRY` ; aucun paiement automatique ; aucune sentinelle.

---

_Fin du CR — Niveau payé S/B 2 : paiement sortant + lettrage (action « Payer », `SAP_POST_POLICY`, idempotence, blocage au moindre doute, GL jamais inventé) & suivi U_NOVA_Statut (échelle ordonnée, 2 sources, le plus avancé gagne, PATCH si changement). Lecture seule SAP en autonomie ; écritures décrites pour exécution manuelle encadrée + validation expert-comptable. Checks verts : 359 tests, typecheck 5 workspaces, eslint._
