import { useState, useCallback } from 'react';
import { Plus, Trash2, Wand2, Download, RefreshCw, ChevronDown, ChevronUp, FlaskConical } from 'lucide-react';
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
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { ApiError } from '../api/client';

// ─── Scénarios prédéfinis ─────────────────────────────────────────────────────

const PRESETS: { label: string; description: string; data: Omit<InvoiceGenData, 'invoiceNumber' | 'invoiceDate'> }[] = [
  {
    label: 'Facture simple',
    description: '1 ligne, fournisseur manuel, TVA 20 %',
    data: {
      dueDate: undefined,
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: 'Acme Fournitures SAS',
        address: '12 Rue du Commerce',
        city: 'Paris',
        postalCode: '75015',
        country: 'FR',
        taxId: 'FR12345678901',
      },
      lines: [{ description: 'Fournitures de bureau — pack standard', quantity: 10, unitPrice: 25, taxRate: 20 }],
    },
  },
  {
    label: 'Facture multi-lignes',
    description: '3 lignes, TVA mixte (20 % / 10 % / 0 %)',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: {
        name: 'Tech Solutions SARL',
        address: '8 Avenue de la Technologie',
        city: 'Lyon',
        postalCode: '69003',
        country: 'FR',
        taxId: 'FR98765432100',
      },
      lines: [
        { description: 'Licence logicielle annuelle', quantity: 1, unitPrice: 1200, taxRate: 20 },
        { description: 'Formation utilisateurs (journée)', quantity: 2, unitPrice: 800, taxRate: 20 },
        { description: 'Hébergement serveur (taux réduit)', quantity: 12, unitPrice: 50, taxRate: 10 },
      ],
    },
  },
  {
    label: 'Avoir',
    description: 'CreditNote UBL, 1 ligne, TVA 20 %',
    data: {
      currency: 'EUR',
      direction: 'CREDIT_NOTE',
      supplier: {
        name: 'Acme Fournitures SAS',
        address: '12 Rue du Commerce',
        city: 'Paris',
        postalCode: '75015',
        country: 'FR',
        taxId: 'FR12345678901',
      },
      lines: [{ description: 'Avoir sur commande annulée', quantity: 5, unitPrice: 25, taxRate: 20 }],
      note: 'Avoir suite à retour marchandise — bon de retour n° BR-2026-042',
    },
  },
  {
    label: 'Fournisseur SAP existant',
    description: 'Pré-sélection depuis le cache SAP',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: { name: '' }, // rempli via recherche SAP
      lines: [{ description: 'Prestation de service', quantity: 1, unitPrice: 500, taxRate: 20 }],
    },
  },
  {
    label: 'Fournisseur manuel',
    description: 'Saisie libre + enrichissement INSEE/Pappers',
    data: {
      currency: 'EUR',
      direction: 'INVOICE',
      supplier: { name: '', taxId: '', siret: '' },
      lines: [{ description: 'Matières premières', quantity: 100, unitPrice: 8.5, taxRate: 20 }],
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
  return { description: '', quantity: 1, unitPrice: 0, taxRate: 20 };
}
function defaultForm(): InvoiceGenData {
  const timestamp = new Date().toISOString().replace(/-/g, '').replace(/:/g, '').replace('T', '');

  return {
    invoiceNumber: `TEST-${timestamp.substring(0, 12)}`,
    invoiceDate: todayStr(),
    dueDate: dueDateStr(),
    currency: 'EUR',
    direction: 'INVOICE',
    supplier: { name: '', address: '', city: '', postalCode: '', country: 'FR', taxId: '', siret: '' },
    buyerName: 'DEMO INDUSTRIE SAS',
    lines: [defaultLine()],
    note: '',
  };
}

// ─── Calcul montants (miroir du backend) ──────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100; }
function computeTotals(lines: GenLine[]) {
  let ht = 0, tva = 0;
  for (const l of lines) {
    const lineHt = round2(l.quantity * l.unitPrice);
    ht  += lineHt;
    tva += round2(lineHt * l.taxRate / 100);
  }
  return { ht: round2(ht), tva: round2(tva), ttc: round2(ht + tva) };
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
  const [xmlOpen, setXmlOpen] = useState(false);

  const totals = computeTotals(form.lines);

  // ── Preset ────────────────────────────────────────────────────────────────
  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
    setResult(null);
    setError(null);
    setEnrichError(null);
    if (p.label === 'Fournisseur SAP existant') setSupplierMode('sap');
    else setSupplierMode('manual');
    setForm(prev => ({
      ...defaultForm(),
      ...p.data,
      invoiceNumber: prev.invoiceNumber,
      invoiceDate: prev.invoiceDate,
      dueDate: prev.dueDate,
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
    setForm(prev => ({
      ...prev,
      supplier: {
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
    const siren = (form.supplier.siret ?? form.supplier.taxId ?? '').replace(/\s/g, '').replace(/^FR\d{2}/, '').substring(0, 14);
    const digits = siren.replace(/\D/g, '');
    if (digits.length < 9) {
      setEnrichError('Saisissez un SIREN (9 chiffres) ou SIRET (14 chiffres) avant d\'enrichir.');
      return;
    }
    setEnrichLoading(true);
    setEnrichError(null);
    try {
      const data = await apiEnrichSupplier(digits.substring(0, 9));
      setForm(prev => ({
        ...prev,
        supplier: {
          ...prev.supplier,
          name:       data.name       || prev.supplier.name,
          address:    data.address    ?? prev.supplier.address,
          city:       data.city       ?? prev.supplier.city,
          postalCode: data.postalCode ?? prev.supplier.postalCode,
          country:    data.country    ?? prev.supplier.country,
          taxId:      data.taxId      ?? prev.supplier.taxId,
          siret:      data.siret      ?? prev.supplier.siret,
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
    setForm(prev => {
      const lines = [...prev.lines];
      lines[idx] = { ...lines[idx], [field]: value };
      return { ...prev, lines };
    });
  };
  const addLine    = () => setForm(prev => ({ ...prev, lines: [...prev.lines, defaultLine()] }));
  const removeLine = (idx: number) => setForm(prev => ({ ...prev, lines: prev.lines.filter((_, i) => i !== idx) }));

  // ── Génération ────────────────────────────────────────────────────────────
  const generate = async () => {
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
  const setSupplierField = (field: keyof GenSupplier, value: string) =>
    setForm(prev => ({ ...prev, supplier: { ...prev.supplier, [field]: value } }));

  const fmtAmt = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Titre */}
      <div className="flex items-center gap-3">
        <FlaskConical className="h-6 w-6 text-violet-500" />
        <div>
          <h1 className="text-xl font-semibold">Générateur de factures de test</h1>
          <p className="text-sm text-muted-foreground">
            Génère des fichiers XML UBL 2.1 et PDF compatibles avec BILLING — usage test uniquement.
          </p>
        </div>
      </div>

      {/* Scénarios prédéfinis */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Scénarios prédéfinis</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p, i) => (
              <button
                key={i}
                onClick={() => applyPreset(i)}
                title={p.description}
                className="px-3 py-1.5 text-xs rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* En-tête facture */}
      <Card>
        <CardHeader><CardTitle className="text-sm">En-tête facture</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Numéro *">
              <input className={inputCls} value={form.invoiceNumber}
                onChange={e => setForm(p => ({ ...p, invoiceNumber: e.target.value }))} />
            </Field>
            <Field label="Type *">
              <select className={inputCls} value={form.direction}
                onChange={e => setForm(p => ({ ...p, direction: e.target.value as 'INVOICE' | 'CREDIT_NOTE' }))}>
                <option value="INVOICE">Facture (380)</option>
                <option value="CREDIT_NOTE">Avoir (381)</option>
              </select>
            </Field>
            <Field label="Devise *">
              <select className={inputCls} value={form.currency}
                onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </Field>
            <Field label="Date facture *">
              <input type="date" className={inputCls} value={form.invoiceDate}
                onChange={e => setForm(p => ({ ...p, invoiceDate: e.target.value }))} />
            </Field>
            <Field label="Date échéance">
              <input type="date" className={inputCls} value={form.dueDate ?? ''}
                onChange={e => setForm(p => ({ ...p, dueDate: e.target.value || undefined }))} />
            </Field>
            <Field label="Client (acheteur)">
              <input className={inputCls} value={form.buyerName ?? ''}
                onChange={e => setForm(p => ({ ...p, buyerName: e.target.value }))} />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Note (optionnel)">
              <input className={inputCls} value={form.note ?? ''}
                onChange={e => setForm(p => ({ ...p, note: e.target.value }))} />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* Fournisseur */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Fournisseur</CardTitle>
            <div className="flex gap-2">
              <button
                onClick={() => setSupplierMode('manual')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${supplierMode === 'manual' ? 'bg-primary text-primary-foreground border-primary' : 'border-input hover:bg-accent'}`}
              >Manuel</button>
              <button
                onClick={() => setSupplierMode('sap')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${supplierMode === 'sap' ? 'bg-primary text-primary-foreground border-primary' : 'border-input hover:bg-accent'}`}
              >SAP existant</button>
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
                  onChange={e => setSapSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchSap()}
                />
                <Button size="sm" onClick={searchSap} loading={sapLoading}>
                  Rechercher
                </Button>
              </div>
              {sapResults.length > 0 && (
                <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {sapResults.map(s => (
                    <button key={s.id} onClick={() => selectSapSupplier(s)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors">
                      <span className="font-medium">{s.cardname}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{s.cardcode}</span>
                      {s.federaltaxid && <span className="ml-2 text-xs text-muted-foreground">{s.federaltaxid}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Champs fournisseur */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Raison sociale *" className="col-span-2 md:col-span-2">
              <input className={inputCls} value={form.supplier.name}
                onChange={e => setSupplierField('name', e.target.value)} />
            </Field>
            <Field label="Pays">
              <input className={inputCls} value={form.supplier.country ?? 'FR'}
                onChange={e => setSupplierField('country', e.target.value)} maxLength={2} />
            </Field>
            <Field label="Adresse">
              <input className={inputCls} value={form.supplier.address ?? ''}
                onChange={e => setSupplierField('address', e.target.value)} />
            </Field>
            <Field label="Ville">
              <input className={inputCls} value={form.supplier.city ?? ''}
                onChange={e => setSupplierField('city', e.target.value)} />
            </Field>
            <Field label="Code postal">
              <input className={inputCls} value={form.supplier.postalCode ?? ''}
                onChange={e => setSupplierField('postalCode', e.target.value)} />
            </Field>
            <Field label="N° TVA intracommunautaire">
              <input className={inputCls} value={form.supplier.taxId ?? ''}
                onChange={e => setSupplierField('taxId', e.target.value)} placeholder="FR12345678901" />
            </Field>
            <Field label="SIRET">
              <input className={inputCls} value={form.supplier.siret ?? ''}
                onChange={e => setSupplierField('siret', e.target.value)} placeholder="12345678901234" />
            </Field>
          </div>

          {/* Bouton enrichissement */}
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
            <CardTitle className="text-sm">Lignes de facture</CardTitle>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" />
              Ajouter une ligne
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-2 py-2 font-medium text-xs text-muted-foreground">Description *</th>
                  <th className="text-right px-2 py-2 font-medium text-xs text-muted-foreground w-20">Quantité</th>
                  <th className="text-right px-2 py-2 font-medium text-xs text-muted-foreground w-28">P.U. HT</th>
                  <th className="text-right px-2 py-2 font-medium text-xs text-muted-foreground w-20">TVA %</th>
                  <th className="text-right px-2 py-2 font-medium text-xs text-muted-foreground w-28">Montant HT</th>
                  <th className="text-right px-2 py-2 font-medium text-xs text-muted-foreground w-28">Total TTC</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {form.lines.map((line, idx) => {
                  const lineHt  = round2(line.quantity * line.unitPrice);
                  const lineTtc = round2(lineHt * (1 + line.taxRate / 100));
                  return (
                    <tr key={idx}>
                      <td className="px-2 py-1.5">
                        <input className={`${inputCls} text-xs`} value={line.description}
                          onChange={e => updateLine(idx, 'description', e.target.value)}
                          placeholder="Description..." />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" className={`${inputCls} text-xs text-right`}
                          value={line.quantity} min={0.001} step={0.001}
                          onChange={e => updateLine(idx, 'quantity', parseFloat(e.target.value) || 0)} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" className={`${inputCls} text-xs text-right`}
                          value={line.unitPrice} min={0} step={0.01}
                          onChange={e => updateLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)} />
                      </td>
                      <td className="px-2 py-1.5">
                        <select className={`${inputCls} text-xs`} value={line.taxRate}
                          onChange={e => updateLine(idx, 'taxRate', parseFloat(e.target.value))}>
                          <option value={20}>20 %</option>
                          <option value={10}>10 %</option>
                          <option value={5.5}>5,5 %</option>
                          <option value={2.1}>2,1 %</option>
                          <option value={0}>0 %</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs font-medium">{fmtAmt(lineHt)}</td>
                      <td className="px-2 py-1.5 text-right text-xs font-medium">{fmtAmt(lineTtc)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {form.lines.length > 1 && (
                          <button onClick={() => removeLine(idx)}
                            className="text-muted-foreground hover:text-destructive transition-colors p-1">
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
                <span className="font-medium text-foreground">{fmtAmt(totals.ht)} {form.currency}</span>
              </div>
              <div className="flex justify-between gap-8 text-muted-foreground">
                <span>TVA totale</span>
                <span className="font-medium text-foreground">{fmtAmt(totals.tva)} {form.currency}</span>
              </div>
              <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
                <span>Total TTC</span>
                <span>{fmtAmt(totals.ttc)} {form.currency}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bouton générer + erreur */}
      <div className="flex items-center gap-4">
        <Button size="lg" onClick={generate} loading={generating}
          disabled={!form.invoiceNumber || !form.supplier.name || form.lines.length === 0}>
          <RefreshCw className="h-4 w-4" />
          Générer la facture
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {/* Résultat */}
      {result && (
        <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
          <CardHeader>
            <CardTitle className="text-sm text-green-700 dark:text-green-400">
              Facture générée avec succès
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Récapitulatif */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <SummaryItem label="Numéro"    value={result.summary.invoiceNumber} />
              <SummaryItem label="Type"      value={result.summary.direction === 'CREDIT_NOTE' ? 'Avoir' : 'Facture'} />
              <SummaryItem label="Fournisseur" value={result.summary.supplierName} />
              <SummaryItem label="Identifiant" value={result.summary.supplierIdentifier} />
              <SummaryItem label="Total HT"  value={`${fmtAmt(result.summary.totalExclTax)} ${result.summary.currency}`} />
              <SummaryItem label="TVA"       value={`${fmtAmt(result.summary.totalTax)} ${result.summary.currency}`} />
              <SummaryItem label="Total TTC" value={`${fmtAmt(result.summary.totalInclTax)} ${result.summary.currency}`} />
              <SummaryItem label="Lignes"    value={String(result.summary.lineCount)} />
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
            </div>

            {/* Prévisualisation XML */}
            <div>
              <button
                onClick={() => setXmlOpen(v => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {xmlOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {xmlOpen ? 'Masquer le XML' : 'Prévisualiser le XML'}
              </button>
              {xmlOpen && (
                <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-x-auto max-h-96 font-mono whitespace-pre-wrap break-all">
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

const inputCls = 'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
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
