# Compte-rendu — Cadre de facturation BT-23 (matrice B/S/M × 1/2/4)

**Date** : 2026-06-04
**Périmètre** : implémentation du cadre de facturation **BT-23** (codes `B1/S1/M1 · B2/S2/M2 · B4/S4/M4`) dans le générateur de factures de test. Lève l'interdiction posée par `CR_Correction_P0_HorsCadre_2026-06-04.md` sur le `ProfileID` (jusqu'ici codé en dur sur le process Peppol générique).
**Référentiel** : NOVA-PA « Flux de facturation électronique (BT-3 / BT-23) » + **AFNOR XP Z12-012** (socle Réforme Facture électronique), règle **BR-FR-08**.

> **Contrainte respectée** : `cbc:CustomizationID` (BT-24) **inchangé** (URN EN16931 + Peppol BIS 3.0). Seul `cbc:ProfileID` (BT-23) devient dynamique.

---

## 1. Confirmation du porteur et du format de BT-23 (vérifié, non deviné)

Conformément à la consigne « ne devine pas : vérifie dans la spec externe », le porteur **et** le format de la valeur ont été confirmés contre le texte **authoritatif AFNOR XP Z12-012** (extraction directe du PDF, section 4.4.2 et règle BR-FR-08) :

- **Porteur** : BT-23 est bien porté, en UBL, par **`cbc:ProfileID`** (et BT-24 par `cbc:CustomizationID`). Citation : _« BT-23 : indique le processus sous-jacent et est utilisé en France pour codifier […] le fait que la facture soit une facture de Biens, de Services, ou Mixte. Cette caractéristique est codifiée respectivement par la première lettre du Cadre de facturation B, S, M. La règle BR-FR-08 indique les valeurs possibles. »_
- **Format** : **code court** (ex. `S1`), **pas une URN**. BR-FR-08 énumère les valeurs autorisées : `B1 S1 M1` (non payée) · `B2 S2 M2` (déjà payée) · `B4 S4 M4` (définitive après acompte) — plus `S5/S6` (sous-/co-traitant) et `B7/S7` (e-reporting), **hors périmètre** de cette passe.
- **Conséquence assumée** : `ProfileID` passe du process Peppol générique (`urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`) au **code cadre français**. C'est le sens de BT-23 dans le contexte CTC/PPF français ; `CustomizationID` (BT-24) conserve l'URN EN16931+CIUS-FR.

**Règles connexes découvertes et prises en compte** :

- **BR-FR-CO-08** : un cadre `B4/S4/M4` est **incompatible** avec BT-3 = `386` / `500` / `503`. → confirme la décision « les avoirs (381/503) et l'acompte (386) ne produisent JAMAIS le chiffre 4 ».
- **BR-FR-CO-09** : un cadre `B2/S2/M2` (déjà payée) impose `BT-113 (PrepaidAmount) = BT-112 (TTC)`, `BT-115 (PayableAmount) = 0` et `BT-9 (DueDate) = date de paiement`. **Non enforcée** par le générateur (voir limitation §6.2).

---

## 2. Logique de détermination implémentée

**Lettre (nature) — inférée par ligne depuis `accountingCode` (classe PCG)** :

- compte commençant par `60` (achats : marchandises, matières, fournitures) → **Bien** ;
- `61/62` (services extérieurs) et `63-67` (impôts, personnel, gestion courante, financières, exceptionnelles) → **Service** (défaut frais généraux).
- Agrégation document : tout Biens → **B**, tout Services → **S**, mélange → **M**.

**Contrôle de cohérence** : la lettre inférée des lignes est comparée à la lettre dérivée de `typeTransaction` (`1`→B, `2`→S, `3`→M). En cas de divergence → **alerte non bloquante** (affichée au formulaire et renvoyée dans la réponse API). **Valeur émise = lettre inférée des lignes** (reflète le contenu réel).

**Chiffre (processus)** :

| BT-3            | Condition                          | Chiffre |
| --------------- | ---------------------------------- | ------- |
| 380             | `prepaidAmount > 0`                | **4**   |
| 380             | sinon, `paymentStatus = paid`      | **2**   |
| 380             | sinon                              | **1**   |
| 386             | `paid` → 2, sinon 1 — **jamais 4** | 1/2     |
| 381 / 503 / 384 | `paid` → 2, sinon 1 — **jamais 4** | 1/2     |

Code final BT-23 = `lettre + chiffre`.

---

## 3. Modifications fichier par fichier

### `apps/api/src/services/invoice-generator.service.ts`

- **`InvoiceGenData`** : `direction` élargie à `'ADVANCE_CREDIT_NOTE'` (BT-3 = **503**) ; ajout de `paymentStatus?: 'unpaid' | 'paid'`.
- **`GeneratedInvoice.summary`** : ajout de `cadreCode`, `cadreLabel`, `cadreWarning?` (alerte divergence).
- **Nouveau bloc cadre BT-23** (exporté) : types `CadreLetter`/`CadreDigit`/`CadreResult`, `documentTypeCode(direction)`, `lineNature()`, `inferDocumentLetter()`, `transactionLetter()`, **`computeCadre(data)`** et `cadreDivergenceWarning(cadre)`.
- **`generateUblXml`** : `isCreditNote` couvre désormais `ADVANCE_CREDIT_NOTE` (document `CreditNote`, `CreditNoteLine`, `CreditNoteTypeCode`) ; `typeCode` délégué à `documentTypeCode()` ; **`cbc:ProfileID` = `computeCadre(data).code`** (remplace l'URN codée en dur). `CustomizationID` **inchangé**.
- **`writePdf`** : ajout de la ligne **« Cadre (BT-23) : {code} — {libellé} »** dans l'en-tête facture ; le libellé « Type » couvre le 503 (« Avoir d'acompte (503) »).
- **`generateAndSave`** : `summary` renseigne `cadreCode/cadreLabel/cadreWarning`.

### `apps/api/src/routes/invoice-generator.ts`

- Schéma Fastify : `direction` enum + `'ADVANCE_CREDIT_NOTE'` ; ajout de `paymentStatus` (`enum: ['unpaid','paid']`).

### `apps/web/src/api/generator.api.ts`

- Type `InvoiceGenData` : `direction` + `'ADVANCE_CREDIT_NOTE'`, ajout `paymentStatus?`.
- Type `GeneratedInvoice.summary` : `cadreCode`, `cadreLabel`, `cadreWarning?`.

### `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- `defaultForm()` : `paymentStatus: 'unpaid'`.
- **Miroir client** de `computeCadre` (helpers `docTypeCode`, `inferCadreLetter`, `transactionLetter`, `computeCadre`) pour l'affichage **temps réel** (la valeur émise reste celle du serveur).
- En-tête facture : toggle **« Payée à l'émission »** (`paymentStatus`) ; **encart lecture seule du cadre BT-23** (code + libellé) recalculé en direct + **bandeau d'alerte** si divergence B/S/M.
- Groupe avoirs renommé **« Avoirs (381 / 503) »** + **preset `A503 — Avoir d'acompte`** (`ADVANCE_CREDIT_NOTE`, réf. facture d'acompte).
- Résultat : `SummaryItem` « Cadre (BT-23) » + affichage du `cadreWarning` éventuel.

### `tests/unit/invoice-generator.test.ts`

- +19 tests : lettre B/S/M (par classe + agrégation M), chiffre 1/2/4, jamais-4 pour 386/381/503, divergence `typeTransaction`, `documentTypeCode`, et émission `ProfileID` dans le XML (S1/M2/B4, 503 → CreditNote, BT-24 inchangé).

---

## 4. Vérification

| Contrôle                              | Résultat                                     |
| ------------------------------------- | -------------------------------------------- |
| `typecheck` apps/api                  | ✅ clean                                     |
| `typecheck` apps/web                  | ✅ clean                                     |
| `eslint` (5 fichiers modifiés)        | ✅ clean                                     |
| `vitest` unitaire `invoice-generator` | ✅ **66/66** (47 préexistants + 19 nouveaux) |
| `vitest` unitaire (suite complète)    | ✅ **228/228**, aucune régression            |

### Table de vérification runtime des cadres (XML + PDF inspectés)

| Cas                          | Lignes                            | Statut                     | Émis `ProfileID`   | Attendu | Alerte               |
| ---------------------------- | --------------------------------- | -------------------------- | ------------------ | ------- | -------------------- |
| 380 services (62)            | `622600`                          | unpaid                     | **S1**             | S1      | —                    |
| 380 mixte (60+62)            | `606400`+`622600`                 | paid + `typeTransaction=2` | **M2**             | M2      | ✅ divergence M vs S |
| 380 définitive après acompte | biens `606400`, `prepaidAmount>0` | —                          | **B4**             | B4      | —                    |
| 386 acompte services         | `622600`                          | unpaid                     | **S1**             | S1      | —                    |
| 381 avoir services           | `622600`                          | unpaid                     | **S1** (jamais S4) | S1      | —                    |
| 503 avoir d'acompte          | `622600`, `prepaidAmount>0`, paid | —                          | **S2** (jamais S4) | S2      | —                    |

PDF confirmé : ligne **« Cadre (BT-23) : M2 — mixte (biens + services), déjà payée »** présente.

> Script de vérification et artefacts générés **supprimés** après contrôle (aucun fichier laissé).

---

## 5. Aucune migration

`paymentStatus` est une **entrée du générateur** (payload de requête), pas une colonne persistée → **aucune migration**. Signalé conformément à la consigne.

---

## 6. Limitations assumées (à recaler avant industrialisation)

1. **Recaler sur BR-FR-08 / XP Z12-012 (dernière version publiée)** : l'implémentation a été validée contre la version AFNOR accessible (socle Réforme), confirmant le porteur `ProfileID` et le format code-court. La **version v1.3 du 26/02/2026** citée dans le cadrage doit être recroisée avant industrialisation (la liste BR-FR-08 inclut aussi `S5/S6/B7/S7`, non implémentés).
2. **BR-FR-CO-09 non enforcée** : un cadre `B2/S2/M2` (`paymentStatus=paid`) impose normalement `PrepaidAmount = TTC`, `PayableAmount = 0`, `DueDate = date de paiement`. Le générateur **n'ajuste pas** ces montants (le toggle pilote uniquement le chiffre 1↔2). À traiter côté ingestion SAP / production, ou à enforcer si des factures « déjà payées » conformes sont requises en sortie de générateur.
3. **Avoir d'une définitive-après-acompte (cadre 4)** : non couvert — les avoirs ne produisent jamais le chiffre 4 (décision verrouillée, cohérent avec BR-FR-CO-08).
4. **384 (rectificative)** : absente du cadrage Confluence et de la liste BR-FR-08 ; traitée ici comme un avoir (lettre inférée + 1/2). **À valider** avec l'expert-comptable (statuer son cadre ou l'ajouter au cadrage).
5. **Service accessoire au bien** (ex. transport lié à une livraison qui doit rester **B**) : l'inférence par classe comptable peut le classer Services → M potentiellement sur-déclaré. Le contrôle de cohérence avec `typeTransaction` sert de garde-fou ; inférence fine hors périmètre.
6. **Bascule 1↔2 via `paymentStatus` saisi**, pas via un rapprochement d'encaissement réel (ORCT) — logique de PRODUCTION côté ingestion SAP, hors générateur de test.
7. **Duplication de logique client/serveur** : `computeCadre` existe en deux exemplaires (service API + miroir page web) pour l'affichage temps réel sans aller-retour réseau. La **valeur émise** dans le XML est toujours celle du serveur ; le miroir client est purement indicatif. Risque de dérive à surveiller si la logique évolue.

---

_Fin du compte-rendu. typecheck/lint verts, 66/66 tests générateur (228/228 global), 6 cadres vérifiés en XML + PDF. `CustomizationID` (BT-24) non modifié ; aucune sentinelle introduite ; format BT-23 confirmé contre AFNOR XP Z12-012, pas deviné._
