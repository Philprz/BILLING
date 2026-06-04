# Compte-rendu — BR-FR-CO-09 : montants d'une facture « déjà payée » (cadre chiffre 2)

**Date** : 2026-06-04
**Périmètre** : aligner les montants émis d'une facture **« déjà payée » (B2/S2/M2)** sur **BR-FR-CO-09** (AFNOR XP Z12-012). Pour un cadre **chiffre 2** : **BT-113** `PrepaidAmount` = **BT-112** TTC, **BT-115** `PayableAmount` = **0**, **BT-9** `DueDate` = **date de paiement**. Avant cette passe, une facture B2/S2/M2 sortait avec un net à payer non nul (limitation #2 du `CR_Correction_CadreBT23_2026-06-04.md` §6.2).
**Référentiel** : EN16931 BT-9 / BT-112 / BT-113 / BT-115 ; cadre BT-23 (`cbc:ProfileID`).

> **Exécution autonome** : aucune question posée. Décisions d'ambiguïté documentées en §4.

---

## 1. Décisions verrouillées appliquées

1. **Déclenchement** = `computeCadre(data).digit === '2'` **uniquement** (letter-agnostique : B2/S2/M2). `computeCadre` **n'est pas touché** : le chiffre se calcule toujours sur le `prepaidAmount` d'entrée (l'acompte), donc l'override **ne rétroagit jamais** sur la détermination du cadre.
2. **BT-9** : nouveau champ **`paymentDate`** (date, optionnel, **non persisté**). Si `digit === '2'` → `DueDate` = `paymentDate` (ou `invoiceDate` si vide). Le champ `dueDate` existant reste l'échéance des cas non payés (inchangé).

---

## 2. Modifications fichier par fichier

### API — `apps/api/src/services/invoice-generator.service.ts`

- **`InvoiceGenData`** : ajout du champ optionnel `paymentDate?: string` (BT-9), documenté comme entrée de génération non persistée.
- **`computeAmounts(...)`** : nouveau 4ᵉ paramètre `forcePrepaidToInclusive = false`. Quand vrai, le **prepaid émis** (BT-113) = `taxInclusiveAmount` (au lieu du champ d'entrée), d'où `payableAmount` (BT-115) = 0. Rétro-compatible (défaut `false` → comportement identique ; les appels existants et tests ne changent pas).
- **`computeAmountsForData(data)`** _(nouveau, exporté)_ : calcule le cadre puis appelle `computeAmounts` avec `forcePrepaidToInclusive = (cadre.digit === '2')`. Centralise l'override pour tous les consommateurs.
- **`effectiveDueDate(data, cadre)`** _(nouveau, exporté)_ : `digit === '2'` → `paymentDate ?? invoiceDate` ; sinon `dueDate`.
- **`generateUblXml`** :
  - `computeCadre(data)` remonté **avant** `computeAmounts` (le chiffre pilote l'override) — supprime le second `computeCadre` qui suivait.
  - `computeAmounts(..., cadre.digit === '2')` ; destructuration de `prepaidAmount: prepaidEmitted`.
  - `cbc:PrepaidAmount` émis = `prepaidEmitted` (était `data.prepaidAmount ?? 0` en dur — ne reflétait pas l'override).
  - `cbc:DueDate` émis = `effectiveDueDate(data, cadre)` (émis si défini ; pour le chiffre 2, toujours défini via fallback `invoiceDate`).
- **`generateAndSave`** : `computeAmounts(...)` → `computeAmountsForData(data)` ⇒ le `summary` (`prepaidAmount`/`payableAmount`) et le PDF reçoivent les montants corrigés.
- **`writePdf`** :
  - variables `isPaidFrame = cadre.digit === '2'` et `paymentDateStr = paymentDate ?? invoiceDate`.
  - En-tête : ligne « **Payée le** {date} » à la place de « Date d'échéance » quand `isPaidFrame`.
  - Bloc totaux : si `isPaidFrame` → « Facture payée le {date} » + « Payé : −{TTC} » + « **Net à payer : 0,00** » ; sinon, l'ancien bloc acompte (chiffre 4) inchangé (déplacé en `else if (prepaidAmount > 0)`). Correction au passage de la double-devise dans le libellé acompte (`fmt()` ajoutait déjà la devise).

### API — `apps/api/src/routes/invoice-generator.ts`

- Schéma Fastify de `POST /generate` : ajout de `paymentDate: { type: 'string', format: 'date' }`.

### Web — `apps/web/src/api/generator.api.ts`

- `InvoiceGenData` : ajout `paymentDate?: string` (BT-9).

### Web — `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- **`computeTotals`** (miroir) : calcule le cadre, expose `prepaid` (= TTC si chiffre 2, sinon `prepaidAmount`) et `payable` (= `max(0, TTC − prepaid)`).
- **Formulaire** : champ **« Date de paiement (BT-9) »** (`paymentDate`) affiché **uniquement** quand `paymentStatus === 'paid'` (placeholder = `invoiceDate`).
- **Récapitulatif** : sous « Total TTC », quand `cadre.digit === '2'`, deux lignes « Payé (BT-113) : −{TTC} » et « **Net à payer (BT-115) : 0,00** » (vert).

> `computeCadre` (front comme back) **non modifié** — la détermination du chiffre est inchangée.

### Tests — `tests/unit/invoice-generator.test.ts`

- +6 tests (`describe('BR-FR-CO-09 …')`) : S2 → Prepaid=TTC/Payable=0/DueDate=paymentDate ; payée sans `paymentDate` → DueDate=invoiceDate ; `computeAmountsForData` (prepaid=TTC, payable=0) ; non payée S1 (prepaid=0, payable=TTC, DueDate=dueDate) ; acompte S4 (prepaid partiel, payable=TTC−acompte, CO-09 **non** appliqué).

---

## 3. Vérification

| Contrôle                           | Résultat                          |
| ---------------------------------- | --------------------------------- |
| `typecheck` api + web              | ✅ clean                          |
| `eslint` (5 fichiers touchés)      | ✅ clean                          |
| `vitest` `invoice-generator`       | ✅ **107/107** (101 + 6 nouveaux) |
| `vitest` unitaire (suite complète) | ✅ **278/278**                    |

### Round-trip runtime (`generateAndSave` → XML + PDF, devise EUR, base HT 100 → TTC 120)

Script temporaire + artefacts **supprimés** (`git status` propre) :

| Cas                              | ProfileID | DueDate (BT-9)               | PrepaidAmount (BT-113) | PayableAmount (BT-115) | summary p/pay | PDF |
| -------------------------------- | --------- | ---------------------------- | ---------------------- | ---------------------- | ------------- | --- |
| Payée + `paymentDate=2026-06-03` | **S2**    | `2026-06-03`                 | `120.00`               | **`0.00`**             | 120 / 0       | ✅  |
| Payée sans `paymentDate`         | **S2**    | `2026-06-01` (= invoiceDate) | `120.00`               | **`0.00`**             | 120 / 0       | ✅  |
| Non payée (chiffre 1)            | **S1**    | `2026-07-01` (= dueDate)     | `0.00`                 | `120.00`               | 0 / 120       | ✅  |
| Acompte 30 (chiffre 4)           | **S4**    | `2026-07-01` (= dueDate)     | `30.00`                | `90.00`                | 30 / 90       | ✅  |

Les trois cas chiffre 1/2/4 demandés sont couverts : CO-09 s'applique **exclusivement** au chiffre 2 ; l'acompte (chiffre 4) conserve son comportement (prepaid partiel, payable = TTC − acompte).

---

## 4. Décisions d'ambiguïté & limites assumées

1. **Override centralisé dans `computeAmounts` via un flag** plutôt qu'en post-traitement externe : garantit la cohérence XML / PDF / summary (un seul point de vérité) et reste piloté **uniquement** par le chiffre du cadre — jamais par le champ d'entrée `prepaidAmount`. Chiffre 2 et chiffre 4 sont mutuellement exclusifs (`computeCadre` renvoie 4 dès que l'acompte d'entrée > 0), mais l'implémentation reste robuste si les deux coïncidaient : le chiffre du cadre fait foi.
2. **`paymentDate` non persisté** : conformément à la contrainte, aucun champ Prisma ni migration (montants dérivés + `paymentDate` = entrée de génération). Confirmé : aucune migration ajoutée.
3. **PDF — libellé acompte** : correction d'une double-mention de la devise (`fmt()` l'ajoutait déjà) dans le bloc acompte existant, par cohérence avec le nouveau bloc « déjà payée ». Aucun impact fonctionnel.
4. **`computeCadre` intact** : la détermination du chiffre (BT-23) et le BT-24 ne sont pas touchés ; BT-23/BT-24/AllowanceCharge/types/mentions hors périmètre, non modifiés.

---

_Fin du compte-rendu. typecheck/eslint verts, 278/278 unitaires, round-trip chiffre 1/2/4 vérifié (ProfileID + BT-9 + BT-113 + BT-115 + summary + PDF), artefacts supprimés. `computeCadre` inchangé ; seul champ ajouté = `paymentDate` (non persisté) ; aucune migration ; pas de sentinelle._
