# Captures d'écran — PA-SAP Bridge

Ce document décrit les captures d'écran à produire pour la documentation finale.  
Les captures sont à réaliser sur une instance avec données de démo (seed `scripts/seed-test-invoices.ts`).

---

## Comment générer les captures

```bash
# 1. Démarrer l'application en local avec données de demo
npm run dev -w apps/api &
npm run dev -w apps/web &

# 2. Peupler la base avec des factures de test
npx ts-node scripts/seed-test-invoices.ts

# 3. Ouvrir http://localhost:5173 dans Chrome
# 4. Effectuer les captures avec l'outil intégré :
#    Chrome DevTools > More Tools > Capture screenshot
#    ou : extensions Awesome Screenshot / Full Page Screen Capture
```

Résolution recommandée : **1440 × 900** px, facteur d'échelle 1x.  
Format : PNG, nommage `XX-description-kebab.png`.

---

## Liste des captures

### 01 — Page de connexion

**Fichier :** `01-login.png`  
**URL :** `/`  
**État :** formulaire vide  
**Description :** Écran de connexion avec champs utilisateur / mot de passe / base de données SAP.

---

### 02 — Tableau de bord

**Fichier :** `02-dashboard.png`  
**URL :** `/`  
**État :** connecté, données de demo chargées  
**À montrer :**

- Les 5 cartes de statistiques (Total, À réviser, Prêtes, Intégrées, En erreur)
- Le graphe d'activité 30 jours (BarChart)
- Le widget Canaux PA — statut worker
- Le tableau "Factures récentes"

---

### 03 — Liste des factures — vue complète

**Fichier :** `03-invoice-list.png`  
**URL :** `/invoices`  
**État :** liste chargée, plusieurs statuts différents visibles  
**À montrer :**

- La barre de filtres (recherche + statut + direction + montant)
- Le tableau avec cases à cocher
- Les badges de statut colorés
- Les boutons Importer / Export CSV / aide clavier (?)

---

### 04 — Liste des factures — filtres actifs + sélection masse

**Fichier :** `04-invoice-list-bulk.png`  
**URL :** `/invoices?status=READY`  
**État :** filtre READY actif, 2-3 factures sélectionnées  
**À montrer :**

- La barre d'actions de masse "Valider (N)"
- Les cases cochées dans le tableau

---

### 05 — Détail facture — vue générale

**Fichier :** `05-invoice-detail.png`  
**URL :** `/invoices/:id`  
**État :** facture au statut READY avec fournisseur résolu  
**À montrer :**

- Le header (nom fournisseur, numéro, date, badge READY)
- La carte "Informations document"
- La carte "Montants"
- La carte "Intégration SAP B1" avec sélecteur de mode et bouton "Intégrer"
- La carte "Matching fournisseur" avec la barre de confiance verte

---

### 06 — Détail facture — onglet Lignes

**Fichier :** `06-invoice-lines.png`  
**URL :** `/invoices/:id` (onglet Lignes)  
**État :** facture avec 3-4 lignes, comptes suggérés  
**À montrer :**

- Le tableau de lignes avec colonnes Description / Qté / PU / HT / TVA / TTC / Compte / Centre / TVA B1
- La barre de totaux en pied de tableau
- L'icône d'édition et l'icône marque-page (règle) au survol

---

### 07 — Détail facture — onglet Fichiers avec aperçu PDF

**Fichier :** `07-invoice-files-preview.png`  
**URL :** `/invoices/:id` (onglet Fichiers, aperçu ouvert)  
**État :** bouton Aperçu cliqué sur un fichier PDF  
**À montrer :**

- La liste des fichiers avec boutons Aperçu / Voir
- L'iframe de prévisualisation PDF ouverte sous le fichier

---

### 08 — Détail facture — après intégration SAP

**Fichier :** `08-invoice-posted.png`  
**URL :** `/invoices/:id`  
**État :** facture au statut POSTED  
**À montrer :**

- Badge POSTED
- DocEntry et DocNum SAP affichés
- Le bandeau de succès vert "Intégrée dans SAP B1"
- Le bouton "Retourner statut à la PA"

---

### 09 — Modale rejet de facture

**Fichier :** `09-reject-modal.png`  
**URL :** `/invoices/:id`  
**État :** modale de rejet ouverte  
**À montrer :**

- Le formulaire avec le champ motif rempli
- Le bouton "Confirmer le rejet"

---

### 10 — Modale création fournisseur SAP B1

**Fichier :** `10-create-supplier-modal.png`  
**URL :** `/invoices/:id` (fournisseur non résolu)  
**État :** modale "Créer dans SAP B1" ouverte  
**À montrer :**

- Les champs CardCode, Nom, SIRET/NIF
- Le bouton "Créer et associer"

---

### 11 — Modale règle de mappage

**Fichier :** `11-mapping-rule-modal.png`  
**URL :** `/invoices/:id`  
**État :** modale créer règle ouverte depuis une ligne  
**À montrer :**

- Les champs Portée / Mot-clé / Compte / Centre / TVA
- La ligne de facture en contexte

---

### 12 — Aide clavier (liste factures)

**Fichier :** `12-keyboard-shortcuts-list.png`  
**URL :** `/invoices`  
**État :** modale `?` ouverte  
**À montrer :**

- Le tableau des raccourcis : J/K/Entrée/F/?

---

### 13 — Aide clavier (détail facture)

**Fichier :** `13-keyboard-shortcuts-detail.png`  
**URL :** `/invoices/:id`  
**État :** modale `?` ouverte  
**À montrer :**

- Le tableau des raccourcis : V / R / ?

---

### 14 — Journal d'audit

**Fichier :** `14-audit-log.png`  
**URL :** `/invoices/:id` (onglet Audit)  
**État :** historique chargé avec 5-8 entrées  
**À montrer :**

- Les entrées avec icônes ✓/✗ selon outcome
- Le diff JSON déroulé (section "Voir le détail")

---

### 15 — Page Paramètres

**Fichier :** `15-settings.png`  
**URL :** `/settings`  
**État :** paramètres chargés  
**À montrer :**

- Les sliders / champs de configuration
- Le mappage TVA sous forme de tableau éditable

---

## Captures optionnelles (nice-to-have)

| Fichier                      | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `16-pa-channels.png`         | Liste des canaux PA avec statut actif/inactif   |
| `17-mapping-rules.png`       | Page règles de mappage avec scores de confiance |
| `18-upload-success.png`      | Bandeau succès après import manuel XML          |
| `19-bulk-post-result.png`    | Résultat de l'action de masse "Valider (3)"     |
| `20-worker-status-error.png` | Widget canal PA avec erreur de polling en rouge |
