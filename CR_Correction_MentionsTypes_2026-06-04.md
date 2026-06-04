# Compte-rendu — Types 389/393 (autofacturation, affacturage) & mentions structurées BT-21

**Date** : 2026-06-04
**Périmètre** : ajout des types de document **389 (autofacturation)** et **393 (affacturage)**, de la **partie bénéficiaire/factor** (`cac:PayeeParty`, BG-10 / BT-59-61) et des **mentions structurées BT-21** (BG-1, passage de la note libre unique à un tableau de notes `{subjectCode?, text}`) dans le générateur de factures de test. Lève les gaps **A.1#19 (#DEMARRAGE)**, **Table B** (393 + factor) et **A.1#20 / A.1#24 / A.2#7 / A.2#8** (BT-21) de `CR_Audit_Conformite_ATGP_v31_2026-06-03.md`.
**Référentiel** : EN16931 (BG-1/BG-10, BT-3, BT-21-22, BT-59-61), UNTDID **1001** (type de document), UNTDID **4451** (sujet de note). Convention d'encodage BT-21 : EN16931-UBL (`cbc:Note` = `CODE#texte`).

> **Contraintes respectées** : `cbc:ProfileID` (BT-23) **non modifié** sauf accueil de 389/393 dans `computeCadre` ; `cbc:CustomizationID` (BT-24) **inchangé** ; aucune sentinelle ; **codes UNTDID 4451 non devinés** (émis uniquement si confirmés, sinon texte seul + note ci-dessous) ; **aucune migration** (champs non persistés).

---

## 1. Décisions appliquées

1. **389 (autofacturation)** : nouveau type `direction = 'SELF_BILLED'` → BT-3 **389**, traité comme un **380 commercial** côté cadre (lettre B/S/M inférée des lignes ; chiffre 1/2 selon `paymentStatus`, **4 si `prepaidAmount>0`**). Reste une **facture** (`Invoice`/`InvoiceLine`/`InvoiceTypeCode`). Mention **« Autofacturation »** auto-ajoutée si absente.
2. **393 (affacturage)** : nouveau type `direction = 'FACTORING'` → BT-3 **393**, même logique de cadre que le 380. Reste une **facture**. **`cac:PayeeParty`** (BT-59/60/61) émis et **obligatoire** (validation). Mention de **subrogation** auto-ajoutée (code sujet **ABL**).
3. **Mentions BT-21** : passage de `note: string` (déprécié, conservé en compat ascendante) à **`notes: { subjectCode?, text }[]`** (BG-1, 0..n). Le code sujet n'est émis dans `cbc:Note` (préfixe `CODE#`) **que pour les codes UNTDID 4451 confirmés** ; sinon texte seul.

---

## 2. Codes BT-21 réellement émis (confirmés vs texte-seul)

UNTDID **4451** (« Text subject qualifier »). La convention EN16931→UBL combine BT-21 et BT-22 dans `cbc:Note` sous la forme `CODE#texte` (vérifiée : la liaison UBL EN16931 préfixe le code sujet ; cf. issues CenPC434/validation#41 et docs Peppol — la liaison reste **ambiguë/non normalisée strictement**, d'où le choix prudent ci-dessous).

**Whitelist `CONFIRMED_NOTE_SUBJECT_CODES`** = `AAI, SUR, REG, ABL, TXD, CUS, AAB`. Un `subjectCode` de cette liste est émis `CODE#texte` ; tout autre code (ex. **BLU**, **INV**) est **émis en TEXTE SEUL** (pas de préfixe), conformément au garde-fou « ne pas deviner ».

| Preset / mention                     | Code visé (énoncé) | Émis dans le XML       | Justification                                                                 |
| ------------------------------------ | ------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| Régime particulier / assujetti uniq. | REG                | **`REG#…`** (confirmé) | UNTDID 4451 « Regulatory information »                                        |
| Escompte / conditions de paiement    | AAB                | **`AAB#…`** (confirmé) | UNTDID 4451 « Terms of payment »                                              |
| Subrogation (affacturage, auto)      | ABL                | **`ABL#…`** (confirmé) | UNTDID 4451 « Legal information »                                             |
| Éco-participation                    | BLU                | **texte seul**         | BLU **non présent** dans UNTDID 4451 (relève du segment COM Factur-X) → texte |
| Autofacturation (auto)               | INV                | **texte seul**         | INV **non présent** dans UNTDID 4451 (segment COM Factur-X) → texte           |

> **Note de conformité** : la convention `CODE#texte` est celle de la liaison UBL EN16931, mais reste sujette à interprétation selon le CIUS (Peppol BIS ne lie pas BT-21). Le choix retenu (préfixe pour codes confirmés, texte seul sinon) est **réversible** et n'émet jamais de code 4451 invalide.

---

## 3. Modifications fichier par fichier

### `apps/api/src/services/invoice-generator.service.ts`

- **Types** : `direction` étendue à `'SELF_BILLED' | 'FACTORING'`. `InvoiceGenData` reçoit `payee?: { name; identifier?; legalId? }` (BG-10) et `notes?: InvoiceNote[]` (BG-1) ; `note?: string` conservé (déprécié, converti). Nouveau type exporté `InvoiceNote { subjectCode?; text }`.
- **`documentTypeCode`** : `SELF_BILLED→'389'`, `FACTORING→'393'`.
- **`directionLabel(direction)`** (nouveau, exporté) : libellé humain (PDF + UI), incluant « Autofacturation (389) » / « Affacturage (393) ».
- **`computeCadre`** : chiffre **4** désormais ouvert aux types « commerciaux » `{380, 389, 393}` (set `COMMERCIAL_TYPES`) si `prepaidAmount>0`. Lettre/divergence inchangées.
- **`CONFIRMED_NOTE_SUBJECT_CODES`** + **`isConfirmedNoteSubjectCode()`** (exporté) : whitelist UNTDID 4451.
- **`resolveNotes(data)`** (exporté) : résout la liste finale de notes — `notes` prioritaire, sinon conversion ascendante de `note` (string) en 1 entrée ; auto-ajout « Autofacturation » (389) et subrogation `ABL` (393) si non déjà saisies (détection par regex, comme l'autoliquidation P0).
- **`validatePayee(data)`** (exporté) : lève `InvoiceValidationError` si `direction=FACTORING` sans `payee.name`.
- **`generateUblXml`** : appelle `validatePayee` ; émet `notesBlock` (juste après `InvoiceTypeCode`, **position UBL correcte**, avant `DocumentCurrencyCode` — corrige au passage l'ancienne position après `BuyerReference`) ; émet `cac:PayeeParty` (PartyIdentification → PartyName → PartyLegalEntity) **après `AccountingCustomerParty`, avant `Delivery`/`PaymentMeans`** ; commentaire documentant que l'IBAN (BT-84) reste celui de `PaymentMeans`.
- **`writePdf`** : libellé type via `directionLabel` (suppression du ternaire imbriqué) ; bloc **« BÉNÉFICIAIRE / FACTOR : {nom} ({id})»** sous l'acheteur ; mentions BT-21 affichées en boucle (code entre crochets si présent).

### `apps/api/src/routes/invoice-generator.ts`

- Enum `direction` + `SELF_BILLED`, `FACTORING`.
- Schéma `payee` (object, `name` requis) ; `notes` (array `maxItems:20`, items `{subjectCode?, text}` `text` requis) ; `note` conservé (déprécié).

### `apps/web/src/api/generator.api.ts`

- Types `InvoiceNote`, `PayeeInput` ; `direction` étendue ; `payee?`, `notes?` sur `InvoiceGenData` (`note?` déprécié conservé).

### `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- `docTypeCode` + `directionLabel` (miroir) + `NOTE_SUBJECT_CODES` (sélecteur UI). Cadre digit 4 ouvert à 389/393.
- Sélecteur **Type** : options « Autofacturation (389) » / « Affacturage (393) ». Champ **Acompte (BT-113)** affiché aussi pour 389/393.
- Section **« Mentions (BT-21) »** : liste de notes (code sujet + texte + suppression), bouton « + Note », boutons rapides **« + Escompte (AAB) »**, **« + Éco-participation (BLU) »**, **« + Régime particulier (REG) »**. Remplace le champ « Note » unique.
- Section **« Bénéficiaire / Factor (BG-10) »** dans la carte Acheteur (nom BT-59 / identifiant BT-60 / SIREN-SIRET BT-61), libellé « obligatoire » en affacturage.
- Presets **« Autofacturation / Affacturage (389/393) »** (389 : prestation + note REG ; 393 : transport + `payee` factor + IBAN factor). Récap résultat : type via `directionLabel`.

### `tests/unit/invoice-generator.test.ts`

- Parseur de test : `Note` traité en tableau. Imports `directionLabel`, `validatePayee`, `resolveNotes`, `isConfirmedNoteSubjectCode`.
- **+18 tests** : `documentTypeCode` 389/393 ; bloc 389 (Invoice/389, note auto, non-duplication, cadre S1/S2/S4, label) ; bloc 393 (Invoice/393, `PayeeParty` BT-59/60/61, ordre UBL, note subrogation `ABL#`, validation rejette/accepte, pas de PayeeParty en 380) ; bloc notes BT-21 (whitelist, `CODE#`/texte seul BLU, 3 notes émises, conversion `note`→1 note, priorité `notes` sur `note`, parseUbl OK).

---

## 4. Vérification

| Contrôle                           | Résultat                                       |
| ---------------------------------- | ---------------------------------------------- |
| `typecheck` apps/api               | ✅ clean                                       |
| `typecheck` apps/web               | ✅ clean                                       |
| `eslint` (5 fichiers modifiés)     | ✅ clean                                       |
| `prettier --check`                 | ✅ clean                                       |
| `vitest` `invoice-generator`       | ✅ **102/102** (84 préexistants + 18 nouveaux) |
| `vitest` unitaire (suite complète) | ✅ **264/264**, aucune régression              |

### Runtime (XML + PDF inspectés, valeurs obtenues)

**389 (autofacturation)** — `direction=SELF_BILLED` :

- `<cbc:InvoiceTypeCode>389</cbc:InvoiceTypeCode>` dans un document **`Invoice-2`** ✅ (pas de CreditNote)
- Cadre : **S1** (S2 si payée, **S4 si acompte>0**) ✅
- `cbc:Note` = `REG#Mandat autofacturation 2026` (note utilisateur ; la mention auto « Autofacturation » n'est pas dupliquée car le texte saisi la contient déjà) ✅

**393 (affacturage)** — `direction=FACTORING` :

- `<cbc:InvoiceTypeCode>393</cbc:InvoiceTypeCode>` ✅
- `cac:PayeeParty` présent (BT-60 `PartyIdentification/ID`, BT-59 `PartyName/Name=CréditFactor SA`, BT-61 `PartyLegalEntity/CompanyID=38291746500031`), **positionné après `AccountingCustomerParty` et avant `TaxTotal`** ✅
- `cbc:Note` = `ABL#Facture cédée — règlement à effectuer au bénéficiaire/factor indiqué (subrogation).` ✅
- Validation : 393 **sans** `payee.name` → `InvoiceValidationError` levée ✅
- PDF généré (3106 octets), `summary` : type `FACTORING`, cadre `S1`, net à payer `2220.00` (1850 × 1,20) ✅

> Scripts de vérification (`verify-mt.ts`, `verify-pdf.ts`) et dossier d'artefacts (`.verify-tmp/`) **supprimés** après contrôle (aucun fichier laissé ; `git status` propre).

---

## 5. Aucune migration

`payee`, `notes` (et `note` déprécié), ainsi que les directions 389/393, sont des **entrées du générateur** (payload de requête), non persistées → **aucune migration**.

> ⚠️ **Signalement (hors périmètre, non appliqué)** : le parseur worker `ubl.parser.ts` classe `InvoiceTypeCode` **389** comme `CREDIT_NOTE` (`typeCode === '389' → CREDIT_NOTE`), ce qui est **incorrect** au sens UNTDID 1001 (389 = facture d'autofacturation). Le XML produit ici reste **parseable sans erreur** (test `parseUbl` vert), mais la `direction` déduite côté worker serait erronée pour un 389. Correction du worker **non effectuée** (hors des 4 fichiers du périmètre) — à traiter dans une passe dédiée.

---

## 6. Limitations assumées

1. **Convention BT-21** : `CODE#texte` pour les codes confirmés, texte seul sinon. La liaison UBL EN16931 de BT-21 n'est pas strictement normalisée selon les CIUS (Peppol ne lie pas BT-21) ; le choix retenu est prudent et réversible (jamais de code 4451 invalide émis).
2. **Codes texte-seul** : **BLU** (éco-participation) et **INV** (autofacturation) ne sont pas des codes UNTDID 4451 → émis sans `subjectCode`. Si le profil ATGP cible confirme un code 4451 dédié, l'ajouter à `CONFIRMED_NOTE_SUBJECT_CODES`.
3. **Worker 389** : voir §5 (mapping `389→CreditNote` dans `ubl.parser.ts`, non corrigé).
4. **Auto-mention par regex** : la non-duplication des mentions (Autofacturation / subrogation) repose sur une détection texte (`/autofacturation/i`, `/subrogation|cédée|factor/i`) ; une note utilisateur évoquant ces termes inhibe l'auto-ajout (comportement voulu, cf. runtime 389).
5. **Duplication client/serveur** : `directionLabel` / `docTypeCode` / cadre sont dupliqués côté web (miroir indicatif) ; la valeur émise reste celle du serveur (risque de dérive déjà signalé pour BT-23).
6. **`PayeeParty` partiel** : seuls BT-59/60/61 sont émis (pas d'adresse de la partie bénéficiaire — non requise par EN16931 pour BG-10).
7. **BR-FR-CO-09** non concernée par cette passe.

---

_Fin du compte-rendu. typecheck/lint/prettier verts, 102/102 tests générateur (264/264 global), runtime 389/393 vérifié en XML + PDF. BT-23 inchangé (hors accueil 389/393), BT-24 inchangé ; aucune sentinelle ; aucune migration ; codes UNTDID 4451 confirmés (REG/AAB/ABL) ou émis en texte seul (BLU/INV)._
