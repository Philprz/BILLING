# Compte-rendu d'audit de conformité — Générateur de factures de test

**Référentiel** : ATGP « FAC@EDI Format de fichier import/export V3.19.322 du 17/03/2026 » / Spécifications externes DGFiP B2B v3.1 (11/2025) — modèle `atgp-model-invoic`
**Périmètre audité** : émission **UBL 2.1** (XML) + **représentation PDF** du générateur de factures de test
**Date** : 2026-06-03
**Nature** : audit en **lecture seule** — aucune modification de code

---

## 0. Cadrage et limites de l'audit

- **Fichier source de vérité** : [invoice-generator.service.ts](apps/api/src/services/invoice-generator.service.ts) (émission XML : `generateUblXml`, lignes 199-579 ; émission PDF : `writePdf`, lignes 583-1021).
- **Schéma d'entrée** : [invoice-generator.ts](apps/api/src/routes/invoice-generator.ts) (validation Fastify, lignes 85-155).
- **Types & presets web** : [generator.api.ts](apps/web/src/api/generator.api.ts), [InvoiceGeneratorPage.tsx](apps/web/src/pages/InvoiceGeneratorPage.tsx).
- **Documents de référence** : le PDF ATGP V3.19.322 et le modèle JSON `atgp-model-invoic` **n'ont pas été trouvés** sous `C:\Users\PPZ` ; l'audit s'appuie donc, pour le référentiel, sur les checklists BT/BG transmises dans la consigne (qui reprennent le mapping officiel). En revanche, le **PDF de référence `Invoice-3F868EA1-0015.pdf` (OpenAI → IT SPIRIT) est désormais disponible à la racine de BILLING et a été confronté au code** (section 6).
- Le dossier « projet NOVA PA » n'existant pas, le CR est déposé à la **racine du monorepo BILLING**.

---

## 1. Synthèse

| Bloc                           | ✅ Émis & correct | ⚠️ Partiel / à risque | ❌ Absent | N/A | Total |
| ------------------------------ | ----------------- | --------------------- | --------- | --- | ----- |
| **Table A.1 — #DEMARRAGE**     | 14                | 4                     | 6         | 0   | 24    |
| **Table A.2 — #CIBLE**         | 3                 | 0                     | 5         | 0   | 8     |
| **Table B — EN16931 / Peppol** | 6                 | 4                     | 2         | 2   | 14    |

**Taux de conformité stricte (✅ uniquement)** :

- #DEMARRAGE : **14/24 ≈ 58 %**
- #CIBLE : **3/8 ≈ 38 %**
- EN16931 / Peppol : **6/14 ≈ 43 %** (hors 2 N/A : 6/12 = 50 %)

**Verdict global** : le générateur produit une facture UBL 2.1 « EN16931-like / Peppol BIS 3.0 » techniquement bien structurée sur le **tronc commun** (identités, totaux, ventilation TVA, lignes), mais il **ne porte pas plusieurs données structurantes de la réforme française** : cadre de facturation **B/S/M (BT-23)**, **date de livraison (BT-72)**, **autoliquidation outillée (AE + VATEX-FR-AE)**, **autofacturation (389)**, **rabais/remises (AllowanceCharge)**, **devise de comptabilisation TVA (BT-6)**, et plusieurs **mentions légales structurées (BT-21)**. Il s'appuie en outre sur des **sentinelles** (`FRAIS-GESTION-CLASSE6`, `REF-…`, `NA`) et des **mappings non standard** (TypeTransaction / OptionTVA en `AdditionalDocumentReference`).

---

## 2. Table A — Données obligatoires « Généralisation »

### A.1 — #DEMARRAGE

| #   | Donnée (BT/BG)                                             | Statut | Emplacement code                                   | Constat & recommandation                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SIREN assujetti vendeur                                    | ✅     | service `supplierSiret` L.348-351 ; émis L.548     | Émis en `PartyLegalEntity/CompanyID schemeID="0002"` = **SIRET (14 c.)**, pas SIREN strict. Acceptable (SIREN ⊂ SIRET). Reco : documenter que la donnée portée est le SIRET.                                                                                                                                |
| 2   | N° TVA vendeur (BT-31)                                     | ✅     | `supplierTaxScheme` L.340-346                      | Présent en `PartyTaxScheme/CompanyID`. Conditionnel à `taxId`.                                                                                                                                                                                                                                              |
| 3   | Pays vendeur (BT-40)                                       | ⚠️     | `supplierAddress` L.315-338 (pays L.335)           | Le bloc `PostalAddress` **entier** (donc le pays) n'est émis **que si** `address` **ou** `city` est renseigné. Si le fournisseur n'a ni rue ni ville, **BT-40 disparaît** (violation EN16931 BR-09). Reco : toujours émettre `cac:Country` même adresse vide.                                               |
| 4   | SIREN client                                               | ✅     | `buyerLegalEntity` L.448-461 (L.453)               | `CompanyID schemeID="0002"` conditionnel à `buyerSiret`.                                                                                                                                                                                                                                                    |
| 5   | N° TVA client (BT-48)                                      | ✅     | `buyerTaxScheme` L.439-445                         | Conditionnel à `buyerVatNumber`.                                                                                                                                                                                                                                                                            |
| 6   | Pays client (BT-55)                                        | ⚠️     | `buyerAddressBlock` L.414-437 (pays L.434)         | Même défaut qu'au #3 : bloc adresse conditionnel ; pays omis si aucune des 3 sous-données présentes (BR-11).                                                                                                                                                                                                |
| 7   | **Cadre catégorie d'opération (BT-23 → B1/S1/M1…)**        | ❌     | `ProfileID` **codé en dur** L.524                  | `ProfileID` = `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0` (processus Peppol), **jamais** le cadre **B1/S1/M1 / B2/S2/M2 / B4/S4/M4 / S5/S6 / B7/S7** (table ENT.35). La donnée `typeTransaction` (1/2/3 = Biens/Services/Mixte) n'est **pas** la matrice S/B. **Chaînon réforme manquant.**               |
| 8   | Date d'émission (BT-2)                                     | ✅     | `IssueDate` L.526                                  |                                                                                                                                                                                                                                                                                                             |
| 9   | Numéro de facture (BT-1)                                   | ✅     | `cbc:ID` L.525                                     |                                                                                                                                                                                                                                                                                                             |
| 10  | N° facture rectifiée (BT-25)                               | ✅     | `billingReferenceBlock` L.484-491                  | `BillingReference/InvoiceDocumentReference/ID`. Conditionnel à `correctedInvoiceRef`.                                                                                                                                                                                                                       |
| 11  | Option paiement TVA d'après les débits (BT-8)              | ⚠️     | `cisuFrBlocks` L.494-513                           | Émis en `AdditionalDocumentReference` (`OptionTVA` = S/E) — **mapping non standard**. EN16931 attend `cbc:TaxPointDate` (BT-7) ou un code d'exigibilité ; aucun `TaxPointDate`/code BT-8 normalisé. Reco : porter l'exigibilité via le mécanisme normé.                                                     |
| 12  | Total HT par taux (BT-116)                                 | ✅     | `taxSubtotals` L.269-282 (L.273)                   | `TaxSubtotal/TaxableAmount`, regroupement par (cat+taux+motif) L.235-254.                                                                                                                                                                                                                                   |
| 13  | Montant taxe par taux (BT-117)                             | ✅     | L.274                                              |                                                                                                                                                                                                                                                                                                             |
| 14  | Taux de TVA (BT-119)                                       | ✅     | L.277                                              | `TaxCategory/Percent`.                                                                                                                                                                                                                                                                                      |
| 15  | Somme totale HT (BT-109)                                   | ✅     | `TaxExclusiveAmount` L.572                         |                                                                                                                                                                                                                                                                                                             |
| 16  | Montant de la taxe à payer (BT-110)                        | ✅     | `TaxTotal/TaxAmount` L.567                         |                                                                                                                                                                                                                                                                                                             |
| 17  | Référence légale d'exonération (BT-120)                    | ✅     | `renderExemption` L.256-267, appel L.277           | `TaxExemptionReason` + `TaxExemptionReasonCode` émis si renseignés sur la ligne. Conditionnel (non auto-rempli pour AE/K).                                                                                                                                                                                  |
| 18  | Devise (BT-5)                                              | ✅     | `DocumentCurrencyCode` L.533                       |                                                                                                                                                                                                                                                                                                             |
| 19  | **Mention « autofacturation » (BT-3 = 389)**               | ❌     | `direction` enum L.96 route ; `typeCode` L.207-213 | L'enum `direction` ne connaît que INVOICE/CREDIT_NOTE/ADVANCE/CORRECTIVE → codes 380/381/386/384. **389 jamais produit.**                                                                                                                                                                                   |
| 20  | Régime particulier art. 242 nonies A (BT-21, code REG/ABL) | ❌     | `Note` libre L.536-539                             | Seule une note **texte libre** existe ; aucun code mention structuré.                                                                                                                                                                                                                                       |
| 21  | **Mention « Autoliquidation » (AE + VATEX-FR-AE)**         | ⚠️     | `taxCatCode` L.221-224 ; enum L.144 route          | `AE` est une valeur **autorisée** mais **jamais auto-déduite** (défaut : `taxRate===0 ? 'Z' : 'S'`), **aucun preset** ne l'utilise et **`VATEX-FR-AE` est absent de tout le code**. EN16931 BR-AE-\* exige un motif d'exonération pour AE : non imposé. Réalisable manuellement, mais ni guidé ni complété. |
| 22  | **Date de livraison / fin de prestation (BT-72)**          | ❌     | —                                                  | **Aucun bloc `cac:Delivery/ActualDeliveryDate`** dans tout le service (confirmé par recherche).                                                                                                                                                                                                             |
| 23  | Date d'acompte si ≠ date facture (BT-83)                   | ❌     | `PrepaidAmount` L.574                              | Le **montant** d'acompte (BT-113) est émis, mais **aucune date** d'acompte ni référence à la facture d'acompte.                                                                                                                                                                                             |
| 24  | Mention « membre d'un assujetti unique » (BT-21, code REG) | ❌     | `Note` libre L.536-539                             | Idem #20 : pas de code mention structuré.                                                                                                                                                                                                                                                                   |

### A.2 — #CIBLE

| #   | Donnée (BT/BG)                                                | Statut | Emplacement code                  | Constat & recommandation                                                                      |
| --- | ------------------------------------------------------------- | ------ | --------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Minoration de prix — rabais/remises/ristournes (BT-136/BT-92) | ❌     | —                                 | **Aucun `cac:AllowanceCharge`** (ni ligne ni document). Impossible de représenter une remise. |
| 2   | Dénomination précise du bien/service (BT-153)                 | ✅     | `Item/Name` L.300                 | `itemName = line.name ?? line.description`.                                                   |
| 3   | Quantité livrée/rendue (BT-129)                               | ✅     | `qtyTag` L.296                    | `InvoicedQuantity` / `CreditedQuantity`.                                                      |
| 4   | Prix HT de chaque bien/service (BT-146)                       | ✅     | `Price/PriceAmount` L.308         |                                                                                               |
| 5   | Adresse de livraison si ≠ client (BG-15)                      | ❌     | —                                 | Pas de `cac:Delivery/DeliveryLocation/Address`.                                               |
| 6   | Date d'émission de la facture rectifiée (BT-26)               | ❌     | `billingReferenceBlock` L.484-491 | Seul l'**ID** est émis ; pas de `cbc:IssueDate` dans `InvoiceDocumentReference`.              |
| 7   | Mention d'escompte (BT-21, code AAB)                          | ❌     | —                                 | Pas de code mention structuré.                                                                |
| 8   | Éco-participation art. L.541-10 (BT-21, code BLU)             | ❌     | —                                 | Idem.                                                                                         |

---

## 3. Table B — Champs requis EN16931 / Peppol BIS

| Champ                                               | Statut   | Emplacement code                       | Constat & recommandation                                                                                                                                                                                             |
| --------------------------------------------------- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BT-3 — type de facture (380/381/384/386/389…)       | ⚠️       | L.207-213, `typeCodeTag` L.532         | 4 codes produits (380/381/386/384). **389 (autofacturée), 393 (affacturage), 261/262/396** absents. Cohérent avec `direction` mais incomplet vs table ENT.16.                                                        |
| BT-24 — CustomizationID (spécification)             | ⚠️       | L.523                                  | `urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0` = Peppol BIS générique. **Pas l'identifiant CIUS-FR** attendu par la réforme (profil français / CTC). À vérifier vs valeur cible DGFiP. |
| BT-27 / BT-44 — raisons sociales                    | ✅       | vendeur L.548 / acheteur L.450         | `RegistrationName`.                                                                                                                                                                                                  |
| BT-34 / BT-49 — EndpointID (adresses électroniques) | ⚠️       | vendeur L.394-400 / acheteur L.405-411 | Émis (schemeID 0009=SIRET, 9957=TVA). **Requis Peppol** mais ici **conditionnel** : si ni SIRET ni TVA, **EndpointID absent** → rejet Peppol (BR-07).                                                                |
| BT-59 — nom du bénéficiaire (Payee)                 | ❌ / N/A | —                                      | Pas de `cac:PayeeParty`. N/A si pas de paiement à un tiers (hors périmètre presets).                                                                                                                                 |
| BT-62/63/69 — représentant fiscal vendeur           | ❌ / N/A | —                                      | Pas de `cac:TaxRepresentativeParty`. Pertinent pour un vendeur étranger (cf. cas OpenAI), sinon N/A.                                                                                                                 |
| BT-81 — code moyen de paiement                      | ⚠️       | `paymentMeans` L.370-391 (L.373)       | `PaymentMeansCode 30` émis **uniquement si IBAN**. Sans IBAN, **aucun moyen de paiement**.                                                                                                                           |
| BT-84 — IBAN (compte de paiement)                   | ✅       | L.376                                  | Conditionnel à `iban`.                                                                                                                                                                                               |
| BG-22 totaux (BT-106/109/112/115)                   | ✅       | `LegalMonetaryTotal` L.570-576         | BT-106 L.571, BT-109 L.572, BT-112 L.573, BT-115 L.575. BT-113 (prepaid) L.574.                                                                                                                                      |
| BG-23 ventilation TVA (BT-116/117/118/119)          | ✅       | `taxSubtotals` L.269-282               | BT-118 (catégorie) L.276.                                                                                                                                                                                            |
| BG-25 lignes (BT-126/129/130/131/146/151/153)       | ✅       | `invoiceLines` L.285-313               | BT-126 L.295, BT-129/130 L.296, BT-131 L.297, BT-146 L.308, BT-151 L.302, BT-153 L.300.                                                                                                                              |
| BG-32 attributs article (BT-160/161)                | ❌       | —                                      | Pas d'`AdditionalItemProperty`. Segment ATT ajouté 03/2026 ; optionnel selon profil.                                                                                                                                 |

---

## 4. Points de vigilance spécifiques

1. **Cadre BT-23 (matrice S/B/M)** — ❌ **non implémenté**. `ProfileID` codé en dur (L.524) ; `typeTransaction` (1/2/3) n'est pas le cadre B1/S1/M1. C'est le gap réforme **n°1**.
2. **Types de document (ENT.16)** — `direction` (enum L.96) → 380/381/386/384 seulement. Manquent **389 / 393 / 261 / 262 / 396**.
3. **Catégories TVA** — enum route L.144 = `S, Z, E, AE, K, O`. **`G` (export hors UE) non sélectionnable** alors qu'il figure dans les libellés PDF (L.880). Aucun preset n'exerce **AE** ni **K** ; **`VATEX-FR-AE` totalement absent**. Risque BR-O/BR-E/BR-AE : les lignes catégorie **O** des presets 63/64 portent 0 % **sans `TaxExemptionReason`** (BR-O-\* en validation stricte).
4. **Devise — BT-6 manquant** — ❌. Seul `DocumentCurrencyCode` (BT-5, L.533) est émis. **Aucun `TaxCurrencyCode` (BT-6)** ni second `TaxTotal` en devise de comptabilisation. **Une facture USD (cas OpenAI) ne porte pas la TVA convertie en EUR** → non conforme dépôt FR hors EUR. (Confirmé : `TaxCurrencyCode` introuvable.)
5. **Sentinelles** :
   - `FRAIS-GESTION-CLASSE6` — `cbc:AccountingCost` document **codé en dur** L.534 (constante, non métier). ⚠️
   - `REF-${invoiceNumber}` — fallback `BuyerReference` (BT-10) L.517-518 / L.753. Masque une donnée potentiellement obligatoire par une valeur fabriquée. ⚠️
   - `NA` — `OrderReference/ID` quand seul BT-14 est fourni L.472-473. ⚠️
   - `${invoiceNumber}_PAIEMENT` (PaymentID L.374) et défaut `DEMO INDUSTRIE SAS` (acheteur L.402) — moins critiques.
6. **Parité XML / PDF** — écarts relevés :
   - **Date de livraison (BT-72)** : absente du XML **et** du PDF.
   - **Motif d'exonération** : le PDF ne l'imprime **que pour la catégorie `E`** (`if (g.cat === 'E' …)` L.897). Pour **AE (autoliquidation)** ou **K**, le motif et la **mention « Autoliquidation » n'apparaissent pas sur le PDF** alors que la mention légale est obligatoire sur le document lisible. ⚠️ **gap fort**.
   - **BT-6 / devise de comptabilisation** : absente du PDF.
   - **Date de facture rectifiée (BT-26)** : absente XML et PDF (seul l'ID « Corrige la facture » L.693-701).
   - Le reste (identités, références BT-10/13/14, totaux, ventilation TVA, IBAN, acompte BT-113) est **présent dans les deux**.

---

## 5. Liste priorisée des gaps

### 5.1 — ❌ Absents (priorité haute)

| Prio | Gap                                                                                   | Réf.                 | Emplacement                                 | Action corrective proposée                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | **Cadre de facturation B/S/M (BT-23)** non émis                                       | A.1#7                | `generateUblXml` L.524                      | Mapper la catégorie d'opération (LB/PS/LBPS) + statut (acompte/définitive) vers le code cadre (B1/S1/M1…) et le porter via le mécanisme attendu par le profil FR. |
| P0   | **Devise de comptabilisation TVA (BT-6)** + 2ᵉ `TaxTotal`                             | Vigilance #4         | après L.533 / L.566-568                     | Ajouter `cbc:TaxCurrencyCode` (EUR par défaut) et, si BT-5 ≠ BT-6, un `cac:TaxTotal` en devise de comptabilisation. **Bloquant pour USD.**                        |
| P0   | **Date de livraison / fin de prestation (BT-72)**                                     | A.1#22               | service (nouveau bloc `cac:Delivery`)       | Ajouter `cac:Delivery/cac:ActualDeliveryDate`, alimenté par un champ de saisie ; reporter sur le PDF.                                                             |
| P1   | **Autoliquidation outillée (AE + VATEX-FR-AE)**                                       | A.1#21               | `taxCatCode` L.221-224, enum L.144          | Auto-déduire AE pour prestation intracommunautaire/extracommunautaire, auto-remplir `VATEX-FR-AE`, **imprimer la mention sur le PDF**, ajouter un preset AE.      |
| P1   | **Mention PDF du motif pour AE/K**                                                    | Vigilance #6         | PDF L.897                                   | Étendre la condition au-delà de `'E'` (toutes catégories exonérées/autoliquidées).                                                                                |
| P1   | **Autofacturation (BT-3 = 389)**                                                      | A.1#19               | enum `direction` L.96, `typeCode` L.207-213 | Ajouter un mode 389 (et idéalement 384 rectificatif déjà géré, 386 acompte déjà géré).                                                                            |
| P1   | **Rabais / remises (AllowanceCharge)**                                                | A.2#1                | service                                     | Implémenter `cac:AllowanceCharge` ligne + document, et `AllowanceTotalAmount` (BT-107).                                                                           |
| P2   | **Date d'émission facture rectifiée (BT-26)**                                         | A.2#6                | `billingReferenceBlock` L.484-491           | Ajouter `cbc:IssueDate` dans `InvoiceDocumentReference`.                                                                                                          |
| P2   | **Adresse de livraison ≠ client (BG-15)**                                             | A.2#5                | service                                     | `cac:Delivery/cac:DeliveryLocation/cac:Address`.                                                                                                                  |
| P2   | **Mentions structurées BT-21** (REG, AAB, BLU, escompte, éco-part., assujetti unique) | A.1#20/#24, A.2#7/#8 | `Note` L.536-539                            | Introduire des codes mention normalisés au lieu de la note libre.                                                                                                 |
| P2   | **Date d'acompte (BT-83)**                                                            | A.1#23               | L.574                                       | Porter la date / la référence de la facture d'acompte rattachée.                                                                                                  |
| P3   | **Attributs article (BT-160/161)**                                                    | Table B              | `invoiceLines` L.285-313                    | `cac:AdditionalItemProperty` si besoin métier.                                                                                                                    |

### 5.2 — ⚠️ Partiels / à risque

| Prio | Gap                                                             | Réf.         | Emplacement                        | Action corrective proposée                                                                                                |
| ---- | --------------------------------------------------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P0   | **Pays vendeur/acheteur (BT-40/BT-55) conditionnels**           | A.1#3/#6     | L.315-338 / L.414-437              | Émettre **toujours** `cac:Country/cbc:IdentificationCode` même si rue/ville vides (sinon BR-09/BR-11).                    |
| P1   | **CustomizationID (BT-24)** générique Peppol, pas CIUS-FR       | Table B      | L.523                              | Aligner sur l'identifiant de spécification cible DGFiP/CIUS-FR.                                                           |
| P1   | **EndpointID (BT-34/BT-49) conditionnel**                       | Table B      | L.394-400 / L.405-411              | Garantir un EndpointID (requis Peppol) ou rejeter en amont si absent.                                                     |
| P1   | **Option TVA débits (BT-8)** via champ non standard             | A.1#11       | `cisuFrBlocks` L.494-513           | Porter l'exigibilité via `TaxPointDate`/code normé plutôt qu'`AdditionalDocumentReference`.                               |
| P2   | **Moyen de paiement (BT-81) conditionnel à l'IBAN**             | Table B      | L.370-391                          | Émettre `PaymentMeansCode` même sans IBAN si requis par le profil.                                                        |
| P2   | **Sentinelles** `FRAIS-GESTION-CLASSE6` / `REF-…` / `NA`        | Vigilance #5 | L.534 / L.517-518 / L.472-473      | Supprimer les valeurs fabriquées injectées dans des BT obligatoires (n'émettre l'élément que si une vraie valeur existe). |
| P3   | **Catégorie `G` non sélectionnable**, défaut 0 %→`Z` discutable | Vigilance #3 | enum L.144, `taxCatCode` L.221-224 | Ajouter `G` ; revoir le défaut de catégorie pour les lignes 0 %.                                                          |

---

## 6. Verdict sur le cas OpenAI (AE + USD) — confronté au PDF réel

**Données réelles de `Invoice-3F868EA1-0015.pdf`** :

- **Vendeur** : OpenAI OpCo, LLC — 1455 3rd Street, San Francisco, California 94158, **United States** ; **« EU OSS VAT EU372041333 »** ; pas de SIREN/SIRET (entité US).
- **Acheteur (Bill to)** : IT SPIRIT — 451 rue du Champ du Garet, 69400 ARNAS, France ; **FR VAT FR57512520370** ; **pas de SIRET** sur le document.
- **Ship to** : IT SPIRIT (même adresse) → **adresse de livraison BG-13/BG-15 explicitement présente**.
- 1 ligne : « OpenAI API usage credit », Qté 1, PU 20,00, **Tax 0 %**, 20,00 ; **devise USD** ; mention bas de page **« [1] Tax to be paid on reverse charge basis »** (autoliquidation).
- Date d'émission = date d'échéance = 5 mai 2026 ; pas d'acompte.

**Le générateur, en l'état, ne sait PAS reproduire cette facture conforme**, pour les raisons suivantes (confirmées par le document) :

1. **Autoliquidation (AE)** — confirmé : la facture porte une mention de reverse charge. Or `AE` est accepté (enum L.144) mais **jamais déduit** (défaut `Z`/`S`, L.221-224), **aucun preset ne l'exerce**, et **`VATEX-FR-AE` est absent**. La mention légale **« Autoliquidation » ne serait pas imprimée sur le PDF** (impression du motif limitée à la catégorie `E`, L.897) → le document lisible serait **non conforme**.
2. **Devise USD (BT-6)** — confirmé : facture en USD pour un acheteur français. Seul `DocumentCurrencyCode` (BT-5) est émis, **pas de `TaxCurrencyCode` (BT-6)** ni de `TaxTotal` en EUR → la TVA autoliquidée en EUR n'est pas portée → **non conforme** pour le dépôt FR.
3. **Adresse de livraison « Ship to » (BG-13/BG-15)** — **nouveau** : le PDF réel comporte un bloc _Ship to_ distinct. Le générateur **n'a aucun bloc `cac:Delivery`** → impossible de représenter le _Ship to_ ni la date de livraison (BT-72).
4. **Vendeur étranger / identifiants** — **affiné** : le vendeur n'a **ni SIREN ni SIRET** et porte un **n° de TVA OSS « EU… »** (régime non-union). Le générateur :
   - n'émet pas de `PartyLegalEntity/CompanyID` (faute de SIRET) — tolérable ;
   - mais l'**`EndpointID` retomberait sur `schemeID="9957"` (= FR:VAT)** pour un numéro `EU372041333` → **scheme incorrect** (L.394-400) ;
   - pas de `TaxRepresentativeParty` (BT-62/63) si requis.
5. **Cadre BT-23** : cadre **S** (prestation de services, sous-cas autoliquidation) non porté (ProfileID codé en dur, L.524).
6. **Acheteur sans SIRET** : le PDF n'identifie IT SPIRIT que par sa TVA `FR57512520370`. Le profil CIUS-FR du générateur **présuppose le SIRET acheteur** (scheme 0002, et champ marqué obligatoire côté formulaire) — désalignement avec ce cas réel où seule la TVA est disponible.

**Conclusion** : le scénario **AE + devise ≠ EUR + vendeur étranger + Ship to** cumule **quatre gaps P0** (BT-6, BT-72/Delivery, mention autoliquidation PDF, déduction AE + VATEX-FR-AE) plus un défaut de **scheme EndpointID** pour les TVA non-FR. En l'état, le générateur **ne peut pas produire un équivalent fidèle de `Invoice-3F868EA1-0015`**. Ces correctifs sont prioritaires pour couvrir le chemin reverse-charge intracommunautaire en devise étrangère.

---

_Fin du compte-rendu — audit en lecture seule, aucune modification de code effectuée. Les correctifs feront l'objet d'un prompt ultérieur dérivé de ce CR._
