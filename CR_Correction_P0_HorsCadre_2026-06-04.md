# Compte-rendu de correction — Gaps P0 « hors cadre » du générateur de factures

**Date** : 2026-06-04
**Référence audit** : `CR_Audit_Conformite_ATGP_v31_2026-06-03.md`
**Périmètre** : 5 corrections P0 — **hors** cadre BT-23 (matrice B/S/M) et **hors** `CustomizationID` (BT-24), réservés à un prompt ultérieur.
**Cas de validation** : `Invoice-3F868EA1-0015.pdf` (OpenAI → IT SPIRIT — reverse charge intracom, USD, vendeur étranger).

---

## 1. Synthèse

| #   | Correction                                                 | BT            | Statut | Vérifié XML | Vérifié PDF |
| --- | ---------------------------------------------------------- | ------------- | ------ | ----------- | ----------- |
| 1   | Pays vendeur/acheteur toujours émis                        | BT-40 / BT-55 | ✅     | ✅          | n/a         |
| 2   | Devise de comptabilisation TVA + 2ᵉ TaxTotal               | BT-6 / BT-111 | ✅     | ✅          | ✅          |
| 3   | Bloc `cac:Delivery` + date de livraison                    | BT-72         | ✅     | ✅          | ✅          |
| 4   | Autoliquidation outillée (AE + VATEX-FR-AE + PDF + preset) | BT-120/121    | ✅     | ✅          | ✅          |
| 5   | Scheme `EndpointID` correct pour identifiants non-FR       | BT-34 / BT-49 | ✅     | ✅          | n/a         |

**Vérifications globales** : `typecheck` (api + web) **clean** ; `eslint` sur les 4 fichiers **clean** ; suite générateur `tests/unit/invoice-generator.test.ts` **47/47 ✅** ; aucune régression introduite (les 3 échecs de `tests/integration/api-invoices.test.ts` **préexistent** — confirmé via `git stash`, 3 échecs identiques sur `main` non modifié ; ils concernent la résolution de comptes SAP B1 et la politique de pièces jointes, sans lien avec le générateur).

`ProfileID` (BT-23) et `CustomizationID` (BT-24) **n'ont pas été touchés**.

---

## 2. Modifications fichier par fichier

### `apps/api/src/services/invoice-generator.service.ts`

- **Interface `InvoiceGenData`** : ajout de `taxCurrency?`, `taxExchangeRate?`, `deliveryDate?`.
- **Helpers module (Correction 5)** : ajout de `VAT_EAS_BY_PREFIX` (table préfixe pays TVA → code EAS Peppol, sourcée sur la _Peppol Code List EAS_ — préfixe grec « EL » → 9933), de `vatEasScheme()` et de `buildEndpointId()`. Cette dernière : SIRET → `0009` ; sinon TVA avec scheme EAS du pays ; sinon (préfixe inconnu/non standard type « EU ») **EndpointID sans scheme** précédé d'un commentaire `<!-- TODO EAS scheme à confirmer … -->`. **Jamais `9957` pour un non-FR.**
- **`supplierEndpoint` / `buyerEndpoint`** : remplacés par des appels à `buildEndpointId(...)` (vendeur **et** acheteur).
- **Correction 1** : `supplierAddress` et `buyerAddressBlock` ré-écrits pour émettre **toujours** `cac:PostalAddress/cac:Country/cbc:IdentificationCode`, même rue/ville/CP vides (pays par défaut `FR` conservé).
- **Correction 2** : en tête de `generateUblXml`, calcul de `needsTaxCurrency` (= `taxCurrency` défini ET ≠ `currency`) ; **erreur `InvoiceValidationError`** si `needsTaxCurrency` sans `taxExchangeRate` ; émission conditionnelle de `cbc:TaxCurrencyCode` (après `DocumentCurrencyCode`, position UBL correcte) et d'un **second `cac:TaxTotal`** ne portant que `cbc:TaxAmount` converti (BT-111 = `round2(totalTax * taxExchangeRate)`).
- **Correction 3** : `deliveryBlock` conditionnel ; `cac:Delivery/cbc:ActualDeliveryDate` inséré **après `AccountingCustomerParty` et avant `PaymentMeans`** (ordre exact du schéma UBL Invoice / Peppol BIS — vérifié, le bloc précède `PaymentMeans` et `TaxTotal`). Commentaire signalant que `cac:DeliveryLocation/cac:Address` (BG-15) reste **hors périmètre**.
- **Correction 4a** : `renderExemption(cat, code, reason)` — pour `cat === 'AE'`, auto-complétion `VATEX-FR-AE` / `Autoliquidation` si aucun motif explicite. Les deux appels (TaxSubtotal et ClassifiedTaxCategory) passent désormais la catégorie. Aucune autre catégorie modifiée ; **aucune déduction automatique de AE** (réservée à la matrice S/B).
- **Correction 4b (PDF)** : la mention/motif est imprimée pour **`E`, `AE`, `K`, `G`, `O`** (et plus seulement `E`). Pour `AE`, libellé « Mention : Autoliquidation (VATEX-FR-AE) ».
- **Correction 2c (PDF)** : ligne « Total TVA (devise de comptabilisation) : {montant} {EUR} (taux …) » si `taxCurrency` ≠ `currency`.
- **Correction 3c (PDF)** : ligne « Date de livraison (BT-72) : {date} » dans le bloc RÉFÉRENCES.

### `apps/api/src/routes/invoice-generator.ts`

Schéma Fastify : ajout de `taxCurrency` (3 c.), `taxExchangeRate` (`number`, `exclusiveMinimum: 0`), `deliveryDate` (`format: date`).

### `apps/web/src/api/generator.api.ts`

Type `InvoiceGenData` : ajout de `taxCurrency?`, `taxExchangeRate?`, `deliveryDate?`.

### `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- `defaultForm()` : `taxCurrency: 'EUR'`, `taxExchangeRate: undefined`, `deliveryDate: undefined`.
- En-tête facture : champs « Date de livraison (BT-72) », « Devise compta. TVA (BT-6) », et « Taux de conversion TVA » (affiché **uniquement si** `taxCurrency` ≠ `currency`).
- **Preset (Correction 4c)** : groupe « Autoliquidation (AE) » → preset « AE — Prestation intracommunautaire » (fournisseur DE, ligne catégorie `AE` à 0 %, motif laissé vide → auto-complété, compte classe 6 `628000`).

---

## 3. Vérification runtime sur le profil OpenAI (AE + USD + vendeur EU OSS)

Profil testé : `currency=USD`, `taxCurrency=EUR`, `taxExchangeRate=0.92`, 1 ligne `AE` 0 %, `deliveryDate=2026-05-05`, vendeur `OpenAI OpCo, LLC` (pays `US`, TVA `EU372041333`, **sans adresse**), acheteur `IT SPIRIT` (`FR57512520370`).

**XML produit (extraits)** :

```xml
<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>EUR</cbc:TaxCurrencyCode>
...
<cac:AccountingSupplierParty><cac:Party>
  <!-- TODO EAS scheme à confirmer pour le préfixe TVA "EU" -->
  <cbc:EndpointID>EU372041333</cbc:EndpointID>
  ... <cac:Country><cbc:IdentificationCode>US</cbc:IdentificationCode></cac:Country>
<cac:AccountingCustomerParty><cac:Party>
  <cbc:EndpointID schemeID="9957">FR57512520370</cbc:EndpointID>
...
<cac:Delivery><cbc:ActualDeliveryDate>2026-05-05</cbc:ActualDeliveryDate></cac:Delivery>
<cac:TaxTotal><cbc:TaxAmount currencyID="USD">0.00</cbc:TaxAmount>
  ...<cbc:TaxExemptionReasonCode>VATEX-FR-AE</cbc:TaxExemptionReasonCode>
     <cbc:TaxExemptionReason>Autoliquidation</cbc:TaxExemptionReason>
</cac:TaxTotal>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount></cac:TaxTotal>
```

**Résultats des assertions** (16/16, après correction d'une assertion de test trop large) :

- ✅ BT-5 = USD ; ✅ **BT-6 = EUR** ; ✅ **2ᵉ TaxTotal en EUR (BT-111)**.
- ✅ Catégorie `AE` ; ✅ **`VATEX-FR-AE`** et ✅ **`Autoliquidation`** auto-complétés.
- ✅ Bloc **`cac:Delivery`** + `ActualDeliveryDate` ; ✅ positionné **avant** `TaxTotal`.
- ✅ Vendeur EU OSS : **pas de `9957`**, commentaire **TODO EAS** présent ; ✅ acheteur FR : `9957` (correct — c'est un identifiant **français**).
- ✅ **Pays vendeur émis** (`US`) malgré adresse vide ; ✅ pays acheteur (`FR`).
- ✅ `DE123456789` → **scheme `9930`** ; ✅ `FR12345678901` → **scheme `9957`**.
- ✅ **Erreur de validation** si `taxCurrency` ≠ `currency` sans `taxExchangeRate`.
- ✅ Cas EUR pur : **ni `TaxCurrencyCode` ni 2ᵉ TaxTotal** (1 seul `TaxTotal`).

> Note : l'unique assertion initialement « ❌ » testait l'absence totale de `9957` dans le document ; or l'acheteur **est** français et porte légitimement `9957`. Le code est correct ; l'assertion a été corrigée pour ne viser que le bloc vendeur.

**PDF produit** — lignes confirmées :

- « Date de livraison (BT-72) : 2026-05-05 »
- « TVA 0% [AE — Autoliquidation] — Base : 20.00 — TVA : 0.00 USD »
- « **Mention : Autoliquidation (VATEX-FR-AE)** »
- « Total TVA (devise de comptabilisation) : 0.00 EUR (taux 0.92) »

Le générateur **reproduit désormais le profil `Invoice-3F868EA1-0015`** (reverse charge intracom, USD), aux réserves « hors périmètre » ci-dessous près.

> Le script de vérification et les fichiers générés ont été **supprimés** après contrôle (aucun artefact laissé).

---

## 4. Points explicitement laissés HORS PÉRIMÈTRE

- **Cadre BT-23 (matrice B/S/M)** — `ProfileID` inchangé (consigne stricte).
- **`CustomizationID` (BT-24)** — inchangé.
- **Adresse de livraison BG-15** (`cac:DeliveryLocation/cac:Address`, « Ship to ») — le bloc `cac:Delivery` est laissé **extensible** (commentaire), mais l'adresse n'est pas implémentée.
- **Représentant fiscal vendeur (BT-62/63/69)** — non traité (P1/audit).
- **Codes EAS non couverts** : pour un préfixe TVA hors table (ex. OSS « EU »), l'`EndpointID` est émis **sans schemeID** + commentaire TODO. C'est volontaire (« pas de valeur fausse ») mais **non conforme Peppol** en l'état → à finaliser quand le scheme cible sera arbitré.
- **Autres gaps de l'audit** (BT-3 = 389/393…, rabais `AllowanceCharge`, BT-26, mentions BT-21 structurées, BT-83, BG-32, sentinelles `FRAIS-GESTION-CLASSE6`/`REF-…`/`NA`) — non traités ici.

---

## 5. Interaction connue (non bloquante, hors périmètre)

Le parser `apps/worker/src/parsers/ubl.parser.ts` lit `cac:TaxTotal` comme un **objet unique**. Sur une facture en devise étrangère (deux `TaxTotal`), son extraction de la TVA totale serait dégradée (sans plantage). Limitation **préexistante** du worker, non incluse dans les 4 fichiers du périmètre → à traiter séparément si le round-trip worker des factures multidevises devient nécessaire.

---

## 6. Aucune migration

Les trois nouveaux champs (`taxCurrency`, `taxExchangeRate`, `deliveryDate`) sont des **entrées du générateur** (payload de requête), **pas des colonnes persistées** : aucune migration de base de données n'est requise.

---

_Fin du compte-rendu de correction. typecheck/lint verts, 47/47 tests générateur, profil OpenAI reproduit en XML + PDF._
