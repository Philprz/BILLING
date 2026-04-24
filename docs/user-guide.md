# Guide utilisateur — PA-SAP Bridge

## À qui s'adresse ce guide ?

Aux comptables et opérationnels qui utilisent l'interface web au quotidien pour traiter les factures reçues de la Plateforme de Dématérialisation Partenaire (PA).

---

## 1. Connexion

1. Ouvrir le navigateur à l'adresse fournie par votre administrateur (ex. `https://billing.exemple.com`).
2. Saisir votre identifiant et mot de passe SAP Business One.
3. Sélectionner la base de données SAP B1 cible.
4. Cliquer sur **Se connecter**.

La session expire après 60 minutes d'inactivité. Un avertissement s'affiche 2 minutes avant l'expiration — cliquer sur **Prolonger** ou effectuer n'importe quelle action pour renouveler automatiquement.

---

## 2. Tableau de bord

La page d'accueil affiche :

| Indicateur         | Description                                         |
| ------------------ | --------------------------------------------------- |
| **Total factures** | Toutes factures confondues                          |
| **À réviser**      | Factures dont le matching fournisseur est incomplet |
| **Prêtes**         | Factures validées, prêtes pour intégration SAP      |
| **Intégrées SAP**  | Factures postées avec succès dans SAP B1            |
| **En erreur**      | Factures ayant échoué lors de l'intégration         |

Le **graphe d'activité 30 jours** montre la volumétrie quotidienne (reçues vs intégrées).

Le widget **Canaux PA** indique l'état de chaque connexion (SFTP ou API) et l'heure du dernier polling.

Le bouton **Ré-analyser les factures en attente** relance le moteur de matching sur toutes les factures NEW et TO_REVIEW.

---

## 3. Liste des factures

### Filtres disponibles

| Filtre          | Description                                               |
| --------------- | --------------------------------------------------------- |
| Recherche texte | Fournisseur ou numéro de document (insensible à la casse) |
| Statut          | NEW / À réviser / Prêtes / Intégrées / Rejetées / Erreur  |
| Direction       | Factures ou Avoirs                                        |
| Montant TTC     | Plage min–max en euros                                    |

Cliquer sur **Filtrer** pour appliquer les filtres montant. Le bouton **Réinitialiser** efface tous les filtres actifs.

### Raccourcis clavier

| Touche     | Action                           |
| ---------- | -------------------------------- |
| `J`        | Ligne suivante                   |
| `K`        | Ligne précédente                 |
| `Entrée`   | Ouvrir la facture sélectionnée   |
| `/` ou `F` | Mettre le focus sur la recherche |
| `?`        | Afficher l'aide clavier          |

### Export CSV

Le bouton **Export CSV** télécharge toutes les factures correspondant aux filtres actifs (max 5 000 lignes, encodage UTF-8 avec BOM pour Excel).

### Import manuel

Le bouton **Importer** permet d'uploader un fichier XML (UBL 2.1 / Factur-X) ou PDF. La facture est dédupliquée automatiquement par son identifiant PA.

### Actions de masse

1. Cocher les cases des factures au statut **READY** (la case en tête de colonne sélectionne toutes les READY de la page).
2. Cliquer sur **Valider (N)** dans la barre d'actions qui apparaît.
3. Le résultat indique le nombre de succès et d'échecs.

---

## 4. Détail d'une facture

### 4.1 Informations générales

Affiche les données extraites du document PA : fournisseur, numéro, dates, montants, devise, source.

### 4.2 Intégration SAP B1

| Statut         | Signification                                                               |
| -------------- | --------------------------------------------------------------------------- |
| **En attente** | Facture pas encore traitée                                                  |
| **Intégrée**   | DocEntry et DocNum SAP affichés                                             |
| **Erreur**     | Message d'erreur SAP visible ; bouton « Remettre en traitement » disponible |

**Pour intégrer une facture READY :**

1. Choisir le mode : _Facture d'achat (Service)_ ou _Écriture comptable_.
2. Activer optionnellement le **Mode simulation** (sans appel SAP réel).
3. Cliquer sur **Intégrer dans SAP B1**.

Raccourci clavier : `V` (valider) — déclenche l'intégration si la facture est READY avec un fournisseur résolu.

**Retour de statut PA :** après intégration ou rejet, le bouton **Retourner statut à la PA** envoie la confirmation au système source. Cette action est aussi exécutée automatiquement par le worker avec retry.

### 4.3 Matching fournisseur

La barre de confiance indique le score de matching automatique (0–100 %) :

- ≥ 80 % → vert (confiance élevée)
- 50–79 % → orange
- < 50 % → rouge

**Corriger le fournisseur :**

1. Cliquer sur **Associer un fournisseur** ou **Changer de fournisseur**.
2. Sélectionner le CardCode dans la liste.
3. Valider.

**Créer un fournisseur dans SAP B1 :**
Si le fournisseur n'existe pas encore dans SAP B1, cliquer sur **Créer dans SAP B1**, renseigner le CardCode (ex. `F00042`), la raison sociale et optionnellement le SIRET/NIF, puis valider. Le fournisseur est créé dans SAP et immédiatement associé à la facture.

### 4.4 Rejeter une facture

Cliquer sur **Rejeter** (ou `R` au clavier), saisir le motif obligatoire, puis confirmer. Le motif est enregistré dans l'audit log.

### 4.5 Onglet Lignes

Chaque ligne affiche : description, quantité, prix unitaire, montant HT, TVA, TTC, et les codes de compte / centre de coût / TVA suggérés ou choisis.

**Modifier une ligne :** cliquer sur l'icône crayon, saisir les valeurs, valider avec ✓.

**Créer une règle de mappage :** cliquer sur l'icône marque-page. La règle sera appliquée automatiquement aux prochaines factures similaires.

### 4.6 Onglet Fichiers

Liste les fichiers attachés (PDF, XML, pièces jointes). Le bouton **Aperçu** ouvre une prévisualisation inline directement dans la page. Le bouton **Voir** ouvre le fichier dans un nouvel onglet.

### 4.7 Onglet Audit

Historique chronologique de toutes les actions effectuées sur la facture : ingestion, matching, modifications, intégration SAP, retour statut PA.

---

## 5. Règles de mappage

Accessible depuis **Paramètres > Règles de mappage**.

Les règles permettent au moteur d'apprentissage de suggérer automatiquement les codes comptables. Elles s'appliquent selon l'ordre de priorité :

1. Règle fournisseur + mot-clé + taux TVA (score le plus élevé)
2. Règle globale + mot-clé
3. Règle globale sans critère

Le score de confiance augmente à chaque utilisation acceptée et diminue sur les règles peu utilisées. Les règles avec confiance < 20 % et inutilisées depuis 180 jours sont désactivées automatiquement chaque semaine.

---

## 6. Foire aux questions

**La facture reste en statut NEW depuis longtemps.**  
→ Cliquer sur **Ré-analyser** (page détail) pour relancer le moteur de matching.

**Le fournisseur n'est pas reconnu.**  
→ Vérifier dans SAP B1 que le CardCode est actif. Utiliser **Synchroniser** dans le menu Fournisseurs pour rafraîchir le cache local.

**L'intégration SAP échoue avec une erreur de compte comptable.**  
→ Vérifier dans l'onglet Lignes que tous les codes de compte sont renseignés. Corriger si nécessaire et retenter.

**La pièce jointe n'a pas été uploadée dans SAP.**  
→ Un avertissement orange s'affiche après l'intégration. La facture est tout de même intégrée selon la politique configurée (`warn` par défaut).
