import { useState, useCallback } from 'react';
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
      buyerName: 'DEMO INDUSTRIE SAS',
      lines: [
        {
          description: 'Taxe foncière — exercice 2026',
          quantity: 1,
          unitPrice: 4200.0,
          taxRate: 0,
          accountingCode: '635100',
          accountingLabel: 'Taxe foncière',
        },
        {
          description: 'Cotisation foncière des entreprises (CFE) — 2026',
          quantity: 1,
          unitPrice: 1850.0,
          taxRate: 0,
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
      buyerName: 'DEMO INDUSTRIE SAS',
      lines: [
        {
          description: 'Cotisations patronales — avril 2026',
          quantity: 1,
          unitPrice: 8500.0,
          taxRate: 0,
          accountingCode: '645000',
          accountingLabel: 'Charges de sécurité sociale',
        },
        {
          description: 'Contribution formation professionnelle — avril 2026',
          quantity: 1,
          unitPrice: 340.0,
          taxRate: 0,
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
      buyerName: 'DEMO INDUSTRIE SAS',
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
    direction: 'INVOICE',
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
    lines: [defaultLine()],
    note: '',
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function computeTotals(lines: GenLine[]) {
  let ht = 0,
    tva = 0;
  for (const l of lines) {
    const lineHt = round2(l.quantity * l.unitPrice);
    ht += lineHt;
    tva += round2((lineHt * l.taxRate) / 100);
  }
  return { ht: round2(ht), tva: round2(tva), ttc: round2(ht + tva) };
}

function getAccountLabel(code: string): string {
  return CHART_OF_ACCOUNTS[code] ?? '';
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

  const totals = computeTotals(form.lines);

  // ── Preset ────────────────────────────────────────────────────────────────
  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
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
            Scénarios — charges classe 6
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Huit catégories de charges, sociétés fictives crédibles, comptes PCG pré-renseignés.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p, i) => (
              <button
                key={i}
                onClick={() => applyPreset(i)}
                title={p.description}
                className="rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/10 hover:text-primary"
              >
                {p.label}
              </button>
            ))}
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
                  setForm((p) => ({ ...p, direction: e.target.value as 'INVOICE' | 'CREDIT_NOTE' }))
                }
              >
                <option value="INVOICE">Facture (380)</option>
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
            <Field label="Client (acheteur)">
              <input
                className={inputCls}
                value={form.buyerName ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, buyerName: e.target.value }))}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Note (optionnel)">
              <input
                className={inputCls}
                value={form.note ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              />
            </Field>
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
                  return (
                    <tr key={idx} className="transition-colors hover:bg-muted/20">
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
                        {form.lines.length > 1 && (
                          <button
                            onClick={() => removeLine(idx)}
                            className="text-muted-foreground hover:text-destructive transition-colors p-1"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Totaux */}
          <div className="mt-4 flex justify-end">
            <div className="text-sm space-y-1 min-w-48">
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
            </div>
          </div>
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
                value={result.summary.direction === 'CREDIT_NOTE' ? 'Avoir' : 'Facture'}
              />
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
