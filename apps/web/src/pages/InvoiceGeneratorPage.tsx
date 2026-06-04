import { useState, useCallback, Fragment } from 'react';
import {
  Plus,
  Trash2,
  Wand2,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Package,
} from 'lucide-react';
import {
  apiSearchSapSuppliers,
  apiEnrichSupplier,
  apiGenerateInvoice,
  getDownloadUrl,
  type InvoiceGenData,
  type GenLine,
  type GenSupplier,
  type AllowanceChargeInput,
  type InvoiceNote,
  type GeneratedInvoice,
  type SapSupplier,
} from '../api/generator.api';
import { DEMO_COMPANIES, CHART_OF_ACCOUNTS } from '../data/demoSuppliers';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { ApiError } from '../api/client';

// ─── Scénarios prédéfinis — charges classe 6 uniquement ──────────────────────

type PresetSupplier = Omit<GenSupplier, never>;

interface Preset {
  label: string;
  category: string;
  description: string;
  data: Omit<InvoiceGenData, 'invoiceNumber' | 'invoiceDate'>;
}

const S = DEMO_COMPANIES;

// Acheteur de démo partagé par tous les presets — conforme EN16931 + CIUS-FR
const DEMO_BUYER = {
  buyerName: 'DEMO INDUSTRIE SAS',
  buyerLegalForm: 'SAS au capital de 100 000 EUR',
  buyerSiret: '40483304800022',
  buyerVatNumber: 'FR12404833048',
  buyerAddress: '12 rue de Rivoli',
  buyerCity: 'Paris',
  buyerPostalCode: '75001',
  buyerCountry: 'FR',
  optionTVA: 'E' as const,
};

const PRESETS: Preset[] = [
  // 60 — Achats / fournitures consommables
  {
    label: '60 — Fournitures',
    category: 'Achats / fournitures consommables',
    description: 'Fournitures administratives et consommables de bureau (606400)',
    data: {
      dueDate: undefined,
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: S.fournitures[0].name,
        legalForm: S.fournitures[0].legalForm,
        address: S.fournitures[0].address,
        city: S.fournitures[0].city,
        postalCode: S.fournitures[0].postalCode,
        country: 'FR',
        taxId: S.fournitures[0].vatNumber,
        siret: S.fournitures[0].siret,
        iban: S.fournitures[0].iban,
        bic: S.fournitures[0].bic,
        phone: S.fournitures[0].phone,
        email: S.fournitures[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '1',
      lines: [
        {
          description: 'Rames de papier A4 — 5 cartons',
          quantity: 5,
          unitPrice: 42.0,
          taxRate: 20,
          accountingCode: '606400',
          accountingLabel: 'Fournitures administratives',
        },
        {
          description: 'Cartouches imprimante — lot de 12',
          quantity: 2,
          unitPrice: 89.5,
          taxRate: 20,
          accountingCode: '606500',
          accountingLabel: 'Fournitures de bureau',
        },
      ],
    },
  },

  // 61 — Services extérieurs (location + maintenance)
  {
    label: '61 — Services ext.',
    category: 'Services extérieurs',
    description: 'Location locaux + maintenance équipements (613200 / 615600)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: S.maintenance[0].name,
        legalForm: S.maintenance[0].legalForm,
        address: S.maintenance[0].address,
        city: S.maintenance[0].city,
        postalCode: S.maintenance[0].postalCode,
        country: 'FR',
        taxId: S.maintenance[0].vatNumber,
        siret: S.maintenance[0].siret,
        iban: S.maintenance[0].iban,
        bic: S.maintenance[0].bic,
        phone: S.maintenance[0].phone,
        email: S.maintenance[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Location bureaux — mois de mai 2026',
          quantity: 1,
          unitPrice: 2400.0,
          taxRate: 20,
          accountingCode: '613200',
          accountingLabel: 'Locations immobilières',
        },
        {
          description: 'Maintenance équipements HVAC — intervention trimestrielle',
          quantity: 1,
          unitPrice: 680.0,
          taxRate: 20,
          accountingCode: '615600',
          accountingLabel: 'Maintenance matériel informatique',
        },
      ],
    },
  },

  // 62 — Autres services extérieurs (honoraires + infogérance)
  {
    label: '62 — Autres services',
    category: 'Autres services extérieurs',
    description: 'Honoraires conseil + prestation infogérance (622600)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Prestation infogérance serveurs — avril 2026',
          quantity: 1,
          unitPrice: 1800.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
        {
          description: 'Frais de déplacement ingénieur',
          quantity: 3,
          unitPrice: 120.0,
          taxRate: 20,
          accountingCode: '625100',
          accountingLabel: 'Voyages et déplacements',
        },
      ],
    },
  },

  // 63 — Impôts et taxes
  {
    label: '63 — Impôts & taxes',
    category: 'Impôts et taxes',
    description: 'Taxe foncière + taxes diverses non récupérables (635100 / 637000)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: 'Direction des Finances Publiques — Fictif',
        legalForm: 'Administration publique fictive',
        address: "10 Rue de l'Administration",
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
        taxId: 'FR00000000000',
        siret: '00000000000000',
        iban: 'FR76 1000 1000 0000 0000 0000 000',
        bic: 'BDFEFRPPCCT',
        email: 'test@impots-fictif.fr',
        phone: '01 00 00 00 00',
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Taxe foncière — exercice 2026',
          quantity: 1,
          unitPrice: 4200.0,
          taxRate: 0,
          taxCategoryCode: 'O',
          accountingCode: '635100',
          accountingLabel: 'Taxe foncière',
        },
        {
          description: 'Cotisation foncière des entreprises (CFE) — 2026',
          quantity: 1,
          unitPrice: 1850.0,
          taxRate: 0,
          taxCategoryCode: 'O',
          accountingCode: '635000',
          accountingLabel: 'Autres impôts et taxes',
        },
      ],
    },
  },

  // 64 — Charges de personnel (charges sociales patronales URSSAF)
  {
    label: '64 — Charges personnel',
    category: 'Charges de personnel',
    description: 'Charges sociales patronales URSSAF (645000)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: 'URSSAF Île-de-France — Fictif',
        legalForm: 'Organisme de recouvrement fictif',
        address: '93 Rue de Rivoli',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
        taxId: 'FR00000000001',
        siret: '78230000100001',
        iban: 'FR76 1000 1000 0000 0000 0000 001',
        bic: 'BDFEFRPPCCT',
        email: 'cotisations@urssaf-fictif.fr',
        phone: '3957',
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Cotisations patronales — avril 2026',
          quantity: 1,
          unitPrice: 8500.0,
          taxRate: 0,
          taxCategoryCode: 'O',
          accountingCode: '645000',
          accountingLabel: 'Charges de sécurité sociale',
        },
        {
          description: 'Contribution formation professionnelle — avril 2026',
          quantity: 1,
          unitPrice: 340.0,
          taxRate: 0,
          taxCategoryCode: 'O',
          accountingCode: '647000',
          accountingLabel: 'Autres charges sociales',
        },
      ],
    },
  },

  // 65 — Autres charges de gestion courante
  {
    label: '65 — Autres charges',
    category: 'Autres charges de gestion courante',
    description: 'Cotisations professionnelles + redevances (628000 / 651000)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: 'Cabinet Orial Conseil SAS',
        legalForm: 'SAS au capital de 30 000 EUR',
        address: '18 Avenue des Conseils',
        city: 'Paris',
        postalCode: '75016',
        country: 'FR',
        taxId: S.honoraires[0].vatNumber,
        siret: S.honoraires[0].siret,
        iban: S.honoraires[0].iban,
        bic: S.honoraires[0].bic,
        phone: S.honoraires[0].phone,
        email: S.honoraires[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Cotisation annuelle CCI — exercice 2026',
          quantity: 1,
          unitPrice: 950.0,
          taxRate: 20,
          accountingCode: '628000',
          accountingLabel: 'Divers (cotisations)',
        },
        {
          description: 'Redevance licence logiciel de gestion',
          quantity: 1,
          unitPrice: 2400.0,
          taxRate: 20,
          accountingCode: '651000',
          accountingLabel: 'Redevances pour concessions',
        },
      ],
    },
  },

  // 66 — Charges financières
  {
    label: '66 — Charges financières',
    category: 'Charges financières',
    description: 'Frais bancaires + intérêts sur emprunt (627000 / 661200)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: S.assuranceBanque[2].name,
        legalForm: S.assuranceBanque[2].legalForm,
        address: S.assuranceBanque[2].address,
        city: S.assuranceBanque[2].city,
        postalCode: S.assuranceBanque[2].postalCode,
        country: 'FR',
        taxId: S.assuranceBanque[2].vatNumber,
        siret: S.assuranceBanque[2].siret,
        iban: S.assuranceBanque[2].iban,
        bic: S.assuranceBanque[2].bic,
        phone: S.assuranceBanque[2].phone,
        email: S.assuranceBanque[2].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Frais de tenue de compte — 1er trimestre 2026',
          quantity: 1,
          unitPrice: 180.0,
          taxRate: 20,
          accountingCode: '627000',
          accountingLabel: 'Services bancaires',
        },
        {
          description: 'Intérêts sur emprunt professionnel — avril 2026',
          quantity: 1,
          unitPrice: 1240.0,
          taxRate: 0,
          taxCategoryCode: 'E',
          taxExemptionReasonCode: 'VATEX-EU-135',
          taxExemptionReason:
            'Opérations bancaires et financières exonérées — art. 261 C CGI / art. 135 Directive 2006/112/CE',
          accountingCode: '661200',
          accountingLabel: 'Intérêts sur emprunts',
        },
      ],
    },
  },

  // 67 — Charges exceptionnelles
  {
    label: '67 — Charges except.',
    category: 'Charges exceptionnelles',
    description: 'Pénalités contractuelles + charges sur exercices antérieurs (671000 / 672000)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: S.honoraires[2].name,
        legalForm: S.honoraires[2].legalForm,
        address: S.honoraires[2].address,
        city: S.honoraires[2].city,
        postalCode: S.honoraires[2].postalCode,
        country: 'FR',
        taxId: S.honoraires[2].vatNumber,
        siret: S.honoraires[2].siret,
        iban: S.honoraires[2].iban,
        bic: S.honoraires[2].bic,
        phone: S.honoraires[2].phone,
        email: S.honoraires[2].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      lines: [
        {
          description: 'Pénalités de retard — contrat prestation 2025',
          quantity: 1,
          unitPrice: 350.0,
          taxRate: 20,
          accountingCode: '671000',
          accountingLabel: 'Pénalités et amendes',
        },
        {
          description: 'Régularisation exercice 2025 — frais de conseil',
          quantity: 1,
          unitPrice: 1200.0,
          taxRate: 20,
          accountingCode: '672000',
          accountingLabel: 'Charges sur exercices antérieurs',
        },
      ],
    },
  },
];

// ─── Scénarios prédéfinis — avoirs (TypeCode 381) ────────────────────────────

const AVOIR_PRESETS: Preset[] = [
  // A60 — Retour fournitures
  {
    label: 'A60 — Retour fournitures',
    category: 'Avoir — Achats / fournitures',
    description: 'Avoir pour retour de fournitures administratives (606400)',
    data: {
      dueDate: undefined,
      currency: 'EUR',
      direction: 'CREDIT_NOTE',
      supplier: {
        name: S.fournitures[0].name,
        legalForm: S.fournitures[0].legalForm,
        address: S.fournitures[0].address,
        city: S.fournitures[0].city,
        postalCode: S.fournitures[0].postalCode,
        country: 'FR',
        taxId: S.fournitures[0].vatNumber,
        siret: S.fournitures[0].siret,
        iban: S.fournitures[0].iban,
        bic: S.fournitures[0].bic,
        phone: S.fournitures[0].phone,
        email: S.fournitures[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '1',
      note: 'Avoir pour retour marchandise — bon de retour n° BR-2026-042',
      lines: [
        {
          description: 'Retour rames de papier A4 — 5 cartons non conformes',
          quantity: 5,
          unitPrice: 42.0,
          taxRate: 20,
          accountingCode: '606400',
          accountingLabel: 'Fournitures administratives',
        },
        {
          description: 'Retour cartouches imprimante — lot défectueux',
          quantity: 2,
          unitPrice: 89.5,
          taxRate: 20,
          accountingCode: '606500',
          accountingLabel: 'Fournitures de bureau',
        },
      ],
    },
  },

  // A62 — Annulation prestation
  {
    label: 'A62 — Annulation prestation',
    category: 'Avoir — Autres services extérieurs',
    description: 'Avoir pour annulation de prestation de services (622600)',
    data: {
      currency: 'EUR',
      direction: 'CREDIT_NOTE',
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: 'Avoir pour annulation partielle — prestation non réalisée',
      lines: [
        {
          description: 'Annulation prestation infogérance — avril 2026 (non réalisée)',
          quantity: 1,
          unitPrice: 1800.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
      ],
    },
  },

  // A66 — Avoir financier (exonéré TVA)
  {
    label: 'A66 — Avoir financier',
    category: 'Avoir — Charges financières',
    description: 'Avoir sur frais bancaires exonérés de TVA (627000)',
    data: {
      currency: 'EUR',
      direction: 'CREDIT_NOTE',
      supplier: {
        name: S.assuranceBanque[2].name,
        legalForm: S.assuranceBanque[2].legalForm,
        address: S.assuranceBanque[2].address,
        city: S.assuranceBanque[2].city,
        postalCode: S.assuranceBanque[2].postalCode,
        country: 'FR',
        taxId: S.assuranceBanque[2].vatNumber,
        siret: S.assuranceBanque[2].siret,
        iban: S.assuranceBanque[2].iban,
        bic: S.assuranceBanque[2].bic,
        phone: S.assuranceBanque[2].phone,
        email: S.assuranceBanque[2].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: 'Avoir pour correction frais bancaires facturés en double',
      lines: [
        {
          description: 'Avoir frais de tenue de compte — erreur de facturation T1 2026',
          quantity: 1,
          unitPrice: 180.0,
          taxRate: 0,
          taxCategoryCode: 'E',
          taxExemptionReasonCode: 'VATEX-EU-135',
          taxExemptionReason:
            'Opérations bancaires et financières exonérées — art. 261 C CGI / art. 135 Directive 2006/112/CE',
          accountingCode: '627000',
          accountingLabel: 'Services bancaires',
        },
      ],
    },
  },

  // A503 — Avoir de facture d'acompte (TypeCode 503)
  {
    label: "A503 — Avoir d'acompte",
    category: "Avoir — Annulation d'un acompte facturé",
    description:
      "Avoir de facture d'acompte (503) annulant un acompte de prestation — réf. à la facture d'acompte",
    data: {
      currency: 'EUR',
      direction: 'ADVANCE_CREDIT_NOTE',
      correctedInvoiceRef: 'ACOMPTE-2026-0099',
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: "Avoir annulant l'acompte 30% — projet infogérance annulé (réf. ACOMPTE-2026-0099)",
      lines: [
        {
          description: "Annulation acompte 30% — Projet infogérance 2026 (avoir d'acompte)",
          quantity: 1,
          unitPrice: 5400.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
      ],
    },
  },
];

// ─── Scénarios prédéfinis — acomptes ─────────────────────────────────────────

const ACOMPTE_PRESETS: Preset[] = [
  // A386 — Facture d'acompte (TypeCode 386)
  {
    label: "A386 — Demande d'acompte",
    category: 'Acompte — Demande de paiement anticipé',
    description: "Facture d'acompte fournisseur TypeCode 386 (APDownPayment SAP)",
    data: {
      currency: 'EUR',
      direction: 'ADVANCE_INVOICE',
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: 'Acompte 30% sur commande de prestation — à régler avant démarrage',
      lines: [
        {
          description: 'Acompte 30% — Projet infogérance 2026 (paiement anticipé)',
          quantity: 1,
          unitPrice: 5400.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
      ],
    },
  },

  // A380-PA — Facture finale avec acompte déduit (BT-113 PrepaidAmount)
  {
    label: 'A380 — Solde avec acompte',
    category: 'Acompte — Facture finale avec déduction',
    description: 'Facture finale (380) déduisant un acompte de 5 400 € déjà versé (BT-113)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      prepaidAmount: 5400.0,
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: 'Solde facture projet infogérance 2026 — acompte 30% déduit',
      lines: [
        {
          description: 'Projet infogérance serveurs 2026 — solde 70%',
          quantity: 1,
          unitPrice: 18000.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
      ],
    },
  },
];

// ─── Scénarios prédéfinis — factures rectificatives (TypeCode 384) ────────────

const RECTIFICATIVE_PRESETS: Preset[] = [
  {
    label: 'A384 — Facture rectificative',
    category: 'Rectificative — Correction facture précédente',
    description:
      "Correction d'une facture de prestation (384) avec référence à la facture originale",
    data: {
      currency: 'EUR',
      direction: 'CORRECTIVE_INVOICE',
      correctedInvoiceRef: 'FACT-2026-0042',
      supplier: {
        name: S.informatique[0].name,
        legalForm: S.informatique[0].legalForm,
        address: S.informatique[0].address,
        city: S.informatique[0].city,
        postalCode: S.informatique[0].postalCode,
        country: 'FR',
        taxId: S.informatique[0].vatNumber,
        siret: S.informatique[0].siret,
        iban: S.informatique[0].iban,
        bic: S.informatique[0].bic,
        phone: S.informatique[0].phone,
        email: S.informatique[0].email,
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      note: 'Correction erreur de montant — remplace la facture FACT-2026-0042',
      lines: [
        {
          description: 'Prestation infogérance avril 2026 — montant corrigé',
          quantity: 1,
          unitPrice: 1950.0,
          taxRate: 20,
          accountingCode: '622600',
          accountingLabel: 'Honoraires',
        },
      ],
    },
  },
];

// ─── Scénarios prédéfinis — autoliquidation (catégorie AE) ───────────────────

const REVERSE_CHARGE_PRESETS: Preset[] = [
  {
    label: 'AE — Prestation intracommunautaire',
    category: 'Autoliquidation — Prestation de services intracommunautaire',
    description:
      'Prestation de services UE en autoliquidation (catégorie AE, 0 %) — motif VATEX-FR-AE / « Autoliquidation » auto-complété',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      // Fournisseur établi dans un autre État membre (reverse charge côté preneur FR)
      supplier: {
        name: 'Cloud Infra GmbH',
        legalForm: 'GmbH',
        address: 'Friedrichstraße 100',
        city: 'Berlin',
        postalCode: '10117',
        country: 'DE',
        taxId: 'DE123456789',
        email: 'billing@cloudinfra.example',
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      deliveryDate: undefined,
      note: 'Autoliquidation par le preneur — art. 283-2 du CGI',
      lines: [
        {
          description: 'Abonnement plateforme cloud — mai 2026 (prestation intra-UE)',
          quantity: 1,
          unitPrice: 1200.0,
          taxRate: 0,
          taxCategoryCode: 'AE',
          // motif laissé vide : auto-complété en VATEX-FR-AE / « Autoliquidation »
          accountingCode: '628000',
          accountingLabel: 'Divers (prestations externes)',
        },
      ],
    },
  },
];

// ─── Presets autofacturation (389) & affacturage (393) ───────────────────────
const MENTIONS_TYPES_PRESETS: Preset[] = [
  {
    label: '389 — Autofacturation',
    category: 'Autofacturation (mandat d’autofacturation)',
    description:
      'Facture émise par le client au nom et pour le compte du fournisseur (type 389). Mention « Autofacturation » auto-ajoutée.',
    data: {
      currency: 'EUR',
      direction: 'SELF_BILLED',
      supplier: {
        name: 'Studio Créa SARL',
        legalForm: 'SARL au capital de 10 000 EUR',
        address: '8 rue des Arts',
        city: 'Lyon',
        postalCode: '69002',
        country: 'FR',
        taxId: 'FR40123456824',
        siret: '12345682400017',
        iban: 'FR7630006000011234567890189',
        bic: 'AGRIFRPP',
        email: 'contact@studiocrea.example',
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      notes: [{ subjectCode: 'REG', text: 'Mandat d’autofacturation signé le 02/01/2026.' }],
      lines: [
        {
          description: 'Prestation de design graphique — campagne mai 2026',
          quantity: 1,
          unitPrice: 2400.0,
          taxRate: 20,
          accountingCode: '623000',
          accountingLabel: 'Publicité, publications, relations publiques',
        },
      ],
    },
  },
  {
    label: '393 — Affacturage',
    category: 'Affacturage (cession au factor)',
    description:
      'Facture cédée à un factor (type 393) — bénéficiaire/factor (PayeeParty) + mention de subrogation auto-ajoutée. IBAN du factor dans le bloc fournisseur.',
    data: {
      currency: 'EUR',
      direction: 'FACTORING',
      supplier: {
        name: 'Transport Express SAS',
        legalForm: 'SAS au capital de 80 000 EUR',
        address: '14 avenue de la Logistique',
        city: 'Marseille',
        postalCode: '13008',
        country: 'FR',
        taxId: 'FR55984763110',
        siret: '98476311000025',
        // IBAN du factor (le règlement est adressé au cessionnaire)
        iban: 'FR7610011000201234567890154',
        bic: 'PSSTFRPP',
        email: 'facturation@transportexpress.example',
      } satisfies PresetSupplier,
      ...DEMO_BUYER,
      typeTransaction: '2',
      payee: {
        name: 'CréditFactor SA',
        identifier: 'CESSION-2026-04417',
        legalId: '38291746500031',
      },
      lines: [
        {
          description: 'Transport routier de marchandises — tournée avril 2026',
          quantity: 1,
          unitPrice: 1850.0,
          taxRate: 20,
          accountingCode: '624100',
          accountingLabel: 'Transports sur achats',
        },
      ],
    },
  },
];

// ─── Valeurs initiales ────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0];
}
function dueDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}
function defaultLine(): GenLine {
  return {
    description: '',
    quantity: 1,
    unitPrice: 0,
    taxRate: 20,
    accountingCode: '',
    accountingLabel: '',
  };
}
function defaultForm(): InvoiceGenData {
  const timestamp = new Date().toISOString().replace(/-/g, '').replace(/:/g, '').replace('T', '');
  return {
    invoiceNumber: `TEST-${timestamp.substring(0, 12)}`,
    invoiceDate: todayStr(),
    dueDate: dueDateStr(),
    currency: 'EUR',
    taxCurrency: 'EUR',
    taxExchangeRate: undefined,
    deliveryDate: undefined,
    direction: 'INVOICE',
    prepaidAmount: 0,
    paymentStatus: 'unpaid',
    correctedInvoiceRef: undefined,
    supplier: {
      name: '',
      legalForm: '',
      address: '',
      city: '',
      postalCode: '',
      country: 'FR',
      taxId: '',
      siret: '',
      iban: '',
      bic: '',
      phone: '',
      email: '',
    },
    buyerName: 'DEMO INDUSTRIE SAS',
    buyerLegalForm: 'SAS au capital de 100 000 EUR',
    buyerSiret: '40483304800022',
    buyerVatNumber: 'FR12404833048',
    buyerAddress: '12 rue de Rivoli',
    buyerCity: 'Paris',
    buyerPostalCode: '75001',
    buyerCountry: 'FR',
    typeTransaction: '2',
    optionTVA: 'E',
    lines: [defaultLine()],
    note: '',
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Codes motifs UNTDID (sous-ensemble courant) — 5189 pour les remises, 7161 pour les charges.
// Listes officielles ; le motif texte (reason) reste libre en complément.
const ALLOWANCE_REASON_CODES: { code: string; label: string }[] = [
  { code: '95', label: '95 — Remise (Discount)' },
  { code: '100', label: '100 — Rabais spécial' },
  { code: '104', label: '104 — Remise standard' },
  { code: '64', label: '64 — Accord particulier' },
];
const CHARGE_REASON_CODES: { code: string; label: string }[] = [
  { code: 'FC', label: 'FC — Frais de transport' },
  { code: 'PC', label: 'PC — Emballage' },
  { code: 'SH', label: 'SH — Manutention / expédition' },
  { code: 'ABK', label: 'ABK — Divers' },
  { code: 'TX', label: 'TX — Taxe' },
];

// Miroir client du calcul serveur (EN16931) — base TVA par catégorie, BT-106→112.
// La valeur émise dans le XML reste celle du serveur ; ceci sert à l'affichage temps réel.
function computeTotals(form: InvoiceGenData) {
  const lineCat = (l: GenLine) => l.taxCategoryCode ?? (l.taxRate === 0 ? 'Z' : 'S');
  // BT-131 — montant net de chaque ligne (remises/charges de ligne incluses).
  const lineNets = form.lines.map((l) => {
    const gross = round2(l.quantity * l.unitPrice);
    let allow = 0,
      charge = 0;
    for (const ac of l.allowanceCharges ?? []) {
      if (ac.isCharge) charge = round2(charge + ac.amount);
      else allow = round2(allow + ac.amount);
    }
    return { net: round2(gross - allow + charge), cat: lineCat(l), rate: l.taxRate };
  });
  const lineExtension = round2(lineNets.reduce((s, l) => round2(s + l.net), 0)); // BT-106
  let allowanceTotal = 0,
    chargeTotal = 0;
  for (const ac of form.documentAllowanceCharges ?? []) {
    if (ac.isCharge) chargeTotal = round2(chargeTotal + ac.amount);
    else allowanceTotal = round2(allowanceTotal + ac.amount);
  }
  const ht = round2(lineExtension - allowanceTotal + chargeTotal); // BT-109
  // Ventilation TVA par catégorie + taux (BT-116/117), remises/charges document incluses.
  const cats = new Map<string, { rate: number; taxable: number }>();
  const key = (c: string, r: number) => `${c}|${r}`;
  for (const l of lineNets) {
    const k = key(l.cat, l.rate);
    const g = cats.get(k) ?? { rate: l.rate, taxable: 0 };
    g.taxable = round2(g.taxable + l.net);
    cats.set(k, g);
  }
  for (const ac of form.documentAllowanceCharges ?? []) {
    const cat = ac.vatCategory ?? (ac.vatRate ? 'S' : 'Z');
    const rate = ac.vatRate ?? 0;
    const k = key(cat, rate);
    const g = cats.get(k) ?? { rate, taxable: 0 };
    g.taxable = round2(g.taxable + (ac.isCharge ? ac.amount : -ac.amount));
    cats.set(k, g);
  }
  const tva = round2(
    Array.from(cats.values()).reduce((s, g) => round2(s + round2((g.taxable * g.rate) / 100)), 0),
  ); // BT-110
  const ttc = round2(ht + tva); // BT-112
  // BT-113/BT-115 — acompte émis + net à payer. BR-FR-CO-09 : cadre chiffre 2 (déjà payée) →
  // PrepaidAmount = TTC, net à payer = 0 (le chiffre du cadre fait foi, indépendant de l'acompte).
  const cadre = computeCadre(form);
  const prepaid = cadre.digit === '2' ? ttc : round2(form.prepaidAmount ?? 0);
  const payable = round2(Math.max(0, ttc - prepaid)); // BT-115
  return { lineExtension, allowanceTotal, chargeTotal, ht, tva, ttc, prepaid, payable };
}

function getAccountLabel(code: string): string {
  return CHART_OF_ACCOUNTS[code] ?? '';
}

// ─── Cadre de facturation BT-23 (miroir client de computeCadre côté API) ─────
// Référence : AFNOR XP Z12-012 / BR-FR-08. Recalculé en temps réel pour l'affichage
// lecture seule ; la valeur émise dans le XML reste celle calculée côté serveur.
type CadreLetter = 'B' | 'S' | 'M';
type CadreDigit = '1' | '2' | '4';

const CADRE_LETTER_LABEL: Record<CadreLetter, string> = {
  B: 'livraison de biens',
  S: 'prestation de services',
  M: 'mixte (biens + services)',
};
const CADRE_DIGIT_LABEL: Record<CadreDigit, string> = {
  '1': 'non payée',
  '2': 'déjà payée',
  '4': 'définitive après acompte',
};

function docTypeCode(direction: InvoiceGenData['direction']): string {
  switch (direction) {
    case 'CREDIT_NOTE':
      return '381';
    case 'ADVANCE_CREDIT_NOTE':
      return '503';
    case 'ADVANCE_INVOICE':
      return '386';
    case 'CORRECTIVE_INVOICE':
      return '384';
    case 'SELF_BILLED':
      return '389';
    case 'FACTORING':
      return '393';
    default:
      return '380';
  }
}

// Libellé du type de document (miroir de directionLabel côté service).
function directionLabel(direction: InvoiceGenData['direction']): string {
  switch (direction) {
    case 'CREDIT_NOTE':
      return 'Avoir (381)';
    case 'ADVANCE_CREDIT_NOTE':
      return "Avoir d'acompte (503)";
    case 'ADVANCE_INVOICE':
      return "Facture d'acompte (386)";
    case 'CORRECTIVE_INVOICE':
      return 'Facture rectificative (384)';
    case 'SELF_BILLED':
      return 'Autofacturation (389)';
    case 'FACTORING':
      return 'Affacturage (393)';
    default:
      return 'Facture (380)';
  }
}

// Codes sujet BT-21 (UNTDID 4451) proposés dans l'UI. Les codes confirmés valides pour le
// profil sont émis dans le XML (préfixe « CODE# ») ; les autres (BLU, INV) sont émis texte seul.
const NOTE_SUBJECT_CODES: { code: string; label: string }[] = [
  { code: '', label: '— Aucun code —' },
  { code: 'REG', label: 'REG — Informations réglementaires / régime particulier' },
  { code: 'AAB', label: 'AAB — Conditions de paiement / escompte' },
  { code: 'ABL', label: 'ABL — Informations légales (subrogation…)' },
  { code: 'AAI', label: 'AAI — Informations générales' },
  { code: 'SUR', label: 'SUR — Remarques du vendeur' },
  { code: 'TXD', label: 'TXD — Déclaration fiscale' },
  { code: 'BLU', label: 'BLU — Éco-participation (texte seul, hors 4451)' },
];

function inferCadreLetter(lines: GenLine[]): CadreLetter {
  let hasBien = false;
  let hasService = false;
  for (const l of lines) {
    if ((l.accountingCode ?? '').trim().startsWith('60')) hasBien = true;
    else hasService = true;
  }
  if (hasBien && hasService) return 'M';
  if (hasBien) return 'B';
  return 'S';
}

function transactionLetter(t?: '1' | '2' | '3'): CadreLetter | null {
  if (t === '1') return 'B';
  if (t === '2') return 'S';
  if (t === '3') return 'M';
  return null;
}

interface CadrePreview {
  code: string;
  label: string;
  letter: CadreLetter;
  digit: CadreDigit;
  inferredLetter: CadreLetter;
  txLetter: CadreLetter | null;
  divergence: boolean;
}

function computeCadre(form: InvoiceGenData): CadrePreview {
  const typeCode = docTypeCode(form.direction);
  const inferred = inferCadreLetter(form.lines);
  const txLetter = transactionLetter(form.typeTransaction);
  const divergence = txLetter !== null && txLetter !== inferred;
  const prepaid = form.prepaidAmount ?? 0;
  const paid = form.paymentStatus === 'paid';
  // 389 (autofacturation) et 393 (affacturage) suivent la même logique que le 380.
  const isCommercial = typeCode === '380' || typeCode === '389' || typeCode === '393';
  const digit: CadreDigit = isCommercial && prepaid > 0 ? '4' : paid ? '2' : '1';
  const letter = inferred;
  const code = `${letter}${digit}`;
  return {
    code,
    label: `${code} — ${CADRE_LETTER_LABEL[letter]}, ${CADRE_DIGIT_LABEL[digit]}`,
    letter,
    digit,
    inferredLetter: inferred,
    txLetter,
    divergence,
  };
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function InvoiceGeneratorPage() {
  const [form, setForm] = useState<InvoiceGenData>(defaultForm());
  const [supplierMode, setSupplierMode] = useState<'manual' | 'sap'>('manual');
  const [sapSearch, setSapSearch] = useState('');
  const [sapResults, setSapResults] = useState<SapSupplier[]>([]);
  const [sapLoading, setSapLoading] = useState(false);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GeneratedInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [xmlOpen, setXmlOpen] = useState(false);

  const totals = computeTotals(form);
  const cadre = computeCadre(form);

  // ── Preset ────────────────────────────────────────────────────────────────
  const applyPreset = (preset: Preset) => {
    const p = preset;
    setResult(null);
    setError(null);
    setValidationError(null);
    setEnrichError(null);
    setSupplierMode('manual');
    setForm((prev) => ({
      ...defaultForm(),
      ...p.data,
      invoiceNumber: prev.invoiceNumber,
      invoiceDate: prev.invoiceDate,
      dueDate: prev.dueDate ?? dueDateStr(),
    }));
  };

  // ── Fournisseur SAP ───────────────────────────────────────────────────────
  const searchSap = useCallback(async () => {
    if (!sapSearch.trim()) return;
    setSapLoading(true);
    setSapResults([]);
    try {
      const res = await apiSearchSapSuppliers(sapSearch.trim());
      setSapResults(res.items);
    } catch {
      setSapResults([]);
    } finally {
      setSapLoading(false);
    }
  }, [sapSearch]);

  const selectSapSupplier = (s: SapSupplier) => {
    setForm((prev) => ({
      ...prev,
      supplier: {
        ...prev.supplier,
        name: s.cardname,
        taxId: s.vatregnum ?? s.federaltaxid ?? '',
        siret: s.federaltaxid ?? '',
        country: 'FR',
      },
    }));
    setSapResults([]);
    setSapSearch('');
  };

  // ── Enrichissement INSEE/Pappers ──────────────────────────────────────────
  const enrich = async () => {
    const siren = (form.supplier.siret ?? form.supplier.taxId ?? '')
      .replace(/\s/g, '')
      .replace(/^FR\d{2}/, '')
      .substring(0, 14);
    const digits = siren.replace(/\D/g, '');
    if (digits.length < 9) {
      setEnrichError("Saisissez un SIREN (9 chiffres) ou SIRET (14 chiffres) avant d'enrichir.");
      return;
    }
    setEnrichLoading(true);
    setEnrichError(null);
    try {
      const data = await apiEnrichSupplier(digits.substring(0, 9));
      setForm((prev) => ({
        ...prev,
        supplier: {
          ...prev.supplier,
          name: data.name || prev.supplier.name,
          address: data.address ?? prev.supplier.address,
          city: data.city ?? prev.supplier.city,
          postalCode: data.postalCode ?? prev.supplier.postalCode,
          country: data.country ?? prev.supplier.country,
          taxId: data.taxId ?? prev.supplier.taxId,
          siret: data.siret ?? prev.supplier.siret,
        },
      }));
    } catch (err) {
      setEnrichError(err instanceof ApiError ? err.message : 'Enrichissement impossible.');
    } finally {
      setEnrichLoading(false);
    }
  };

  // ── Lignes ────────────────────────────────────────────────────────────────
  const updateLine = (idx: number, field: keyof GenLine, value: string | number) => {
    setForm((prev) => {
      const lines = [...prev.lines];
      const updated = { ...lines[idx], [field]: value };
      // Auto-remplissage du libellé quand le code change
      if (field === 'accountingCode' && typeof value === 'string') {
        const label = getAccountLabel(value);
        if (label) updated.accountingLabel = label;
      }
      lines[idx] = updated;
      return { ...prev, lines };
    });
  };

  const addLine = () => setForm((prev) => ({ ...prev, lines: [...prev.lines, defaultLine()] }));

  const removeLine = (idx: number) =>
    setForm((prev) => ({ ...prev, lines: prev.lines.filter((_, i) => i !== idx) }));

  // ── Remises / charges de ligne (BG-27/28) ─────────────────────────────────
  const addLineAc = (idx: number) =>
    setForm((prev) => {
      const lines = [...prev.lines];
      const acs: AllowanceChargeInput[] = [
        ...(lines[idx].allowanceCharges ?? []),
        { isCharge: false, amount: 0, reasonCode: ALLOWANCE_REASON_CODES[0].code },
      ];
      lines[idx] = { ...lines[idx], allowanceCharges: acs };
      return { ...prev, lines };
    });
  const updateLineAc = (idx: number, acIdx: number, patch: Partial<AllowanceChargeInput>) =>
    setForm((prev) => {
      const lines = [...prev.lines];
      const acs = [...(lines[idx].allowanceCharges ?? [])];
      acs[acIdx] = { ...acs[acIdx], ...patch };
      lines[idx] = { ...lines[idx], allowanceCharges: acs };
      return { ...prev, lines };
    });
  const removeLineAc = (idx: number, acIdx: number) =>
    setForm((prev) => {
      const lines = [...prev.lines];
      const acs = (lines[idx].allowanceCharges ?? []).filter((_, i) => i !== acIdx);
      lines[idx] = { ...lines[idx], allowanceCharges: acs.length ? acs : undefined };
      return { ...prev, lines };
    });

  // ── Remises / charges document (BG-20/21) ─────────────────────────────────
  const addDocAc = () =>
    setForm((prev) => ({
      ...prev,
      documentAllowanceCharges: [
        ...(prev.documentAllowanceCharges ?? []),
        {
          isCharge: false,
          amount: 0,
          reasonCode: ALLOWANCE_REASON_CODES[0].code,
          vatCategory: 'S',
          vatRate: 20,
        },
      ],
    }));
  const updateDocAc = (acIdx: number, patch: Partial<AllowanceChargeInput>) =>
    setForm((prev) => {
      const acs = [...(prev.documentAllowanceCharges ?? [])];
      acs[acIdx] = { ...acs[acIdx], ...patch };
      return { ...prev, documentAllowanceCharges: acs };
    });
  const removeDocAc = (acIdx: number) =>
    setForm((prev) => ({
      ...prev,
      documentAllowanceCharges: (prev.documentAllowanceCharges ?? []).filter((_, i) => i !== acIdx),
    }));

  // ── Mentions structurées BT-21 (BG-1) ─────────────────────────────────────
  const addNote = (note: InvoiceNote = { text: '' }) =>
    setForm((prev) => ({ ...prev, notes: [...(prev.notes ?? []), note] }));
  const updateNote = (idx: number, patch: Partial<InvoiceNote>) =>
    setForm((prev) => {
      const notes = [...(prev.notes ?? [])];
      notes[idx] = { ...notes[idx], ...patch };
      return { ...prev, notes };
    });
  const removeNote = (idx: number) =>
    setForm((prev) => ({ ...prev, notes: (prev.notes ?? []).filter((_, i) => i !== idx) }));

  // ── Bénéficiaire / factor (BG-10) ─────────────────────────────────────────
  const setPayeeField = (field: keyof NonNullable<InvoiceGenData['payee']>, value: string) =>
    setForm((prev) => {
      const payee = { name: '', ...prev.payee, [field]: value };
      // On retire le bloc payee si tout est vide (sauf en affacturage où name est requis).
      const empty = !payee.name?.trim() && !payee.identifier?.trim() && !payee.legalId?.trim();
      return { ...prev, payee: empty ? undefined : payee };
    });

  // ── Validation client ─────────────────────────────────────────────────────
  const validateForm = (): string | null => {
    if (!form.invoiceNumber.trim()) return 'Le numéro de facture est obligatoire.';
    if (!form.supplier.name.trim()) return 'La raison sociale du fournisseur est obligatoire.';
    if (form.lines.length === 0) return 'Au moins une ligne est obligatoire.';
    for (let i = 0; i < form.lines.length; i++) {
      const line = form.lines[i];
      if (!line.accountingCode || !line.accountingCode.trim()) {
        return `Ligne ${i + 1} ("${line.description || '?'}") : le compte comptable est obligatoire.`;
      }
      if (!line.accountingCode.trim().startsWith('6')) {
        return (
          `Ligne ${i + 1} : le compte "${line.accountingCode}" n'est pas un compte de charges classe 6. ` +
          `Seuls les comptes commençant par 6 sont autorisés (frais de gestion uniquement).`
        );
      }
    }
    return null;
  };

  // ── Génération ────────────────────────────────────────────────────────────
  const generate = async () => {
    const vErr = validateForm();
    if (vErr) {
      setValidationError(vErr);
      return;
    }
    setValidationError(null);
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiGenerateInvoice(form);
      setResult(res);
      setXmlOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur inattendue lors de la génération.');
    } finally {
      setGenerating(false);
    }
  };

  // ── Helpers UI ────────────────────────────────────────────────────────────
  const setSupplierField = (field: keyof typeof form.supplier, value: string) =>
    setForm((prev) => ({ ...prev, supplier: { ...prev.supplier, [field]: value } }));

  const fmtAmt = (n: number) =>
    n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app-page mx-auto max-w-6xl">
      {/* Titre */}
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Bac à sable</p>
          <div className="mt-2 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-secondary/25 bg-secondary/10 text-secondary">
              <FlaskConical className="h-6 w-6" />
            </div>
            <div>
              <h1 className="font-display text-3xl uppercase tracking-[0.1em] text-foreground">
                Générateur de factures
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Génération XML UBL 2.1 + PDF + ZIP compatibles BILLING — scénarios de test
                uniquement.
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-border/80 bg-card-muted/70 px-4 py-3 text-right shadow-soft">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Usage</p>
          <p className="text-sm font-semibold text-foreground">Validation front et flux</p>
          <p className="text-xs text-muted-foreground">Aucune logique métier modifiée</p>
        </div>
      </div>

      {/* Bandeau mode frais de gestion */}
      <div className="flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <Package className="h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <p className="text-sm font-semibold text-amber-700">
            Mode frais de gestion — factures fournisseurs classe 6 uniquement
          </p>
          <p className="text-xs text-amber-600/80">
            Seuls les comptes de charges commençant par 6 sont autorisés. Ventes, immobilisations et
            stocks interdits.
          </p>
        </div>
      </div>

      {/* Scénarios prédéfinis */}
      <Card className="panel-surface-muted">
        <CardHeader>
          <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
            Scénarios prédéfinis
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Factures et avoirs — sociétés fictives crédibles, comptes PCG pré-renseignés.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Factures (380)
            </p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/10 hover:text-primary"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Avoirs (381 / 503)
            </p>
            <div className="flex flex-wrap gap-2">
              {AVOIR_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-amber-500/35 hover:bg-amber-500/10 hover:text-amber-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Acomptes (386 / 380+PA)
            </p>
            <div className="flex flex-wrap gap-2">
              {ACOMPTE_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-emerald-500/35 hover:bg-emerald-500/10 hover:text-emerald-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Rectificatives (384)
            </p>
            <div className="flex flex-wrap gap-2">
              {RECTIFICATIVE_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-violet-500/35 hover:bg-violet-500/10 hover:text-violet-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Autoliquidation (AE)
            </p>
            <div className="flex flex-wrap gap-2">
              {REVERSE_CHARGE_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-sky-500/35 hover:bg-sky-500/10 hover:text-sky-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
              Autofacturation / Affacturage (389 / 393)
            </p>
            <div className="flex flex-wrap gap-2">
              {MENTIONS_TYPES_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* En-tête facture */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
            En-tête facture
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Numéro *">
              <input
                className={inputCls}
                value={form.invoiceNumber}
                onChange={(e) => setForm((p) => ({ ...p, invoiceNumber: e.target.value }))}
              />
            </Field>
            <Field label="Type">
              <select
                className={inputCls}
                value={form.direction}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    direction: e.target.value as InvoiceGenData['direction'],
                  }))
                }
              >
                <option value="INVOICE">Facture (380)</option>
                <option value="SELF_BILLED">Autofacturation (389)</option>
                <option value="FACTORING">Affacturage (393)</option>
              </select>
            </Field>
            <Field label="Devise *">
              <select
                className={inputCls}
                value={form.currency}
                onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </Field>
            <Field label="Date facture *">
              <input
                type="date"
                className={inputCls}
                value={form.invoiceDate}
                onChange={(e) => setForm((p) => ({ ...p, invoiceDate: e.target.value }))}
              />
            </Field>
            <Field label="Date échéance">
              <input
                type="date"
                className={inputCls}
                value={form.dueDate ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value || undefined }))}
              />
            </Field>
            <Field label="Date de livraison (BT-72)">
              <input
                type="date"
                className={inputCls}
                value={form.deliveryDate ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, deliveryDate: e.target.value || undefined }))
                }
              />
            </Field>
            <Field label="Devise compta. TVA (BT-6)">
              <select
                className={inputCls}
                value={form.taxCurrency ?? 'EUR'}
                onChange={(e) => setForm((p) => ({ ...p, taxCurrency: e.target.value }))}
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </Field>
            {(form.taxCurrency ?? 'EUR') !== form.currency && (
              <Field label="Taux de conversion TVA">
                <input
                  type="number"
                  className={inputCls}
                  min={0}
                  step={0.0001}
                  value={form.taxExchangeRate ?? ''}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      taxExchangeRate: parseFloat(e.target.value) || undefined,
                    }))
                  }
                  placeholder={`1 ${form.currency} = ? ${form.taxCurrency ?? 'EUR'}`}
                />
              </Field>
            )}
            {(form.direction === 'INVOICE' ||
              form.direction === 'SELF_BILLED' ||
              form.direction === 'FACTORING') && (
              <Field label="Acompte versé (BT-113)">
                <input
                  type="number"
                  className={inputCls}
                  min={0}
                  step={0.01}
                  value={form.prepaidAmount ?? 0}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, prepaidAmount: parseFloat(e.target.value) || 0 }))
                  }
                  placeholder="0.00"
                />
              </Field>
            )}
            {form.direction === 'CORRECTIVE_INVOICE' && (
              <Field label="Facture corrigée (BT-3)">
                <input
                  className={inputCls}
                  value={form.correctedInvoiceRef ?? ''}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, correctedInvoiceRef: e.target.value || undefined }))
                  }
                  placeholder="Ex : FACT-2026-0042"
                />
              </Field>
            )}
            <Field label="Payée à l'émission">
              <select
                className={inputCls}
                value={form.paymentStatus ?? 'unpaid'}
                onChange={(e) =>
                  setForm((p) => ({ ...p, paymentStatus: e.target.value as 'unpaid' | 'paid' }))
                }
              >
                <option value="unpaid">Non payée (chiffre 1)</option>
                <option value="paid">Déjà payée (chiffre 2)</option>
              </select>
            </Field>
            {form.paymentStatus === 'paid' && (
              <Field label="Date de paiement (BT-9)">
                <input
                  type="date"
                  className={inputCls}
                  value={form.paymentDate ?? ''}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, paymentDate: e.target.value || undefined }))
                  }
                  placeholder={form.invoiceDate}
                />
              </Field>
            )}
          </div>

          {/* Cadre de facturation BT-23 calculé en temps réel (lecture seule) */}
          <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border/80 bg-card-muted/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Cadre de facturation (BT-23)
              </span>
              <span className="rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-sm font-bold text-primary">
                {cadre.code}
              </span>
              <span className="text-sm text-muted-foreground">{cadre.label}</span>
            </div>
            <p className="text-xs text-muted-foreground/70">
              Calculé automatiquement (lettre inférée des comptes de charge, chiffre selon le statut
              de paiement et l'acompte). Porté par <code>cbc:ProfileID</code>.
            </p>
            {cadre.divergence && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                <strong>Divergence de nature :</strong> les lignes sont inférées «&nbsp;
                {cadre.inferredLetter}&nbsp;» mais le type de transaction CIUS-FR saisi vaut «&nbsp;
                {cadre.txLetter}&nbsp;». La valeur émise est «&nbsp;{cadre.code}&nbsp;» (inférée des
                lignes). Réconciliez le type de transaction si nécessaire.
              </div>
            )}
          </div>

          {/* Mentions structurées BT-21 (BG-1) */}
          <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border/80 bg-card-muted/40 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Mentions (BT-21)
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    addNote({
                      subjectCode: 'AAB',
                      text: 'Escompte pour paiement anticipé : néant.',
                    })
                  }
                  className="rounded-lg border border-border/80 bg-background/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary"
                >
                  + Escompte (AAB)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    addNote({
                      text: "Éco-participation incluse (art. L.541-10 du code de l'environnement).",
                    })
                  }
                  className="rounded-lg border border-border/80 bg-background/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary"
                >
                  + Éco-participation (BLU)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    addNote({
                      subjectCode: 'REG',
                      text: 'Régime particulier — membre d’un assujetti unique (art. 242 nonies A).',
                    })
                  }
                  className="rounded-lg border border-border/80 bg-background/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary"
                >
                  + Régime particulier (REG)
                </button>
                <button
                  type="button"
                  onClick={() => addNote()}
                  className="rounded-lg border border-border/80 bg-background/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary"
                >
                  + Note
                </button>
              </div>
            </div>
            {(form.notes ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground/70">
                Aucune mention. Les mentions « Autofacturation » (389) et de subrogation (393) sont
                ajoutées automatiquement à la génération si absentes.
              </p>
            )}
            {(form.notes ?? []).map((n, idx) => (
              <div key={idx} className="flex flex-wrap items-end gap-2">
                <Field label="Code sujet">
                  <select
                    className={`${inputCls} text-xs w-72`}
                    value={n.subjectCode ?? ''}
                    onChange={(e) => updateNote(idx, { subjectCode: e.target.value || undefined })}
                  >
                    {NOTE_SUBJECT_CODES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Texte" className="flex-1 min-w-48">
                  <input
                    className={`${inputCls} text-xs`}
                    value={n.text}
                    onChange={(e) => updateNote(idx, { text: e.target.value })}
                    placeholder="Texte de la mention"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => removeNote(idx)}
                  className="text-muted-foreground hover:text-destructive transition-colors p-2"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground/70">
              BT-21 : seuls les codes UNTDID 4451 confirmés (REG, AAB, ABL, AAI, SUR, TXD) sont émis
              dans <code>cbc:Note</code> (préfixe « CODE# ») ; BLU / autres sont émis en texte seul.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Fournisseur */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
              Fournisseur
            </CardTitle>
            <div className="flex gap-2">
              <button
                onClick={() => setSupplierMode('manual')}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
                  supplierMode === 'manual'
                    ? 'border-primary/25 bg-primary/10 text-primary'
                    : 'border-border/80 bg-background/60 text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary'
                }`}
              >
                Manuel
              </button>
              <button
                onClick={() => setSupplierMode('sap')}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
                  supplierMode === 'sap'
                    ? 'border-primary/25 bg-primary/10 text-primary'
                    : 'border-border/80 bg-background/60 text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary'
                }`}
              >
                SAP existant
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Recherche SAP */}
          {supplierMode === 'sap' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  placeholder="Nom, CardCode ou SIREN..."
                  value={sapSearch}
                  onChange={(e) => setSapSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && searchSap()}
                />
                <Button size="sm" onClick={searchSap} loading={sapLoading}>
                  Rechercher
                </Button>
              </div>
              {sapResults.length > 0 && (
                <div className="overflow-y-auto rounded-2xl border border-border/80 bg-card-muted/60 max-h-48 divide-y divide-border/70">
                  {sapResults.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => selectSapSupplier(s)}
                      className="w-full px-3 py-3 text-left text-sm transition-colors hover:bg-primary/10"
                    >
                      <span className="font-medium">{s.cardname}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{s.cardcode}</span>
                      {s.federaltaxid && (
                        <span className="ml-2 text-xs text-muted-foreground">{s.federaltaxid}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Champs fournisseur */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Raison sociale *" className="col-span-2 md:col-span-2">
              <input
                className={inputCls}
                value={form.supplier.name}
                onChange={(e) => setSupplierField('name', e.target.value)}
              />
            </Field>
            <Field label="Pays">
              <input
                className={inputCls}
                value={form.supplier.country ?? 'FR'}
                onChange={(e) => setSupplierField('country', e.target.value)}
                maxLength={2}
              />
            </Field>
            <Field label="Forme juridique">
              <input
                className={inputCls}
                value={form.supplier.legalForm ?? ''}
                onChange={(e) => setSupplierField('legalForm', e.target.value)}
                placeholder="SAS au capital de 50 000 EUR"
              />
            </Field>
            <Field label="Adresse">
              <input
                className={inputCls}
                value={form.supplier.address ?? ''}
                onChange={(e) => setSupplierField('address', e.target.value)}
              />
            </Field>
            <Field label="Ville">
              <input
                className={inputCls}
                value={form.supplier.city ?? ''}
                onChange={(e) => setSupplierField('city', e.target.value)}
              />
            </Field>
            <Field label="Code postal">
              <input
                className={inputCls}
                value={form.supplier.postalCode ?? ''}
                onChange={(e) => setSupplierField('postalCode', e.target.value)}
              />
            </Field>
            <Field label="N° TVA intracommunautaire">
              <input
                className={inputCls}
                value={form.supplier.taxId ?? ''}
                onChange={(e) => setSupplierField('taxId', e.target.value)}
                placeholder="FR12345678901"
              />
            </Field>
            <Field label="SIRET">
              <input
                className={inputCls}
                value={form.supplier.siret ?? ''}
                onChange={(e) => setSupplierField('siret', e.target.value)}
                placeholder="12345678901234"
              />
            </Field>
            <Field label="Code de routage CTC (EAS 0225)">
              <input
                className={inputCls}
                value={form.supplier.routingCode ?? ''}
                onChange={(e) => setSupplierField('routingCode', e.target.value)}
                placeholder="pour identifiants TVA OSS/étrangers sans EAS national"
              />
              <p className="text-xs text-muted-foreground">
                Requis pour un vendeur étranger/OSS (ex. TVA « EU… ») non mappable sur un EAS de TVA
                national.
              </p>
            </Field>
            <Field label="IBAN">
              <input
                className={inputCls}
                value={form.supplier.iban ?? ''}
                onChange={(e) => setSupplierField('iban', e.target.value)}
                placeholder="FR76 3000 6000 0112 3456 7890 189"
              />
            </Field>
            <Field label="BIC">
              <input
                className={inputCls}
                value={form.supplier.bic ?? ''}
                onChange={(e) => setSupplierField('bic', e.target.value)}
                placeholder="AGRIFRPP"
              />
            </Field>
            <Field label="Téléphone">
              <input
                className={inputCls}
                value={form.supplier.phone ?? ''}
                onChange={(e) => setSupplierField('phone', e.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                className={inputCls}
                value={form.supplier.email ?? ''}
                onChange={(e) => setSupplierField('email', e.target.value)}
                type="email"
              />
            </Field>
          </div>

          {/* Enrichissement INSEE/Pappers */}
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={enrich} loading={enrichLoading}>
              <Wand2 className="h-3.5 w-3.5" />
              Préremplir via INSEE / Pappers
            </Button>
            {enrichError && <span className="text-xs text-destructive">{enrichError}</span>}
          </div>
        </CardContent>
      </Card>

      {/* Acheteur */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
            Acheteur
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Champs requis par EN16931 (adresse, raison sociale) et CIUS-FR (SIRET BT-47).
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Raison sociale *" className="col-span-2 md:col-span-2">
              <input
                className={inputCls}
                value={form.buyerName ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, buyerName: e.target.value }))}
              />
            </Field>
            <Field label="Forme juridique">
              <input
                className={inputCls}
                value={form.buyerLegalForm ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerLegalForm: e.target.value || undefined }))
                }
                placeholder="SAS au capital de…"
              />
            </Field>
            <Field label="SIRET (14 chiffres) *">
              <input
                className={inputCls}
                value={form.buyerSiret ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerSiret: e.target.value || undefined }))
                }
                maxLength={14}
                placeholder="40483304800022"
              />
            </Field>
            <Field label="N° TVA intracommunautaire">
              <input
                className={inputCls}
                value={form.buyerVatNumber ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerVatNumber: e.target.value || undefined }))
                }
                placeholder="FR12345678901"
              />
            </Field>
            <Field label="Pays">
              <input
                className={inputCls}
                value={form.buyerCountry ?? 'FR'}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerCountry: e.target.value || undefined }))
                }
                maxLength={2}
              />
            </Field>
            <Field label="Code de routage CTC (EAS 0225)">
              <input
                className={inputCls}
                value={form.buyerRoutingCode ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerRoutingCode: e.target.value || undefined }))
                }
                placeholder="pour identifiants TVA OSS/étrangers sans EAS national"
              />
              <p className="text-xs text-muted-foreground">
                Requis pour un acheteur étranger/OSS (ex. TVA « EU… ») non mappable sur un EAS de
                TVA national.
              </p>
            </Field>
            <Field label="Adresse *" className="col-span-2 md:col-span-3">
              <input
                className={inputCls}
                value={form.buyerAddress ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerAddress: e.target.value || undefined }))
                }
                placeholder="12 rue de Rivoli"
              />
            </Field>
            <Field label="Code postal *">
              <input
                className={inputCls}
                value={form.buyerPostalCode ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerPostalCode: e.target.value || undefined }))
                }
                maxLength={10}
              />
            </Field>
            <Field label="Ville *" className="col-span-2">
              <input
                className={inputCls}
                value={form.buyerCity ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, buyerCity: e.target.value || undefined }))}
              />
            </Field>
          </div>

          {/* Bénéficiaire / Factor (BG-10 / BT-59-61) — obligatoire pour l'affacturage (393) */}
          <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border/80 bg-card-muted/40 px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Bénéficiaire / Factor (BG-10)
              {form.direction === 'FACTORING' && (
                <span className="ml-2 text-destructive">— obligatoire (affacturage)</span>
              )}
            </span>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label={`Nom (BT-59)${form.direction === 'FACTORING' ? ' *' : ''}`}>
                <input
                  className={inputCls}
                  value={form.payee?.name ?? ''}
                  onChange={(e) => setPayeeField('name', e.target.value)}
                  placeholder="Ex : CréditFactor SA"
                />
              </Field>
              <Field label="Identifiant (BT-60)">
                <input
                  className={inputCls}
                  value={form.payee?.identifier ?? ''}
                  onChange={(e) => setPayeeField('identifier', e.target.value)}
                  placeholder="Réf. cession / identifiant"
                />
              </Field>
              <Field label="SIREN/SIRET (BT-61)">
                <input
                  className={inputCls}
                  value={form.payee?.legalId ?? ''}
                  onChange={(e) => setPayeeField('legalId', e.target.value)}
                  placeholder="Identifiant légal du factor"
                />
              </Field>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              L'IBAN de règlement (BT-84) reste celui du bloc fournisseur ; pour l'affacturage,
              saisissez-y l'IBAN du factor.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Références & conformité */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
            Références & conformité
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            BT-10 / BT-13 / BT-14 (Peppol BIS) et extensions CIUS-FR (réforme B2B 2026).
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Référence acheteur (BT-10)">
              <input
                className={inputCls}
                value={form.buyerReference ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, buyerReference: e.target.value || undefined }))
                }
                placeholder="défaut : numéro de facture"
              />
            </Field>
            <Field label="Référence commande acheteur (BT-13)">
              <input
                className={inputCls}
                value={form.orderReference ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, orderReference: e.target.value || undefined }))
                }
                placeholder="Ex : BC-2026-00042 (référence bon de commande acheteur)"
              />
            </Field>
            <Field label="Référence commande vendeur (BT-14)">
              <input
                className={inputCls}
                value={form.salesOrderId ?? ''}
                onChange={(e) =>
                  setForm((p) => ({ ...p, salesOrderId: e.target.value || undefined }))
                }
                placeholder="Ex : PRO-2026-888 (référence interne vendeur)"
              />
            </Field>
            <Field label="Type transaction (CIUS-FR)">
              <select
                className={inputCls}
                value={form.typeTransaction ?? ''}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    typeTransaction: (e.target.value as '1' | '2' | '3' | '') || undefined,
                  }))
                }
              >
                <option value="">—</option>
                <option value="1">1 — Biens</option>
                <option value="2">2 — Services</option>
                <option value="3">3 — Mixte</option>
              </select>
            </Field>
            <Field label="Option TVA (CIUS-FR)">
              <select
                className={inputCls}
                value={form.optionTVA ?? ''}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    optionTVA: (e.target.value as 'S' | 'E' | '') || undefined,
                  }))
                }
              >
                <option value="">—</option>
                <option value="S">S — Sur les débits</option>
                <option value="E">E — Sur les encaissements</option>
              </select>
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* Lignes de facture */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
              Lignes de facture
            </CardTitle>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" />
              Ajouter une ligne
            </Button>
          </div>
          <p className="text-xs text-amber-600">
            Chaque ligne doit avoir un compte de charge classe 6 (ex : 622600 pour honoraires).
          </p>
        </CardHeader>
        <CardContent>
          <div className="data-table-shell overflow-x-auto">
            <table className="data-table w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className="text-left">Description *</th>
                  <th className="w-24 text-left">Compte 6 *</th>
                  <th className="w-36 text-left">Libellé compte</th>
                  <th className="w-16 text-right">Qté</th>
                  <th className="w-24 text-right">P.U. HT</th>
                  <th className="w-16 text-right">TVA %</th>
                  <th className="w-24 text-right">Montant HT</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, idx) => {
                  const lineHt = round2(line.quantity * line.unitPrice);
                  const codeOk = line.accountingCode.startsWith('6');
                  const codeMiss = !line.accountingCode.trim();
                  const lineAcs = line.allowanceCharges ?? [];
                  return (
                    <Fragment key={idx}>
                      <tr className="transition-colors hover:bg-muted/20">
                        <td className="px-2 py-1.5">
                          <input
                            className={`${inputCls} text-xs`}
                            value={line.description}
                            onChange={(e) => updateLine(idx, 'description', e.target.value)}
                            placeholder="Description..."
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            className={`${inputCls} text-xs font-mono ${
                              codeMiss
                                ? 'border-amber-400 bg-amber-50/30'
                                : codeOk
                                  ? 'border-success/40'
                                  : 'border-destructive/60 bg-destructive/5'
                            }`}
                            value={line.accountingCode}
                            onChange={(e) => updateLine(idx, 'accountingCode', e.target.value)}
                            placeholder="606400"
                            maxLength={10}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            className={`${inputCls} text-xs text-muted-foreground`}
                            value={line.accountingLabel ?? ''}
                            onChange={(e) => updateLine(idx, 'accountingLabel', e.target.value)}
                            placeholder="auto"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            className={`${inputCls} text-xs text-right`}
                            value={line.quantity}
                            min={0.001}
                            step={0.001}
                            onChange={(e) =>
                              updateLine(idx, 'quantity', parseFloat(e.target.value) || 0)
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            className={`${inputCls} text-xs text-right`}
                            value={line.unitPrice}
                            min={0}
                            step={0.01}
                            onChange={(e) =>
                              updateLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            className={`${inputCls} text-xs`}
                            value={line.taxRate}
                            onChange={(e) => updateLine(idx, 'taxRate', parseFloat(e.target.value))}
                          >
                            <option value={20}>20 %</option>
                            <option value={10}>10 %</option>
                            <option value={5.5}>5,5 %</option>
                            <option value={2.1}>2,1 %</option>
                            <option value={0}>0 %</option>
                          </select>
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs font-medium">
                          {fmtAmt(lineHt)}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => addLineAc(idx)}
                              title="Ajouter une remise / charge à cette ligne"
                              className="text-muted-foreground hover:text-primary transition-colors p-1 text-xs font-semibold"
                            >
                              ±%
                            </button>
                            {form.lines.length > 1 && (
                              <button
                                onClick={() => removeLine(idx)}
                                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {lineAcs.map((ac, acIdx) => {
                        const codes = ac.isCharge ? CHARGE_REASON_CODES : ALLOWANCE_REASON_CODES;
                        return (
                          <tr key={`ac-${acIdx}`} className="bg-muted/10">
                            <td colSpan={8} className="px-2 py-1.5">
                              <div className="flex flex-wrap items-center gap-2 pl-4 text-xs">
                                <span className="text-muted-foreground">
                                  {ac.isCharge ? '⬆' : '⬇'} Ligne {idx + 1}
                                </span>
                                <select
                                  className={`${inputCls} text-xs w-28`}
                                  value={ac.isCharge ? 'charge' : 'allowance'}
                                  onChange={(e) => {
                                    const isCharge = e.target.value === 'charge';
                                    updateLineAc(idx, acIdx, {
                                      isCharge,
                                      reasonCode: (isCharge
                                        ? CHARGE_REASON_CODES
                                        : ALLOWANCE_REASON_CODES)[0].code,
                                    });
                                  }}
                                >
                                  <option value="allowance">Remise</option>
                                  <option value="charge">Charge</option>
                                </select>
                                <input
                                  type="number"
                                  className={`${inputCls} text-xs w-24 text-right`}
                                  value={ac.amount}
                                  min={0}
                                  step={0.01}
                                  onChange={(e) =>
                                    updateLineAc(idx, acIdx, {
                                      amount: parseFloat(e.target.value) || 0,
                                    })
                                  }
                                  placeholder="Montant"
                                />
                                <select
                                  className={`${inputCls} text-xs w-44`}
                                  value={ac.reasonCode ?? ''}
                                  onChange={(e) =>
                                    updateLineAc(idx, acIdx, { reasonCode: e.target.value })
                                  }
                                >
                                  {codes.map((c) => (
                                    <option key={c.code} value={c.code}>
                                      {c.label}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  className={`${inputCls} text-xs flex-1 min-w-32`}
                                  value={ac.reason ?? ''}
                                  onChange={(e) =>
                                    updateLineAc(idx, acIdx, { reason: e.target.value })
                                  }
                                  placeholder="Motif (texte libre, optionnel)"
                                />
                                <button
                                  onClick={() => removeLineAc(idx, acIdx)}
                                  className="text-muted-foreground hover:text-destructive transition-colors p-1"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Totaux */}
          <div className="mt-4 flex justify-end">
            <div className="text-sm space-y-1 min-w-56">
              {(totals.allowanceTotal > 0 || totals.chargeTotal > 0) && (
                <div className="flex justify-between gap-8 text-muted-foreground">
                  <span>Total HT lignes (BT-106)</span>
                  <span className="font-medium text-foreground">
                    {fmtAmt(totals.lineExtension)} {form.currency}
                  </span>
                </div>
              )}
              {totals.allowanceTotal > 0 && (
                <div className="flex justify-between gap-8 text-muted-foreground">
                  <span>Total remises (BT-107)</span>
                  <span className="font-medium text-foreground">
                    -{fmtAmt(totals.allowanceTotal)} {form.currency}
                  </span>
                </div>
              )}
              {totals.chargeTotal > 0 && (
                <div className="flex justify-between gap-8 text-muted-foreground">
                  <span>Total charges (BT-108)</span>
                  <span className="font-medium text-foreground">
                    +{fmtAmt(totals.chargeTotal)} {form.currency}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-8 text-muted-foreground">
                <span>Total HT</span>
                <span className="font-medium text-foreground">
                  {fmtAmt(totals.ht)} {form.currency}
                </span>
              </div>
              <div className="flex justify-between gap-8 text-muted-foreground">
                <span>TVA totale</span>
                <span className="font-medium text-foreground">
                  {fmtAmt(totals.tva)} {form.currency}
                </span>
              </div>
              <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
                <span>Total TTC</span>
                <span>
                  {fmtAmt(totals.ttc)} {form.currency}
                </span>
              </div>
              {cadre.digit === '2' && (
                <>
                  <div className="flex justify-between gap-8 text-muted-foreground">
                    <span>Payé (BT-113)</span>
                    <span className="font-medium text-foreground">
                      -{fmtAmt(totals.prepaid)} {form.currency}
                    </span>
                  </div>
                  <div className="flex justify-between gap-8 border-t pt-1 font-semibold text-emerald-600">
                    <span>Net à payer (BT-115)</span>
                    <span>
                      {fmtAmt(totals.payable)} {form.currency}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Remises & charges globales (document) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-2xl uppercase tracking-[0.08em]">
              Remises &amp; charges globales
            </CardTitle>
            <Button variant="outline" size="sm" onClick={addDocAc}>
              <Plus className="h-3.5 w-3.5" />
              Ajouter
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Niveau document (BG-20/21) — chaque remise/charge porte obligatoirement une catégorie
            TVA + taux car elle modifie la base de cette catégorie.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(form.documentAllowanceCharges ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground/70">Aucune remise ou charge globale.</p>
          )}
          {(form.documentAllowanceCharges ?? []).map((ac, acIdx) => {
            const codes = ac.isCharge ? CHARGE_REASON_CODES : ALLOWANCE_REASON_CODES;
            return (
              <div
                key={acIdx}
                className="flex flex-wrap items-end gap-2 rounded-2xl border border-border/80 bg-card-muted/40 px-3 py-2"
              >
                <Field label="Type">
                  <select
                    className={`${inputCls} text-xs w-28`}
                    value={ac.isCharge ? 'charge' : 'allowance'}
                    onChange={(e) => {
                      const isCharge = e.target.value === 'charge';
                      updateDocAc(acIdx, {
                        isCharge,
                        reasonCode: (isCharge ? CHARGE_REASON_CODES : ALLOWANCE_REASON_CODES)[0]
                          .code,
                      });
                    }}
                  >
                    <option value="allowance">Remise</option>
                    <option value="charge">Charge</option>
                  </select>
                </Field>
                <Field label="Montant">
                  <input
                    type="number"
                    className={`${inputCls} text-xs w-24 text-right`}
                    value={ac.amount}
                    min={0}
                    step={0.01}
                    onChange={(e) =>
                      updateDocAc(acIdx, { amount: parseFloat(e.target.value) || 0 })
                    }
                  />
                </Field>
                <Field label="Cat. TVA *">
                  <select
                    className={`${inputCls} text-xs w-20`}
                    value={ac.vatCategory ?? 'S'}
                    onChange={(e) => updateDocAc(acIdx, { vatCategory: e.target.value })}
                  >
                    <option value="S">S</option>
                    <option value="Z">Z</option>
                    <option value="E">E</option>
                    <option value="AE">AE</option>
                    <option value="K">K</option>
                    <option value="O">O</option>
                    <option value="G">G</option>
                  </select>
                </Field>
                <Field label="Taux %">
                  <select
                    className={`${inputCls} text-xs w-20`}
                    value={ac.vatRate ?? 0}
                    onChange={(e) => updateDocAc(acIdx, { vatRate: parseFloat(e.target.value) })}
                  >
                    <option value={20}>20</option>
                    <option value={10}>10</option>
                    <option value={5.5}>5,5</option>
                    <option value={2.1}>2,1</option>
                    <option value={0}>0</option>
                  </select>
                </Field>
                <Field label="Code motif">
                  <select
                    className={`${inputCls} text-xs w-44`}
                    value={ac.reasonCode ?? ''}
                    onChange={(e) => updateDocAc(acIdx, { reasonCode: e.target.value })}
                  >
                    {codes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Motif (texte)" className="flex-1 min-w-40">
                  <input
                    className={`${inputCls} text-xs`}
                    value={ac.reason ?? ''}
                    onChange={(e) => updateDocAc(acIdx, { reason: e.target.value })}
                    placeholder="Ex : Remise commerciale"
                  />
                </Field>
                <button
                  onClick={() => removeDocAc(acIdx)}
                  className="text-muted-foreground hover:text-destructive transition-colors p-2"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Bouton générer + erreurs */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          size="lg"
          onClick={generate}
          loading={generating}
          disabled={!form.invoiceNumber || !form.supplier.name || form.lines.length === 0}
        >
          <RefreshCw className="h-4 w-4" />
          Générer la facture
        </Button>
        {validationError && <div className="alert-error flex-1">{validationError}</div>}
        {error && <div className="alert-error flex-1">{error}</div>}
      </div>

      {/* Résultat */}
      {result && (
        <Card className="border-success/30 bg-success/10">
          <CardHeader>
            <CardTitle className="font-display text-2xl uppercase tracking-[0.08em] text-success">
              Facture générée avec succès
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Récapitulatif */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <SummaryItem label="Numéro" value={result.summary.invoiceNumber} />
              <SummaryItem
                label="Type"
                value={directionLabel(result.summary.direction as InvoiceGenData['direction'])}
              />
              <SummaryItem label="Cadre (BT-23)" value={result.summary.cadreCode} />
              <SummaryItem label="Fournisseur" value={result.summary.supplierName} />
              <SummaryItem label="Identifiant" value={result.summary.supplierIdentifier} />
              <SummaryItem
                label="Total HT"
                value={`${fmtAmt(result.summary.totalExclTax)} ${result.summary.currency}`}
              />
              <SummaryItem
                label="TVA"
                value={`${fmtAmt(result.summary.totalTax)} ${result.summary.currency}`}
              />
              <SummaryItem
                label="Total TTC"
                value={`${fmtAmt(result.summary.totalInclTax)} ${result.summary.currency}`}
              />
              <SummaryItem label="Lignes" value={String(result.summary.lineCount)} />
            </div>

            {result.summary.cadreWarning && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {result.summary.cadreWarning}
              </div>
            )}

            {!result.summary.peppolRoutable && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Routage Peppol non applicable : aucun EndpointID (BT-34/BT-49) n'a pu être émis pour
                une partie étrangère/OSS sans EAS de TVA national. Renseignez un « Code de routage
                CTC (EAS 0225) » pour la rendre routable, ou transmettez la facture par la voie PPF
                (e-reporting). Le document reste valide EN16931.
              </div>
            )}

            {/* Téléchargements */}
            <div className="flex flex-wrap gap-3">
              <a href={getDownloadUrl(result.xmlFilename)} download={result.xmlFilename}>
                <Button variant="outline" size="sm">
                  <Download className="h-3.5 w-3.5" />
                  Télécharger XML
                </Button>
              </a>
              <a href={getDownloadUrl(result.pdfFilename)} download={result.pdfFilename}>
                <Button variant="outline" size="sm">
                  <Download className="h-3.5 w-3.5" />
                  Télécharger PDF
                </Button>
              </a>
              <a href={getDownloadUrl(result.zipFilename)} download={result.zipFilename}>
                <Button size="sm">
                  <Download className="h-3.5 w-3.5" />
                  Télécharger ZIP (XML + PDF)
                </Button>
              </a>
            </div>

            {/* Prévisualisation XML */}
            <div>
              <button
                onClick={() => setXmlOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
              >
                {xmlOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {xmlOpen ? 'Masquer le XML' : 'Prévisualiser le XML'}
              </button>
              {xmlOpen && (
                <pre className="mt-2 max-h-96 overflow-x-auto rounded-2xl border border-border/70 bg-card-muted/70 p-4 font-mono text-xs whitespace-pre-wrap break-all">
                  {result.xmlContent}
                </pre>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Micro-composants ─────────────────────────────────────────────────────────

const inputCls = 'app-input';

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium truncate">{value}</span>
    </div>
  );
}
