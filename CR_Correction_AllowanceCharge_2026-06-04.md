# Compte-rendu — Remises & charges (AllowanceCharge, ligne + document)

**Date** : 2026-06-04
**Périmètre** : implémentation des **remises et charges** (`cac:AllowanceCharge`) **aux deux niveaux** — ligne (BG-27/28) et document (BG-20/21) — dans le générateur de factures de test, avec **recalcul complet des totaux EN16931** et **base TVA par catégorie**. Lève le gap A.2#1 #CIBLE de `CR_Audit_Conformite_ATGP_v31_2026-06-03.md` (« Aucun `cac:AllowanceCharge` ni ligne ni document »).
**Référentiel** : EN16931 (BG-20/21/27/28, règles BR-CO-10 à BR-CO-17, BR-31 à BR-43), listes **UNTDID 5189** (remises) et **UNTDID 7161** (charges).

> **Contraintes respectées** : `cbc:ProfileID` (BT-23) et `cbc:CustomizationID` (BT-24) **non modifiés** ; aucune sentinelle ; **aucune migration** (les remises/charges sont des entrées de génération, non persistées) ; codes UNTDID issus des listes officielles, non devinés.

---

## 1. Décision appliquée

Remises/charges **par ligne (BT-136/141) ET au niveau document (BT-92/99)**, avec recalcul EN16931 complet des totaux et de la base TVA **par catégorie**. Le calcul de la TVA passe de « arrondi par ligne puis somme » à **« base par catégorie × taux »** (BR-CO-17), obligatoire dès qu'une remise/charge décale la base.

---

## 2. Modèle de données

Type commun ajouté (API + web, identiques) :

```ts
interface AllowanceChargeInput {
  isCharge: boolean; // false = remise, true = charge
  amount: number; // BT-136/141 (ligne) ou BT-92/99 (document)
  reason?: string; // BT-139/144 ou BT-97/104
  reasonCode?: string; // BT-140/145 (UNTDID 7161 charge) ou BT-98 (UNTDID 5189 remise)
  vatCategory?: string; // BT-95/102 — document uniquement (obligatoire)
  vatRate?: number; // BT-96/103 — document uniquement
}
```

- `GenLine` / `InvoiceGenLine` : `allowanceCharges?: AllowanceChargeInput[]` (0..n ; `vatCategory`/`vatRate` ignorés, hérités de la ligne).
- `InvoiceGenData` : `documentAllowanceCharges?: AllowanceChargeInput[]` (0..n ; `vatCategory` **requis**).

---

## 3. Règles de calcul implémentées (`computeAmounts`)

| Montant                         | Règle                                                             | Implémentation        |
| ------------------------------- | ----------------------------------------------------------------- | --------------------- |
| **BT-131** net de ligne         | `round2(qty×PU) − Σ remises ligne + Σ charges ligne`              | par ligne             |
| **BT-106** LineExtensionAmount  | `Σ BT-131` (BR-CO-10)                                             | `lineExtensionTotal`  |
| **BT-107** AllowanceTotalAmount | `Σ BT-92` (BR-CO-11)                                              | `allowanceTotal`      |
| **BT-108** ChargeTotalAmount    | `Σ BT-99` (BR-CO-12)                                              | `chargeTotal`         |
| **BT-109** TaxExclusiveAmount   | `BT-106 − BT-107 + BT-108` (BR-CO-13)                             | `taxExclusiveAmount`  |
| **BT-116** base TVA / catégorie | `(Σ BT-131 de la cat.) − (remises doc cat.) + (charges doc cat.)` | groupe `cat\|taux`    |
| **BT-117** TVA / catégorie      | `round2(BT-116 × taux)` (BR-CO-17, **par catégorie**)             | `taxCategories[].tax` |
| **BT-110** TaxAmount            | `Σ BT-117`                                                        | `totalTax`            |
| **BT-112** TaxInclusiveAmount   | `BT-109 + BT-110` (BR-CO-15)                                      | `taxInclusiveAmount`  |
| **BT-115** PayableAmount        | `BT-112 − BT-113 (prepaid)` (BR-CO-16)                            | `payableAmount`       |

`ComputedAmounts` conserve des **alias de compatibilité** (`totalExclTax = BT-106`, `totalInclTax = BT-112`) pour ne pas casser le code et les tests existants.

**Validation** (`validateAllowanceCharges`, lève `InvoiceValidationError`) : chaque remise/charge doit avoir **un montant > 0** ET **(un motif OU un code motif)** (BR-CO-05/06, BR-33/BR-42) ; toute remise/charge **document** doit porter **une catégorie TVA** (BR-32/BR-43).

---

## 4. Codes motifs (UNTDID — non devinés)

Sous-ensemble courant proposé dans les listes déroulantes (le `reason` texte reste libre) :

- **Remises (UNTDID 5189)** : `95` (Discount), `100` (Special rebate), `104` (Standard), `64` (Special agreement).
- **Charges (UNTDID 7161)** : `FC` (Freight charge), `PC` (Packing), `SH` (Shipping and handling), `ABK` (Miscellaneous), `TX` (Tax).

Valeurs par défaut UI : remise → `95`, charge → `FC`.

---

## 5. Modifications fichier par fichier

### `apps/api/src/services/invoice-generator.service.ts`

- **Types** : `AllowanceChargeInput` (exporté) ; `allowanceCharges` sur `InvoiceGenLine` ; `documentAllowanceCharges` sur `InvoiceGenData`. `ComputedLine` enrichi (`grossLineAmount`, `lineAllowanceTotal`, `lineChargeTotal`, `amountExclTax` = BT-131). `ComputedTaxCategory` (BT-116/117) ; `ComputedAmounts` étendu (BT-106→115 + alias).
- **`lineTaxCategory()`** : helper de catégorie TVA de ligne, factorisé (réutilisé par `computeAmounts`, le XML et le PDF).
- **`validateAllowanceCharges()`** (exporté) : validation EN16931 ci-dessus.
- **`computeAmounts(lines, documentAllowanceCharges?, prepaidAmount?)`** : réécrit — BT-131 par ligne, base TVA **par catégorie+taux** (remises/charges document incluses), TVA par catégorie, BT-106→115.
- **`generateUblXml`** : appelle `validateAllowanceCharges` ; émet `cac:AllowanceCharge` **de ligne** (après `AccountingCost`, avant `cac:Item`, **sans** `cac:TaxCategory`) et **de document** (après `AccountingCustomerParty`/PaymentMeans, **avant** `cac:TaxTotal`, **avec** `cac:TaxCategory`) ; `TaxSubtotal` (BT-116/117) et `LegalMonetaryTotal` (ajout `AllowanceTotalAmount`/`ChargeTotalAmount` si non nuls, ordre UBL respecté) recalculés. S'applique aux **CreditNote**.
- **`writePdf`** : sous-lignes « Remise : −x / Charge : +x (motif) » sous chaque ligne ; récap TVA basé sur `taxCategories` (remises/charges document incluses) ; bloc totaux « Total HT lignes / Total remises / Total charges / Total HT (BT-109) / TVA / TTC ».
- **`generateAndSave`** : `computeAmounts` reçoit les remises/charges document et l'acompte ; `summary` aligné (HT = BT-109, payable = BT-115).

### `apps/api/src/routes/invoice-generator.ts`

- Schéma Fastify : constante `allowanceChargeSchema` (réutilisée) ; `lines.items.allowanceCharges` et `documentAllowanceCharges` (arrays, `maxItems: 20`).

### `apps/web/src/api/generator.api.ts`

- `AllowanceChargeInput` ; `allowanceCharges?` sur `GenLine` ; `documentAllowanceCharges?` sur `InvoiceGenData`.

### `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- **`computeTotals(form)`** réécrit — miroir client de la logique serveur (base par catégorie, BT-106→112). La valeur émise reste celle du serveur.
- Listes `ALLOWANCE_REASON_CODES` / `CHARGE_REASON_CODES`.
- **Par ligne** : bouton « ±% » ouvrant une sous-ligne (type remise/charge, montant, code motif, motif libre).
- **Section document** « Remises & charges globales » : par entrée — type, montant, **catégorie TVA + taux**, code motif, motif.
- Récap totaux : « Total HT lignes (BT-106) », « Total remises (BT-107) », « Total charges (BT-108) » affichés quand non nuls.

### `tests/unit/invoice-generator.test.ts`

- Parseur de test : `AllowanceCharge` traité en tableau.
- **+18 tests** : calcul (BT-131, BT-106/107/108/109, BT-116/117, BT-110/112/115), TVA par catégorie (cas d'arrondi), émission XML (remise ligne sans TaxCategory, remise/charge document avec TaxCategory et ordre avant `TaxTotal`, `AllowanceTotalAmount`/`ChargeTotalAmount`, `TaxSubtotal`), compatibilité `parseUbl` (`allowanceTotal`/`chargeTotal`), CreditNote, et validation (montant, motif, catégorie TVA document).

---

## 6. Vérification

| Contrôle                              | Résultat                                     |
| ------------------------------------- | -------------------------------------------- |
| `typecheck` apps/api                  | ✅ clean                                     |
| `typecheck` apps/web                  | ✅ clean                                     |
| `eslint` (5 fichiers modifiés)        | ✅ clean                                     |
| `vitest` unitaire `invoice-generator` | ✅ **84/84** (66 préexistants + 18 nouveaux) |
| `vitest` unitaire (suite complète)    | ✅ **246/246**, aucune régression            |

### Cas de test numérique (XML + PDF inspectés en runtime, valeurs obtenues)

Ligne 1 : 10 × 5,00 = 50,00, remise ligne 5,00 → **BT-131 = 45,00** · Ligne 2 : 1 × 100,00 = 100,00 → **BT-131 = 100,00** · Remise document 10,00 (S 20 %, « Remise commerciale ») · Charge document 15,00 (S 20 %, « Frais de transport »).

| Montant                     | Attendu | Obtenu        |
| --------------------------- | ------- | ------------- |
| BT-106 LineExtensionAmount  | 145,00  | **145,00** ✅ |
| BT-107 AllowanceTotalAmount | 10,00   | **10,00** ✅  |
| BT-108 ChargeTotalAmount    | 15,00   | **15,00** ✅  |
| BT-109 TaxExclusiveAmount   | 150,00  | **150,00** ✅ |
| BT-116 base TVA S           | 150,00  | **150,00** ✅ |
| BT-117 / BT-110 TaxAmount   | 30,00   | **30,00** ✅  |
| BT-112 TaxInclusiveAmount   | 180,00  | **180,00** ✅ |
| BT-115 PayableAmount        | 180,00  | **180,00** ✅ |

Confirmé en sortie : `cac:AllowanceCharge` de ligne (sans `cac:TaxCategory`, `LineExtensionAmount` ligne = 45,00) ; deux `cac:AllowanceCharge` document **avec** `cac:TaxCategory` (S 20.00) positionnés **avant** `cac:TaxTotal` ; `AllowanceTotalAmount`/`ChargeTotalAmount` dans `LegalMonetaryTotal` (ordre UBL : LineExtension → TaxExclusive → TaxInclusive → Allowance → Charge → Prepaid → Payable) ; PDF généré (sous-lignes remise/charge + bloc totaux). XML reparsé sans erreur par `parseUbl` (`allowanceTotal=10.00`, `chargeTotal=15.00`).

> Script de vérification (`verify-ac.ts`) et artefacts générés **supprimés** après contrôle (aucun fichier laissé).

---

## 7. Aucune migration

`allowanceCharges` (ligne) et `documentAllowanceCharges` (document) sont des **entrées du générateur** (payload de requête), non persistées → **aucune migration**. Côté parser worker, les champs **`allowanceTotal` (BT-107)** et **`chargeTotal` (BT-108)** sont **déjà extraits** (`ubl.parser.ts`, `cii.parser.ts`) : le XML produit est donc immédiatement réconcilié sans modification de la base.

---

## 8. Limitations assumées

1. **Changement de comportement TVA** : calcul désormais « base par catégorie × taux » (et non plus arrondi par ligne sommé). Sur les jeux de tests existants (montants ronds) aucun écart ; un décalage de 1 centime reste possible sur des cas réels — assertions de test concernées non impactées (vérifiées).
2. **Regroupement TVA par `catégorie+taux`** : deux lignes de même catégorie/taux mais de **motifs d'exonération différents** sont fusionnées en une seule `TaxSubtotal` (premier motif conservé) — comportement « un motif par catégorie », hors périmètre de cette passe.
3. **Codes UNTDID** : sous-ensemble courant proposé dans l'UI ; la liste complète (5189/7161) n'est pas exposée. Le `reasonCode` saisi n'est pas validé contre la liste exhaustive (champ libre borné).
4. **`BaseAmount`/`MultiplierFactorNumeric`** (BT-137/138, BT-142/143, BT-93/94, BT-100/101) non émis : seules les remises/charges **en montant** sont gérées (pas de saisie en pourcentage). À ajouter si des remises proportionnelles sont requises.
5. **Duplication client/serveur** : `computeTotals` (web) reste un miroir indicatif de `computeAmounts` (API) ; la valeur émise dans le XML est toujours celle du serveur. Risque de dérive à surveiller (déjà signalé pour le cadre BT-23).
6. **BR-FR-CO-09** (cadre « déjà payée ») non concernée par cette passe.

---

_Fin du compte-rendu. typecheck/lint verts, 84/84 tests générateur (246/246 global), cas numérique vérifié en XML + PDF. BT-23/BT-24 non modifiés ; aucune sentinelle ; aucune migration ; codes UNTDID issus des listes officielles._
