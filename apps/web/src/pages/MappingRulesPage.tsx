import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  BookmarkPlus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  RefreshCw,
  FlaskConical,
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  Pencil,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  FilterX,
} from 'lucide-react';
import {
  apiGetMappingRules,
  apiDeleteMappingRule,
  apiTestRule,
  mappingRulesExportUrl,
  apiImportRules,
  type MappingRule,
  type TestRuleResult,
} from '../api/mapping-rules.api';
import { apiGetSapVatCodes } from '../api/sap.api';
import { apiFetch } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { AccountSearch } from '../components/ui/AccountSearch';
import { toast } from '../lib/toast';

type SortDir = 'asc' | 'desc';

// Seuil de cardinalité : au-delà, le filtre colonne reste en saisie « contient »
// (avec suggestions datalist) ; en deçà, il devient un menu déroulant (égalité exacte).
const LOW_CARDINALITY_MAX = 8;

interface RuleColumn {
  id: string;
  label: string;
  align?: 'left' | 'right';
  /** Valeur texte affichée — sert au filtre « contient » ET au tri alphabétique. */
  text: (r: MappingRule) => string;
  /** Clé de tri ; par défaut = text. Numérique pour Taux TVA, Confiance, Usages. */
  sortValue?: (r: MappingRule) => string | number;
}

// Source unique de vérité pour les colonnes de données (hors colonnes d'action,
// ni filtrables ni triables). Les accesseurs `text` produisent exactement la donnée
// brute servant au filtre et au tri (sans le fallback « — » d'affichage).
const RULE_COLUMNS: RuleColumn[] = [
  {
    id: 'scope',
    label: 'Portée',
    text: (r) => (r.scope === 'SUPPLIER' ? 'Fournisseur' : 'Global'),
  },
  { id: 'supplier', label: 'Fournisseur', text: (r) => r.supplierCardcode ?? '' },
  { id: 'keyword', label: 'Mot-clé', text: (r) => r.matchKeyword ?? '' },
  {
    id: 'taxRate',
    label: 'Taux TVA',
    text: (r) => (r.matchTaxRate != null ? String(r.matchTaxRate) : ''),
    sortValue: (r) => (r.matchTaxRate != null ? r.matchTaxRate : Number.NEGATIVE_INFINITY),
  },
  { id: 'account', label: 'Compte', text: (r) => r.accountCode },
  { id: 'costCenter', label: 'Centre', text: (r) => r.costCenter ?? '' },
  { id: 'taxCodeB1', label: 'Code TVA B1', text: (r) => r.taxCodeB1 ?? '' },
  {
    id: 'confidence',
    label: 'Confiance',
    align: 'right',
    text: (r) => String(r.confidence),
    sortValue: (r) => r.confidence,
  },
  {
    id: 'usage',
    label: 'Usages',
    align: 'right',
    text: (r) => String(r.usageCount),
    sortValue: (r) => r.usageCount,
  },
  { id: 'active', label: 'Actif', text: (r) => (r.active ? 'Actif' : 'Inactif') },
];

// Critère unique « sans code TVA B1 » — partagé par le compteur et le filtre cliquable.
const isEmptyTva = (r: MappingRule): boolean => !r.taxCodeB1 || r.taxCodeB1.trim() === '';

function ConfidenceBadge({ value }: { value: number }) {
  const color = value >= 80 ? 'text-success' : value >= 50 ? 'text-warning' : 'text-destructive';
  return <span className={`font-mono text-xs font-semibold ${color}`}>{value}%</span>;
}

interface VatOption {
  code: string;
  name: string;
  rate: number;
  active: boolean;
}

interface TaxCodeCellProps {
  rule: MappingRule;
  vatCodes: VatOption[];
  vatLoading: boolean;
  onUpdated: (updated: MappingRule) => void;
}

function TaxCodeCell({ rule, vatCodes, vatLoading, onUpdated }: TaxCodeCellProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const empty = !rule.taxCodeB1 || rule.taxCodeB1.trim() === '';

  async function save(newCode: string) {
    if (newCode === (rule.taxCodeB1 ?? '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await apiFetch<MappingRule>(`/api/mapping-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taxCodeB1: newCode === '' ? null : newCode }),
      });
      onUpdated(updated);
      toast.success(`Code TVA mis à jour : ${updated.taxCodeB1 ?? '(vide)'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec mise à jour');
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <select
        className="app-input h-7 text-xs font-mono"
        defaultValue={rule.taxCodeB1 ?? ''}
        autoFocus
        disabled={saving}
        onBlur={(e) => {
          void save(e.target.value);
        }}
        onChange={(e) => {
          void save(e.target.value);
        }}
      >
        <option value="">— (vide)</option>
        {vatCodes.map((v) => (
          <option key={v.code} value={v.code}>
            {v.code} — {v.rate}% {v.name ? `· ${v.name}` : ''}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      disabled={vatLoading || saving}
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-muted/60 ${empty ? 'text-warning' : 'text-foreground'}`}
      title={empty ? 'Code TVA manquant — cliquer pour renseigner' : 'Cliquer pour modifier'}
    >
      {empty ? (
        <>
          <AlertCircle className="h-3 w-3" />
          <span className="font-semibold">À renseigner</span>
        </>
      ) : (
        <>
          <span>{rule.taxCodeB1}</span>
          <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
        </>
      )}
    </button>
  );
}

function TestRuleModal({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [supplierCardcode, setSupplierCardcode] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestRuleResult | null>(null);

  async function handleTest(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setTesting(true);
    setResult(null);
    try {
      const res = await apiTestRule({
        description: description.trim(),
        amountExclTax: amount ? Number(amount) : undefined,
        taxRate: taxRate ? Number(taxRate) : null,
        supplierCardcode: supplierCardcode.trim() || null,
      });
      setResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-panel">
        <h2 className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground">
          <FlaskConical className="h-4 w-4 text-primary" /> Tester une règle
        </h2>
        <p className="text-xs text-muted-foreground">
          Simule l'application des règles actives sur les critères fournis.
        </p>

        <form
          onSubmit={(e) => {
            void handleTest(e);
          }}
          className="space-y-3"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Libellé *
            </label>
            <input
              className="app-input h-9 text-xs"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="ex: Maintenance informatique"
              autoFocus
              disabled={testing}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Montant HT (€)
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="ex: 1500.00"
                disabled={testing}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Taux TVA (%)
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                type="number"
                step="0.01"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                placeholder="ex: 20"
                disabled={testing}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              CardCode fournisseur
            </label>
            <input
              className="app-input h-9 text-xs font-mono"
              value={supplierCardcode}
              onChange={(e) => setSupplierCardcode(e.target.value)}
              placeholder="ex: F00042"
              disabled={testing}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" type="button" onClick={onClose} disabled={testing}>
              Fermer
            </Button>
            <Button size="sm" type="submit" disabled={testing || !description.trim()}>
              {testing ? 'Test en cours…' : 'Simuler'}
            </Button>
          </div>
        </form>

        {result && (
          <div
            className={`mt-2 rounded-2xl border px-4 py-3 text-sm ${result.matched ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {result.matched ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {result.matched ? 'Règle trouvée' : 'Aucune règle correspondante'}
              <span className="ml-auto text-[11px] font-normal opacity-70">
                {result.candidatesCount} candidat(s) évalué(s)
              </span>
            </div>
            {result.rule && (
              <div className="mt-2 space-y-1 text-xs">
                <p>
                  Compte :{' '}
                  <span className="font-mono font-semibold">{result.rule.accountCode}</span>
                </p>
                {result.rule.costCenter && (
                  <p>
                    Centre : <span className="font-mono">{result.rule.costCenter}</span>
                  </p>
                )}
                {result.rule.taxCodeB1 && (
                  <p>
                    Code TVA B1 : <span className="font-mono">{result.rule.taxCodeB1}</span>
                  </p>
                )}
                <p>
                  Portée : {result.rule.scope} · Score : {result.rule.score} · Confiance :{' '}
                  {result.rule.confidence}%
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface EditRuleModalProps {
  rule: MappingRule;
  onSaved: (updated: MappingRule) => void;
  onClose: () => void;
}

function EditRuleModal({ rule, onSaved, onClose }: EditRuleModalProps) {
  const [scope, setScope] = useState<'GLOBAL' | 'SUPPLIER'>(rule.scope as 'GLOBAL' | 'SUPPLIER');
  const [supplierCardcode, setSupplierCardcode] = useState(rule.supplierCardcode ?? '');
  const [matchKeyword, setMatchKeyword] = useState(rule.matchKeyword ?? '');
  const [matchTaxRate, setMatchTaxRate] = useState(
    rule.matchTaxRate != null ? String(rule.matchTaxRate) : '',
  );
  const [accountCode, setAccountCode] = useState(rule.accountCode);
  const [costCenter, setCostCenter] = useState(rule.costCenter ?? '');
  const [taxCodeB1, setTaxCodeB1] = useState(rule.taxCodeB1 ?? '');
  const [confidence, setConfidence] = useState(String(rule.confidence));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await apiFetch<MappingRule>(`/api/mapping-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          supplierCardcode: scope === 'SUPPLIER' ? supplierCardcode.trim() || null : null,
          matchKeyword: matchKeyword.trim() || null,
          matchTaxRate: matchTaxRate !== '' ? Number(matchTaxRate) : null,
          accountCode: accountCode.trim(),
          costCenter: costCenter.trim() || null,
          taxCodeB1: taxCodeB1.trim() || null,
          confidence: Number(confidence),
        }),
      });
      onSaved(updated);
      toast.success('Règle mise à jour');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-panel max-w-lg">
        <h2 className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground">
          <Pencil className="h-4 w-4 text-primary" /> Modifier la règle
        </h2>

        <form
          onSubmit={(e) => {
            void handleSave(e);
          }}
          className="space-y-3"
        >
          {/* Portée */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Portée</label>
              <select
                className="app-input h-9 text-xs"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as 'GLOBAL' | 'SUPPLIER');
                  if (e.target.value === 'GLOBAL') setSupplierCardcode('');
                }}
                disabled={saving}
              >
                <option value="GLOBAL">Global</option>
                <option value="SUPPLIER">Fournisseur</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                CardCode fournisseur{' '}
                {scope === 'SUPPLIER' && <span className="text-destructive">*</span>}
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                value={supplierCardcode}
                onChange={(e) => setSupplierCardcode(e.target.value)}
                placeholder={scope === 'SUPPLIER' ? 'ex: V12000' : '—'}
                disabled={saving || scope === 'GLOBAL'}
              />
            </div>
          </div>

          {/* Critères */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Mot-clé
              </label>
              <input
                className="app-input h-9 text-xs"
                value={matchKeyword}
                onChange={(e) => setMatchKeyword(e.target.value)}
                placeholder="ex: maintenance"
                disabled={saving}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Taux TVA (%)
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                type="number"
                step="0.01"
                value={matchTaxRate}
                onChange={(e) => setMatchTaxRate(e.target.value)}
                placeholder="ex: 20"
                disabled={saving}
              />
            </div>
          </div>

          {/* Compte comptable */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Compte comptable <span className="text-destructive">*</span>
            </label>
            <AccountSearch
              value={accountCode}
              onChange={setAccountCode}
              placeholder="Code ou libellé SAP…"
              disabled={saving}
              className="h-9"
            />
          </div>

          {/* Centre + Code TVA */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Centre de coût
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
                placeholder="ex: ATELIER"
                disabled={saving}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Code TVA B1
              </label>
              <input
                className="app-input h-9 text-xs font-mono"
                value={taxCodeB1}
                onChange={(e) => setTaxCodeB1(e.target.value)}
                placeholder="ex: S2"
                disabled={saving}
              />
            </div>
          </div>

          {/* Confiance */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Confiance : <span className="font-semibold text-foreground">{confidence}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              disabled={saving}
              className="w-full accent-primary"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" type="button" onClick={onClose} disabled={saving}>
              Annuler
            </Button>
            <Button size="sm" type="submit" disabled={saving || !accountCode.trim()}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function MappingRulesPage() {
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editRule, setEditRule] = useState<MappingRule | null>(null);
  const [showTest, setShowTest] = useState(false);
  const [importing, setImporting] = useState(false);
  const [vatCodes, setVatCodes] = useState<VatOption[]>([]);
  const [vatLoading, setVatLoading] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(null);
  const [emptyTvaOnly, setEmptyTvaOnly] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGetMappingRules();
      setRules(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadVatCodes = useCallback(async () => {
    setVatLoading(true);
    try {
      const codes = await apiGetSapVatCodes();
      setVatCodes(codes.filter((c) => c.active));
    } catch {
      // Silencieux : si SAP/cache indisponible, l'édition en ligne est désactivée
      // mais la page reste utilisable.
    } finally {
      setVatLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadVatCodes();
  }, [load, loadVatCodes]);

  async function toggleActive(rule: MappingRule) {
    setToggling(rule.id);
    try {
      const updated = await apiFetch<MappingRule>(`/api/mapping-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !rule.active }),
      });
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch {
      // silently ignore
    } finally {
      setToggling(null);
    }
  }

  async function deleteRule(id: string) {
    setDeleting(id);
    try {
      await apiDeleteMappingRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // silently ignore
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    try {
      const csv = await file.text();
      const result = await apiImportRules(csv);
      toast.success(
        `${result.created} règle(s) importée(s)${result.skipped ? ` · ${result.skipped} ignorée(s)` : ''}`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec import CSV');
    } finally {
      setImporting(false);
    }
  }

  const activeCount = rules.filter((r) => r.active).length;
  const emptyTvaCount = rules.filter(isEmptyTva).length;

  // Filtres auto-alimentés (hybride par cardinalité), calculés sur `rules` :
  // `select` (égalité) si peu de valeurs distinctes, sinon `text` (contient) + datalist.
  const columnMode = useMemo(() => {
    const m: Record<string, { mode: 'select' | 'text'; values: string[] }> = {};
    for (const c of RULE_COLUMNS) {
      const values = Array.from(
        new Set(rules.map((r) => c.text(r)).filter((v) => v.trim() !== '')),
      ).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
      m[c.id] = { mode: values.length <= LOW_CARDINALITY_MAX ? 'select' : 'text', values };
    }
    return m;
  }, [rules]);

  // Filtres colonne + tri appliqués côté client sur `rules` (pas de recherche serveur).
  const rows = useMemo(() => {
    // Filtre « sans code TVA » (bascule) appliqué en amont des filtres de colonne et du tri.
    const base = emptyTvaOnly ? rules.filter(isEmptyTva) : rules;
    let r = base.filter((rule) =>
      RULE_COLUMNS.every((c) => {
        const f = columnFilters[c.id]?.trim();
        if (!f) return true;
        const cell = c.text(rule);
        return columnMode[c.id]?.mode === 'select'
          ? cell === f
          : cell.toLowerCase().includes(f.toLowerCase());
      }),
    );
    if (sort) {
      const col = RULE_COLUMNS.find((c) => c.id === sort.id);
      if (col) {
        const get = col.sortValue ?? col.text;
        r = [...r].sort((a, b) => {
          const va = get(a);
          const vb = get(b);
          let cmp: number;
          if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
          else
            cmp = String(va).localeCompare(String(vb), 'fr', {
              numeric: true,
              sensitivity: 'base',
            });
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return r;
  }, [rules, columnFilters, sort, columnMode, emptyTvaOnly]);

  function toggleSort(id: string) {
    setSort((prev) =>
      prev?.id !== id ? { id, dir: 'asc' } : prev.dir === 'asc' ? { id, dir: 'desc' } : null,
    );
  }

  const hasColumnFiltersOrSort =
    Object.values(columnFilters).some((v) => v?.trim()) || Boolean(sort) || emptyTvaOnly;

  return (
    <div className="app-page">
      {editRule && (
        <EditRuleModal
          rule={editRule}
          onSaved={(updated) =>
            setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
          }
          onClose={() => setEditRule(null)}
        />
      )}
      {showTest && <TestRuleModal onClose={() => setShowTest(false)} />}

      <div className="page-header">
        <div>
          <p className="page-eyebrow">Configuration</p>
          <p className="page-subtitle">
            {rules.length} règle{rules.length !== 1 ? 's' : ''} · {activeCount} active
            {activeCount !== 1 ? 's' : ''}
            {emptyTvaCount > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setEmptyTvaOnly((v) => !v)}
                  aria-pressed={emptyTvaOnly}
                  aria-label="Filtrer les règles sans code TVA"
                  title={
                    emptyTvaOnly
                      ? 'Afficher toutes les règles'
                      : 'Afficher uniquement les règles sans code TVA'
                  }
                  className={`cursor-pointer rounded font-semibold text-warning underline-offset-2 transition-colors hover:underline ${
                    emptyTvaOnly ? 'bg-warning/10 px-1.5 py-0.5 underline' : ''
                  }`}
                >
                  {emptyTvaCount} sans code TVA
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowTest(true)}>
            <FlaskConical className="h-3.5 w-3.5 mr-1.5" /> Tester
          </Button>
          <a href={mappingRulesExportUrl()} download="mapping-rules.csv">
            <Button variant="outline" size="sm" type="button">
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
            </Button>
          </a>
          <input
            ref={importRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              void handleImport(e);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={importing}
            onClick={() => importRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            {importing ? 'Import…' : 'Import CSV'}
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
        </div>
      </div>

      {error && (
        <div className="alert-error">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center gap-2">
            <BookmarkPlus className="h-4 w-4 text-primary" />
            Toutes les règles
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-10" role="status" aria-label="Chargement…">
              <div
                className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                aria-hidden="true"
              />
            </div>
          ) : rules.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Aucune règle de mappage. Les règles sont créées automatiquement après chaque
              intégration SAP.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" aria-label="Règles de mappage">
                <thead>
                  <tr>
                    {RULE_COLUMNS.map((c) => {
                      const active = sort?.id === c.id;
                      return (
                        <th
                          key={c.id}
                          className={c.align === 'right' ? 'text-right' : undefined}
                          aria-sort={
                            active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                          }
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(c.id)}
                            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                          >
                            {c.label}
                            {active ? (
                              sort!.dir === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </th>
                      );
                    })}
                    <th />
                    <th />
                  </tr>
                  <tr className="bg-muted/20">
                    {RULE_COLUMNS.map((c) => (
                      <th key={c.id} className="p-1">
                        {columnMode[c.id]?.mode === 'select' ? (
                          <select
                            className="app-input h-7 w-full text-xs font-normal"
                            aria-label={`Filtrer ${c.label}`}
                            value={columnFilters[c.id] ?? ''}
                            onChange={(e) =>
                              setColumnFilters((prev) => ({ ...prev, [c.id]: e.target.value }))
                            }
                          >
                            <option value="">Tous</option>
                            {columnMode[c.id].values.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <>
                            <input
                              className="app-input h-7 w-full text-xs font-normal"
                              placeholder="Filtrer…"
                              aria-label={`Filtrer ${c.label}`}
                              list={`dl-rule-${c.id}`}
                              value={columnFilters[c.id] ?? ''}
                              onChange={(e) =>
                                setColumnFilters((prev) => ({ ...prev, [c.id]: e.target.value }))
                              }
                            />
                            <datalist id={`dl-rule-${c.id}`}>
                              {columnMode[c.id]?.values.map((v) => (
                                <option key={v} value={v} />
                              ))}
                            </datalist>
                          </>
                        )}
                      </th>
                    ))}
                    <th className="p-1" />
                    <th className="p-1 text-right">
                      {hasColumnFiltersOrSort && (
                        <button
                          type="button"
                          onClick={() => {
                            setColumnFilters({});
                            setSort(null);
                            setEmptyTvaOnly(false);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          aria-label="Réinitialiser les filtres et le tri"
                        >
                          <FilterX className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={RULE_COLUMNS.length + 2}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Aucune règle ne correspond aux filtres de colonne.
                      </td>
                    </tr>
                  )}
                  {rows.map((rule) => (
                    <tr
                      key={rule.id}
                      className={`group transition-colors hover:bg-muted/20 ${!rule.active ? 'opacity-50' : ''}`}
                    >
                      <td>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${rule.scope === 'SUPPLIER' ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-muted-foreground'}`}
                        >
                          {rule.scope === 'SUPPLIER' ? 'Fournisseur' : 'Global'}
                        </span>
                      </td>
                      <td className="font-mono text-xs text-muted-foreground">
                        {rule.supplierCardcode ?? '—'}
                      </td>
                      <td className="font-mono text-xs">{rule.matchKeyword ?? '—'}</td>
                      <td className="font-mono text-xs text-muted-foreground">
                        {rule.matchTaxRate != null ? `${rule.matchTaxRate}%` : '—'}
                      </td>
                      <td className="font-mono text-xs font-semibold">{rule.accountCode}</td>
                      <td className="font-mono text-xs text-muted-foreground">
                        {rule.costCenter ?? '—'}
                      </td>
                      <td>
                        <TaxCodeCell
                          rule={rule}
                          vatCodes={vatCodes}
                          vatLoading={vatLoading}
                          onUpdated={(updated) =>
                            setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
                          }
                        />
                      </td>
                      <td className="text-right">
                        <ConfidenceBadge value={rule.confidence} />
                      </td>
                      <td className="text-right font-mono text-xs text-muted-foreground">
                        {rule.usageCount}
                      </td>
                      <td>
                        <button
                          onClick={() => {
                            void toggleActive(rule);
                          }}
                          disabled={toggling === rule.id}
                          className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                          title={rule.active ? 'Désactiver' : 'Activer'}
                        >
                          {rule.active ? (
                            <ToggleRight className="h-5 w-5 text-success" />
                          ) : (
                            <ToggleLeft className="h-5 w-5" />
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          onClick={() => setEditRule(rule)}
                          className="rounded-lg p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-muted/60 hover:text-foreground"
                          title="Modifier"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </td>
                      <td className="text-right">
                        {confirmDelete === rule.id ? (
                          <span className="flex items-center gap-1 justify-end">
                            <button
                              onClick={() => {
                                void deleteRule(rule.id);
                              }}
                              disabled={deleting === rule.id}
                              className="rounded px-2 py-0.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                              {deleting === rule.id ? '…' : 'Confirmer'}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60"
                            >
                              Annuler
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(rule.id)}
                            className="rounded-lg p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                            title="Supprimer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
