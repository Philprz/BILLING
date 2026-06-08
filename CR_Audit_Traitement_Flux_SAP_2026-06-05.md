# Compte-rendu — Audit du traitement des flux (ingestion → SAP B1), LECTURE SEULE

**Date** : 2026-06-05
**Périmètre** : NOVA-PA, traitement de bout en bout (réception PA → parsing → matching → cycle de vie → intégration SAP B1 → retour statut PA) pour **tous les flux** F1–F6 + types 389/393 + niveau payé/non payé.
**Mode** : audit **lecture seule**. Aucun fichier modifié, aucune écriture SAP, aucune migration. Aucune question posée (exécution autonome). Tout écart est prouvé par `fichier:ligne`.

> **Note méthodo** : « écart » = comportement constaté contraire au référentiel. Quand un point relève d'un choix de conception non tranché (mécanisme comptable à valider avec l'expert-comptable/PDP), il est rangé en **§4 — Décisions à trancher** et non en bug.

---

## 1. Synthèse par flux

| Flux            | Type                         | Direction                            | Parsing            | Routage SAP                  | Payload                                                                    | Statut global                                      |
| --------------- | ---------------------------- | ------------------------------------ | ------------------ | ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| **F1**          | 380 commerciale              | `INVOICE`                            | ✅                 | `PurchaseInvoices`           | ✅                                                                         | ✅ **Sûr**                                         |
| **F2**          | 386 acompte                  | `ADVANCE_INVOICE`                    | ✅                 | `APDownPayments`             | ⚠️ payload générique (pas de `DownPaymentType`)                            | ⚠️ **À risque**                                    |
| **F3**          | 380 définitive après acompte | `INVOICE` (+ `prepaidAmount` BT-113) | ✅ (capté)         | `PurchaseInvoices`           | ❌ **acompte non déduit** (`DownPaymentsToDraw` absent)                    | ❌ **Écriture incorrecte (P0)**                    |
| —               | 381 avoir                    | `CREDIT_NOTE`                        | ✅                 | `PurchaseCreditNotes`        | ✅                                                                         | ✅ **Sûr**                                         |
| **503**         | avoir d'acompte              | `ADVANCE_CREDIT_NOTE`                | ✅                 | `PurchaseCreditNotes` (TODO) | ❌ pas de contre-passation `APDownPayment`                                 | ❌ **Comptablement faux (P1)**                     |
| **384**         | rectificative/litige         | `CORRECTIVE_INVOICE`                 | ✅                 | `PurchaseInvoices`           | ✅ (suit 380)                                                              | ⚠️ **OK SAP, closure PA de l'originale manquante** |
| **389**         | autofacturation              | `SELF_BILLED`                        | ✅                 | `PurchaseInvoices`           | ✅ (= 380)                                                                 | ✅ **Sûr** (mention légale = côté générateur)      |
| **393**         | affacturage                  | `FACTORING`                          | ⚠️ payee non parsé | `PurchaseInvoices` (= 380)   | ❌ paiement factor non reflété (`PayToCode` absent)                        | ❌ **Paiement mal dirigé (P1)**                    |
| **Niveau payé** | matrice S/B niv. 2           | —                                    | —                  | —                            | ❌ inexistant (`OutgoingPayments`/lettrage/`U_NOVA_Statut` = 0 occurrence) | ❌ **Non géré (P1/décision)**                      |

Légende : ✅ conforme · ⚠️ partiel / à risque · ❌ non conforme.

**Remarque transverse (mode ÉCRITURE / `JOURNAL_ENTRY`)** : le routage par type **n'existe que** dans le mode `SERVICE_INVOICE`. En mode `JOURNAL_ENTRY`, le payload ne distingue **que** `CREDIT_NOTE` (cf. §2.6). Donc 386, 503, 384, 389, 393 y sont tous traités comme des factures de débit ordinaires — y compris **503 avec le mauvais sens comptable**.

---

## 2. Détail par dimension

### 2.1 Parsing (`apps/worker/src/parsers/`)

**Conforme sur l'essentiel.** Les deux parseurs mappent identiquement UNTDID 1001 → `direction` :

- UBL : [ubl.parser.ts:169-189](apps/worker/src/parsers/ubl.parser.ts#L169-L189)
- CII : [cii.parser.ts:81-98](apps/worker/src/parsers/cii.parser.ts#L81-L98)

`380→INVOICE, 381→CREDIT_NOTE, 386→ADVANCE_INVOICE, 384→CORRECTIVE_INVOICE, 389→SELF_BILLED, 393→FACTORING, 503→ADVANCE_CREDIT_NOTE`. ✅

Données clés captées :

- **BT-113 `prepaidAmount`** : [ubl.parser.ts:263-264](apps/worker/src/parsers/ubl.parser.ts#L263-L264), [cii.parser.ts:211-214](apps/worker/src/parsers/cii.parser.ts#L211-L214) ✅
- **BT-25 `correctedInvoiceRef`** : [ubl.parser.ts:210-214](apps/worker/src/parsers/ubl.parser.ts#L210-L214) (`BillingReference/InvoiceDocumentReference/ID`), [cii.parser.ts:157-163](apps/worker/src/parsers/cii.parser.ts#L157-L163) (`InvoiceReferencedDocument/IssuerAssignedID`) ✅
- **`typeTransaction`** (CIUS-FR 1/2/3) : [ubl.parser.ts:217-225](apps/worker/src/parsers/ubl.parser.ts#L217-L225) ✅
- **BT-107/108 allowance/charge** : captés ✅

**ÉCART P1 — bénéficiaire/factor (BG-10 / `PayeeParty`) jamais parsé.**
Le type `ParsedInvoice` ne possède **aucun** champ payee/factor ([types.ts:31-58](apps/worker/src/parsers/types.ts#L31-L58)), et `SupplierExtracted` non plus ([types.ts:13-29](apps/worker/src/parsers/types.ts#L13-L29)). Aucun parseur ne lit `cac:PayeeParty` (UBL) ni le bénéficiaire CII. Conséquence directe : pour un **393 affacturage**, l'identité/IBAN du factor reçu est **perdu dès l'ingestion** → impossible de router le paiement vers le factor en SAP (cf. §2.6/§4.2). Le **générateur**, lui, sait émettre `PayeeParty` ([invoice-generator.service.ts:1193-1216](apps/api/src/services/invoice-generator.service.ts#L1193-L1216)) : l'asymétrie est uniquement côté **réception**.

**Écart mineur** — CII ne renseigne pas `supplierExtracted` (`null`, [cii.parser.ts:325](apps/worker/src/parsers/cii.parser.ts#L325)) là où UBL l'extrait. Sans impact sur le routage par type, mais appauvrit l'enrichissement fournisseur pour les flux reçus en CII.

### 2.2 Dédoublon / idempotence / supersession (`db-writer.ts`)

**Conforme.** Ordre dans `writeInvoice` : idempotence `paMessageId` → doublon SHA-256 → **branche 384** → doublon métier `doc+fournisseur` ([db-writer.ts:147-204](apps/worker/src/ingestion/db-writer.ts#L147-L204)).

- 384 avec `correctedInvoiceRef` : `handleCorrectiveInvoice` cherche l'originale `(supplier, docNumberPa==ref, DISPUTED)`, supersède **puis** crée le 384 `NEW` + `replaces.connect` ; sinon `TO_REVIEW` + `statusReason` ([db-writer.ts:99-141](apps/worker/src/ingestion/db-writer.ts#L99-L141)). ✅
- Le contournement du dédoublon métier est strictement limité à `CORRECTIVE_INVOICE && correctedInvoiceRef` ([db-writer.ts:184-186](apps/worker/src/ingestion/db-writer.ts#L184-L186)). Les autres types restent dédoublonnés normalement. ✅

**Limite assumée (déjà documentée dans le CR du 384)** : un 384 **sans** `correctedInvoiceRef`, ou une originale qui n'est **pas** en `DISPUTED`, retombe en `TO_REVIEW` — correct fonctionnellement (on ne perd pas la facture), mais aucune réconciliation automatique ultérieure.

### 2.3 Matching / enrichment

**Type-agnostique.** `enrichment.service.ts` ne référence ni `direction`, ni `prepaidAmount`, ni `correctedInvoiceRef` (0 occurrence sur tout `apps/api/src/services` hors générateur/builder). Le matching se fait par fournisseur / comptes / TVA indépendamment du type de document.

- **Conséquence neutre** pour 380/381/389/393 (mêmes besoins qu'une facture). ✅
- **Conséquence à surveiller** pour 386/503 : un acompte et son avoir d'acompte sont enrichis comme des factures ordinaires (comptes de charge/TVA déductible), alors qu'ils devraient pointer des **comptes d'acompte** (ex. 4091/fournisseurs-avances) et un compte de TVA sur acompte. Aucun garde-fou. → rattaché à §4.

### 2.4 Cycle de vie & transitions

Enum `InvoiceStatus` complet : `NEW, TO_REVIEW, READY, POSTED, LINKED, REJECTED, DISPUTED, SUPERSEDED, ERROR` ([schema.prisma:45-61](packages/database/prisma/schema.prisma#L45-L61)). ✅

- **Litige (DISPUTED)** : entrée autorisée seulement depuis `NEW/TO_REVIEW/READY` ([litige.service.ts:10](apps/api/src/services/litige.service.ts#L10)) ; levée seulement depuis `DISPUTED` ([litige.service.ts:36-43](apps/api/src/services/litige.service.ts#L36-L43)). ✅
- **Statuts terminaux** : `TERMINAL_STATUSES = {POSTED, LINKED, REJECTED, SUPERSEDED}` ([invoices.ts:69](apps/api/src/routes/invoices.ts#L69)) bloquent modification/intégration ([invoices.ts:1543,1676,1861](apps/api/src/routes/invoices.ts#L1543)). `SUPERSEDED` aussi dans `nonLinkableStatuses` (Voie B, [invoices.ts:1329-1330](apps/api/src/routes/invoices.ts#L1329-L1330)). ✅
- **Atteinte des statuts par type** : tous les types passent par le même pipeline `NEW → (TO_REVIEW|READY) → POSTED`. Aucun statut spécialisé pour acompte « soldable » (matrice S/B niveau 4) ni pour « payée » (niveau 2). → §4.

### 2.5 Routage SAP (`invoices.ts`, 2 emplacements)

Les **deux** points de décision `docType` sont **identiques** :

- Bulk : [invoices.ts:390-395](apps/api/src/routes/invoices.ts#L390-L395)
- Unitaire : [invoices.ts:1069-1074](apps/api/src/routes/invoices.ts#L1069-L1074)

```
CREDIT_NOTE | ADVANCE_CREDIT_NOTE → PurchaseCreditNotes
ADVANCE_INVOICE                   → APDownPayments
sinon (INVOICE/CORRECTIVE/SELF_BILLED/FACTORING) → PurchaseInvoices
```

- **503** routé en `PurchaseCreditNotes` avec `// TODO 503 : contre-passation APDownPayment … différé, route avoir simple` ([invoices.ts:389](apps/api/src/routes/invoices.ts#L389), [:1068](apps/api/src/routes/invoices.ts#L1068)) → §4.1.
- **393** tombe dans le `sinon` → traité comme un 380 (aucune logique factor) → §4.2.
- **384/389** → `PurchaseInvoices`, conforme (nouvelle facture/ autofacture). ✅
- **386** → `APDownPayments` : bon endpoint, mais payload inadapté (§2.6).

### 2.6 Payload SAP (`sap-invoice-builder.ts`)

**`buildPurchaseDocPayload`** ([sap-invoice-builder.ts:93-147](apps/api/src/services/sap-invoice-builder.ts#L93-L147)) :

- Produit **toujours** `DocType: 'dDocument_Service'` + lignes `LineType: 'acAccount'` ([:130-143](apps/api/src/services/sap-invoice-builder.ts#L130-L143)).
- **ÉCART P0 (F3) — `prepaidAmount`/`DownPaymentsToDraw` totalement absents.** Le builder ne lit jamais `invoice.prepaidAmount` ; `DownPaymentsToDraw` = **0 occurrence** dans tout `apps/`. Une 380 définitive portant un acompte BT-113 est postée **pour son TTC plein**, sans tirage de l'acompte SAP → **double comptage** de l'acompte (une fois en 386, une fois dans la définitive). C'est l'écart de justesse comptable le plus grave.
- **ÉCART P1 (386) — payload de down payment non conforme.** `createPurchaseDoc` envoie ce **même** payload générique vers `APDownPayments` (cf. commentaire « partage la même structure » [sap-sl.service.ts:239-241](apps/api/src/services/sap-sl.service.ts#L239-L241)). Or un A/P Down Payment SAP B1 attend des champs propres (notamment `DownPaymentType`, et le rattachement de la TVA d'acompte). Risque : rejet SL ou down payment mal typé. **Non vérifié en runtime** (lecture seule) — structure exacte à confirmer via métadonnées SL → §4.4.

**`buildJournalEntryPayload`** ([sap-invoice-builder.ts:164-300](apps/api/src/services/sap-invoice-builder.ts#L164-L300)) :

- **ÉCART — ne distingue que `isCreditNote = direction === 'CREDIT_NOTE'`** ([:173](apps/api/src/services/sap-invoice-builder.ts#L173)). Donc en mode `JOURNAL_ENTRY` :
  - **503 (`ADVANCE_CREDIT_NOTE`)** est booké **en débit** comme une facture normale → **sens comptable inversé** (devrait créditer). Bug réel du mode écriture.
  - **386/384/389/393** bookés comme factures ordinaires (pas de compte d'acompte, pas de logique factor). 386 perd toute notion d'acompte en mode JE.
- Pas de `PayToCode`, pas de contrepartie vers un factor (0 occurrence).

### 2.7 Appel Service Layer (`sap-sl.service.ts`)

- `createPurchaseDoc` : union `'PurchaseInvoices' | 'PurchaseCreditNotes' | 'APDownPayments'`, **même payload** pour les trois ([sap-sl.service.ts:243-277](apps/api/src/services/sap-sl.service.ts#L243-L277)). Confirme §2.6 : aucune spécialisation down-payment côté client SL.
- `createJournalEntry` ([:439-475](apps/api/src/services/sap-sl.service.ts#L439-L475)).
- **Aucun** endpoint `OutgoingPayments` / `IncomingPayments` / lettrage (réconciliation) : 0 occurrence. → niveau payé impossible (§2.8).

### 2.8 Niveau payé (matrice S/B niveau 2)

**Inexistant.** `OutgoingPayment`, `U_NOVA_Statut`, lettrage : **0 occurrence** dans tout le repo. Aucune détection du statut de règlement à l'ingestion, aucun poste de paiement sortant, aucun lettrage. Le programme s'arrête au **niveau 1** (poste ouvert via PurchaseInvoice/JournalEntry). → §4.3.

### 2.9 Validation / policy

- `sap-validation.service.ts` : contrôles **purement génériques** (statut, pièce jointe, fournisseur, comptes, TVA, centres de coût) — [sap-validation.service.ts:61-309](apps/api/src/services/sap-validation.service.ts#L61-L309). **Aucun** contrôle par type : pas de vérification de cohérence BT-3/BT-23, pas de contrôle d'acompte, **rien ne détecte ni n'alerte le double comptage F3**, rien n'exige un factor pour un 393, rien ne valide la structure d'un 386. Une 380-après-acompte passe la validation « verte » puis poste un montant faux.
- `sap-policy.service.ts` : pilote seulement `simulate/real/disabled` + politique pièce jointe ([sap-policy.service.ts:59-77](apps/api/src/services/sap-policy.service.ts#L59-L77)). Aucune dimension type de document.

### 2.10 Retour statut PA (`pa-status.*`)

Mapping statut → cycle PA ([pa-status.ts:85-91](packages/database/src/pa-status.ts#L85-L91)) :
`POSTED|LINKED → VALIDATED ; DISPUTED → IN_DISPUTE ; tout autre → REJECTED`.

- POSTED/REJECTED : envoi automatique via le job ([pa-status-job.ts:29-44](apps/worker/src/jobs/pa-status-job.ts#L29-L44), filtre `status IN (POSTED, REJECTED)`). ✅
- DISPUTED (IN_DISPUTE) : envoyé à la mise en litige ([invoices.ts:2105](apps/api/src/routes/invoices.ts#L2105)) ; RECEIVED renvoyé à la levée ([invoices.ts:2210](apps/api/src/routes/invoices.ts#L2210)). ✅
- **ÉCART P2 (384) — l'originale SUPERSEDED ne renvoie aucun cycle de clôture à la PA.** La supersession se fait dans le worker (`db-writer`) **sans** appeler `sendPaStatus`, et le job n'envoie que `POSTED/REJECTED`. L'originale, déjà notifiée `IN_DISPUTE`, **reste perçue en litige côté PA** indéfiniment ; le 384 part bien en `VALIDATED`, mais le litige initial n'est jamais soldé vis-à-vis de la PA. De plus, si un `SUPERSEDED` était un jour envoyé, il serait mappé en **`REJECTED`** ([pa-status.ts:85-90](packages/database/src/pa-status.ts#L85-L90)) — sémantiquement faux (remplacée ≠ rejetée). → §4.5.

---

## 3. Liste priorisée des écarts

| #   | Prio   | Flux         | Écart                                                                   | Preuve                                                                                                        | Effet                                                                 |
| --- | ------ | ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **P0** | F3           | Acompte BT-113 non déduit (`DownPaymentsToDraw` absent)                 | builder [93-147](apps/api/src/services/sap-invoice-builder.ts#L93-L147) ; 0 occ. `DownPaymentsToDraw`         | **Double comptage** de l'acompte, TTC surévalué                       |
| 2   | **P1** | 503          | Pas de contre-passation `APDownPayment` (route avoir simple)            | TODO [invoices.ts:389](apps/api/src/routes/invoices.ts#L389) / [:1068](apps/api/src/routes/invoices.ts#L1068) | Acompte SAP non soldé, avoir mal imputé                               |
| 3   | **P1** | 393          | Paiement factor non reflété (`PayToCode` absent) **et** payee non parsé | parsers (aucun `PayeeParty`) ; routage = 380                                                                  | Règlement dirigé vers le fournisseur, pas le factor                   |
| 4   | **P1** | 386          | Payload `APDownPayments` = payload générique (`DownPaymentType` absent) | [sap-sl.service.ts:239-241](apps/api/src/services/sap-sl.service.ts#L239-L241) ; builder                      | Rejet SL probable ou down payment mal typé                            |
| 5   | **P1** | Niveau payé  | `OutgoingPayments`/lettrage/`U_NOVA_Statut` inexistants                 | 0 occurrence                                                                                                  | Niveau 2 (matrice S/B) non géré                                       |
| 6   | **P1** | 503/386 (JE) | Mode `JOURNAL_ENTRY` ne gère que `CREDIT_NOTE`                          | [sap-invoice-builder.ts:173](apps/api/src/services/sap-invoice-builder.ts#L173)                               | 503 booké en débit (**sens inversé**) ; 386 sans logique acompte      |
| 7   | **P2** | 384          | Originale SUPERSEDED : pas de clôture renvoyée à la PA                  | worker `db-writer` (pas de `sendPaStatus`) ; job filtre POSTED/REJECTED                                       | Litige jamais soldé côté PA ; mapping `SUPERSEDED→REJECTED` si envoyé |
| 8   | **P3** | CII          | `supplierExtracted = null`                                              | [cii.parser.ts:325](apps/worker/src/parsers/cii.parser.ts#L325)                                               | Enrichissement fournisseur appauvri en CII                            |

---

## 4. Décisions SAP à trancher (à valider équipe / expert-comptable / PDP)

> Ce sont des **mécanismes comptables** à choisir, pas seulement des bugs à corriger.

### 4.1 Contre-passation du 503 (avoir d'acompte)

**Problème** : un 503 doit annuler un `APDownPayment` existant, pas créer un avoir d'achat ordinaire.
**Options** : (a) `PurchaseCreditNotes` basé sur le down payment d'origine (rattachement `BaseEntry`) ; (b) annulation/cancellation native de l'`APDownPayment` SAP ; (c) écriture de contre-passation dédiée.
**Recommandation** : (a) si SAP B1 autorise un credit note adossé au down payment ; sinon (b). Prérequis : tracer le `DocEntry` du 386 d'origine (aujourd'hui non conservé) pour le retrouver.

### 4.2 Routage du paiement factor (393)

**Problème** : la facture est cédée ; le règlement va au factor (cessionnaire).
**Options** : (a) `PayToCode` = BP factor sur le document SAP ; (b) BP « factor » distinct ; (c) gestion hors SAP.
**Recommandation** : (a), **mais nécessite d'abord de parser `PayeeParty`** (BG-10) à l'ingestion (§2.1) et de résoudre/créer le BP factor. Sans ces deux prérequis, 393 = 380 (état actuel).

### 4.3 Niveau payé (matrice S/B niveau 2 : paiement sortant + lettrage + `U_NOVA_Statut`)

**Problème** : NOVA ne dépasse pas le poste ouvert.
**Options** : (a) implémenter `OutgoingPayments` + réconciliation interne + UDF `U_NOVA_Statut` ; (b) déléguer le paiement au cycle SAP natif (NOVA s'arrête au niveau 1) ; (c) hybride piloté par un flag de canal.
**Recommandation** : à trancher selon le périmètre cible — décision **structurante**, pas un simple correctif.

### 4.4 Structure exacte du payload `APDownPayment` (386)

**Problème** : payload générique réutilisé.
**Action proposée (lecture seule)** : consulter les **métadonnées SL** (`$metadata` de `APDownPayments`) pour lister les champs requis (`DownPaymentType`, TVA d'acompte, compte) avant de spécialiser `buildPurchaseDocPayload`. Aucune écriture nécessaire pour ce relevé.

### 4.5 Cycle PA de l'originale supersédée (384)

**Problème** : `SUPERSEDED` ne renvoie rien à la PA ; le mapping par défaut la classerait `REJECTED`.
**Options** : (a) introduire un `outcomeOverride` dédié (ex. `SUPERSEDED`/`CANCELLED`) émis à la supersession ; (b) renvoyer `RECEIVED`/clôture sur l'originale ; (c) ne rien renvoyer (statu quo, à acter explicitement).
**Recommandation** : (a) — aligner le cycle de vie réforme avec le sort réel de la facture, et éviter le faux `REJECTED`.

---

## 5. Verdict

**Le programme ne traite correctement de bout en bout, aujourd'hui, que les flux « simples » sans mécanique d'acompte ni de cession** :

- ✅ **Sûrs** : **380** (F1), **381** (avoir simple), **389** (autofacturation — l'autofacture reste une facture standard côté SAP ; la mention légale relève du générateur). En mode `SERVICE_INVOICE`.
- ⚠️ **À risque / partiels** : **386** (bon endpoint, payload à confirmer) ; **384** (correct côté SAP, mais clôture PA de l'originale manquante).
- ❌ **Produisent une écriture SAP incorrecte** :
  - **F3 (380 après acompte)** — **double comptage** de l'acompte (**P0**, justesse comptable).
  - **503** — avoir simple au lieu d'une contre-passation d'`APDownPayment` ; **sens inversé** en mode `JOURNAL_ENTRY`.
  - **393** — règlement dirigé vers le fournisseur au lieu du factor (payee perdu dès le parsing).
  - **Niveau payé (S/B 2)** — non géré (pas de paiement sortant ni lettrage).

**Priorité de correction** : **F3 (P0)** d'abord — c'est le seul écart qui fausse silencieusement un montant comptable sur un flux courant, sans aucune alerte de validation. Viennent ensuite 503, 393 et le payload 386 (P1), puis le mode `JOURNAL_ENTRY` (P1, 503 inversé), enfin la clôture PA du 384 (P2).

---

_Fin de l'audit — lecture seule. Aucun fichier modifié hormis la création de ce CR ; aucune écriture SAP ; aucune migration. Tous les écarts sont référencés `fichier:ligne`. Les mécanismes comptables (§4) restent à arbitrer avant correctif._
