import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Search,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Copy,
  Plus,
  Wrench,
  GitMerge,
  Unlink,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  FilterX,
} from 'lucide-react';
import {
  apiGetSuppliers,
  apiGetSuppliersSyncStatus,
  apiSyncSuppliers,
  apiCreateSupplierInSap,
  apiPatchSupplierFiscal,
  apiMergeSuppliers,
  apiReconcilePreview,
  apiReconcileExecute,
  apiListSupplierMerges,
  apiDetachSupplier,
  type SupplierCache,
  type SupplierSyncStatus,
  type SupplierSyncResult,
  type ReconcilePlanEntry,
  type SupplierMergeItem,
} from '../api/suppliers.api';
import {
  CreateSupplierModal,
  FieldRow,
  nextSupplierCardCode,
  type SupplierForm,
} from '../components/suppliers/CreateSupplierModal';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { toast } from '../lib/toast';
import { formatDate } from '../lib/utils';

type AnomalyKey = 'NO_VAT' | 'NO_SIRET' | 'NO_PA' | 'DUPLICATE';

type SortDir = 'asc' | 'desc';

// Seuil de cardinalité : au-delà, le filtre colonne reste en saisie « contient »
// (avec suggestions datalist) ; en deçà, il devient un menu déroulant (égalité exacte).
const LOW_CARDINALITY_MAX = 8;

interface SupplierColumn {
  id: string;
  label: string;
  align?: 'left' | 'right';
  /** Valeur texte affichée — sert au filtre « contient » ET au tri alphabétique. */
  text: (s: SupplierCache) => string;
  /** Clé de tri ; par défaut = text. Numérique pour Nb factures, ISO pour la date. */
  sortValue?: (s: SupplierCache) => string | number;
}

// Source unique de vérité pour les colonnes de données (hors colonne « Actions »,
// ni filtrable ni triable). Les accesseurs `text` produisent exactement la donnée
// brute rendue dans la cellule (sans le fallback « — »).
const SUPPLIER_COLUMNS: SupplierColumn[] = [
  { id: 'cardcode', label: 'Code fournisseur SAP', text: (s) => s.cardcode },
  { id: 'cardname', label: 'Nom fournisseur', text: (s) => s.cardname },
  { id: 'pa', label: 'Identifiant fournisseur PA', text: (s) => s.pa_identifier ?? '' },
  { id: 'vat', label: 'TVA intracommunautaire', text: (s) => s.federaltaxid ?? '' },
  { id: 'siren', label: 'SIREN', text: (s) => (s.taxId0 ? s.taxId0.slice(0, 9) : '') },
  { id: 'siret', label: 'SIRET', text: (s) => s.taxId0 ?? '' },
  {
    id: 'city',
    label: 'Ville / Pays',
    text: (s) => [s.city, s.country].filter(Boolean).join(' / '),
  },
  {
    id: 'invoices',
    label: 'Nb factures',
    align: 'right',
    text: (s) => String(s.invoiceCount),
    sortValue: (s) => s.invoiceCount,
  },
  {
    id: 'sync',
    label: 'Dernière synchronisation SAP',
    text: (s) => formatDate(s.lastSyncAt),
    sortValue: (s) => s.lastSyncAt, // ISO brut → tri chronologique correct
  },
];

// ── Modal de correction fiscale (par ligne) ─────────────────────────────────────
// Réutilise FieldRow du composant partagé. Pré-remplit avec les valeurs existantes ;
// n'envoie que les champs renseignés (jamais de valeur inventée, pas d'écrasement).
function FiscalCorrectionModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierCache;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [federalTaxId, setFederalTaxId] = useState(supplier.federaltaxid ?? '');
  const [licTradNum, setLicTradNum] = useState(supplier.taxId0 ?? '');
  const [routageCode, setRoutageCode] = useState(supplier.pa_identifier ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fields: { federalTaxId?: string; licTradNum?: string; routageCode?: string } = {};
    if (federalTaxId.trim()) fields.federalTaxId = federalTaxId.trim();
    if (licTradNum.trim()) fields.licTradNum = licTradNum.trim();
    if (routageCode.trim()) fields.routageCode = routageCode.trim();
    try {
      await apiPatchSupplierFiscal(supplier.cardcode, fields);
      toast.success('Identifiants fiscaux corrigés et poussés vers SAP');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la correction fiscale');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-fiscal-title"
      >
        <h2
          id="dlg-fiscal-title"
          className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
        >
          <Wrench className="h-4 w-4 text-primary" /> Corriger les identifiants fiscaux
        </h2>
        <p className="text-xs text-muted-foreground">
          {supplier.cardcode} — {supplier.cardname}. Seuls les champs renseignés sont poussés vers
          SAP ; un champ laissé vide n'écrase pas SAP.
        </p>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <FieldRow label="TVA intracommunautaire">
            <input
              className="app-input h-9 text-xs font-mono"
              placeholder="Ex: FR12345678901"
              disabled={saving}
              value={federalTaxId}
              onChange={(e) => setFederalTaxId(e.target.value)}
            />
          </FieldRow>
          <FieldRow label="SIRET">
            <input
              className="app-input h-9 text-xs font-mono"
              placeholder="Ex: 12345678900012"
              disabled={saving}
              value={licTradNum}
              onChange={(e) => setLicTradNum(e.target.value)}
            />
          </FieldRow>
          <FieldRow label="Identifiant fournisseur PA">
            <input
              className="app-input h-9 text-xs font-mono"
              placeholder="Code de routage PA"
              disabled={saving}
              value={routageCode}
              onChange={(e) => setRoutageCode(e.target.value)}
            />
          </FieldRow>

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
            <Button size="sm" type="submit" disabled={saving}>
              {saving ? 'Correction…' : 'Corriger dans SAP'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Modal de rattachement des doublons (groupes ambigus, ≥ 2 fiches SAP) ─────────
// Choix du maître (toutes les fiches affichées sont validFor:true), les autres
// deviennent alias dont les factures seront repointées vers le maître. Pas de fusion SAP.
function MergeDuplicatesModal({
  members,
  onClose,
  onMerged,
}: {
  members: SupplierCache[];
  onClose: () => void;
  onMerged: () => void;
}) {
  // Maître par défaut : plus grand invoiceCount, à égalité plus petit cardcode.
  const defaultMaster = useMemo(
    () =>
      [...members].sort(
        (a, b) => b.invoiceCount - a.invoiceCount || a.cardcode.localeCompare(b.cardcode),
      )[0]?.cardcode ?? '',
    [members],
  );
  const [master, setMaster] = useState(defaultMaster);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliases = members.filter((m) => m.cardcode !== master);
  const impact = aliases.reduce((sum, a) => sum + a.invoiceCount, 0);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiMergeSuppliers(
        master,
        aliases.map((a) => a.cardcode),
        reason.trim() || undefined,
      );
      toast.success(
        `${res.merged} fiche(s) rattachée(s), ${res.invoicesRepointed} facture(s) repointée(s)`,
      );
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors du rattachement');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-panel max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-merge-title"
      >
        <h2
          id="dlg-merge-title"
          className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
        >
          <GitMerge className="h-4 w-4 text-primary" /> Rattacher les doublons
        </h2>
        <p className="text-xs text-muted-foreground">
          Choisissez le fournisseur SAP <strong>maître</strong> ; les autres fiches deviennent des
          alias et leurs factures seront repointées vers le maître. Aucune fusion côté SAP.
        </p>

        <fieldset className="space-y-2">
          <legend className="sr-only">Choix du fournisseur maître</legend>
          {members.map((m) => {
            const isMaster = m.cardcode === master;
            return (
              <label
                key={m.cardcode}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  isMaster ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30'
                }`}
              >
                <input
                  type="radio"
                  name="merge-master"
                  className="accent-[var(--primary)]"
                  checked={isMaster}
                  disabled={saving}
                  onChange={() => setMaster(m.cardcode)}
                />
                <span className="font-mono text-xs font-semibold">{m.cardcode}</span>
                <span className="flex-1 text-sm">{m.cardname}</span>
                <span className="text-xs text-muted-foreground">
                  {m.invoiceCount} facture{m.invoiceCount !== 1 ? 's' : ''}
                </span>
                {isMaster && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Maître
                  </span>
                )}
              </label>
            );
          })}
        </fieldset>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Motif (facultatif)
          </label>
          <input
            className="app-input h-9 w-full text-xs"
            placeholder="ex: même entité, doublon de saisie…"
            disabled={saving}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <strong className="text-foreground">{impact}</strong> facture{impact !== 1 ? 's' : ''} ser
          {impact !== 1 ? 'ont' : 'a'} repointée{impact !== 1 ? 's' : ''} vers{' '}
          <span className="font-mono font-semibold text-foreground">{master}</span> (
          {aliases.length} alias).
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
          <Button
            size="sm"
            type="button"
            onClick={() => void handleConfirm()}
            disabled={saving || aliases.length === 0}
          >
            {saving ? 'Rattachement…' : 'Confirmer le rattachement'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Modal des rattachements actifs (détachement réversible) ──────────────────────
function ActiveMergesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<SupplierMergeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAlias, setConfirmAlias] = useState<string | null>(null);
  const [busyAlias, setBusyAlias] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      setItems(await apiListSupplierMerges());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement des rattachements');
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function handleDetach(alias: string) {
    setBusyAlias(alias);
    try {
      const res = await apiDetachSupplier(alias);
      toast.success(`Détaché — ${res.invoicesReverted} facture(s) re-réaffectée(s)`);
      setConfirmAlias(null);
      await loadList();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du détachement');
    } finally {
      setBusyAlias(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-panel max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-merges-title"
      >
        <h2
          id="dlg-merges-title"
          className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
        >
          <GitMerge className="h-4 w-4 text-primary" /> Rattachements actifs
        </h2>
        <p className="text-xs text-muted-foreground">
          Détacher annule le rattachement et re-réaffecte les factures concernées à l'alias
          d'origine (réversibilité).
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {items === null ? (
          <div className="flex justify-center py-8" role="status" aria-label="Chargement…">
            <div
              className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
              aria-hidden="true"
            />
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Aucun rattachement actif.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((m) => (
              <li
                key={m.aliasCardcode}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{m.aliasCardcode}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {m.aliasName ?? '—'}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono text-xs font-semibold text-primary">
                        {m.masterCardcode}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {m.masterName ?? '—'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatDate(m.createdAt)}
                      {m.reason ? ` · ${m.reason}` : ''}
                    </div>
                  </div>
                  {confirmAlias === m.aliasCardcode ? (
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleDetach(m.aliasCardcode)}
                        disabled={busyAlias === m.aliasCardcode}
                      >
                        {busyAlias === m.aliasCardcode ? 'Détachement…' : 'Confirmer'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmAlias(null)}
                        disabled={busyAlias === m.aliasCardcode}
                      >
                        Annuler
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-shrink-0"
                      onClick={() => setConfirmAlias(m.aliasCardcode)}
                    >
                      <Unlink className="mr-1 h-3.5 w-3.5" />
                      Détacher
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierCache[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SupplierSyncResult | null>(null);
  const [syncStatus, setSyncStatus] = useState<SupplierSyncStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [anomalyFilter, setAnomalyFilter] = useState<AnomalyKey | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [fiscalTarget, setFiscalTarget] = useState<SupplierCache | null>(null);
  const [mergeTarget, setMergeTarget] = useState<SupplierCache[] | null>(null);
  const [reconcilePlan, setReconcilePlan] = useState<ReconcilePlanEntry[] | null>(null);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [mergesCount, setMergesCount] = useState(0);
  const [showMerges, setShowMerges] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewDone = useRef(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGetSuppliers(q || undefined);
      setSuppliers(res.items);
      setTotal(res.total);
      setSyncStatus(await apiGetSuppliersSyncStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMergesCount = useCallback(async () => {
    try {
      const items = await apiListSupplierMerges();
      setMergesCount(items.length);
    } catch {
      /* pastille non bloquante */
    }
  }, []);

  // Au montage : APERÇU (dry-run, AUCUNE écriture) de la réconciliation auto une seule
  // fois, + nombre de rattachements actifs, puis chargement. La réconciliation n'agit
  // qu'après confirmation explicite de l'utilisateur (cf. bandeau d'aperçu).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!previewDone.current) {
        previewDone.current = true;
        try {
          const r = await apiReconcilePreview();
          if (!cancelled && r.plan.length > 0) setReconcilePlan(r.plan);
        } catch {
          /* non bloquant : on charge la liste quand même */
        }
        void refreshMergesCount();
      }
      if (!cancelled) await load(search);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, search, refreshMergesCount]);

  async function handleConfirmReconcile() {
    setReconciling(true);
    try {
      const res = await apiReconcileExecute();
      toast.success(
        `${res.groupsReconciled} rattaché(s), ${res.invoicesRepointed} facture(s) repointée(s)`,
      );
      setReconcilePlan(null);
      await load(search);
      await refreshMergesCount();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la réconciliation');
    } finally {
      setReconciling(false);
    }
  }

  function handleInput(value: string) {
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(value), 300);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const result = await apiSyncSuppliers();
      setSyncResult(result);
      await load(search);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Erreur de synchronisation');
    } finally {
      setSyncing(false);
    }
  }

  // ── Anomalies (calcul client sur les fournisseurs chargés) ──
  // Note : la liste serveur exclut déjà orphelins (validFor:false) et alias rattachés.
  // Les doublons restants sont donc des cas AMBIGUS (≥ 2 fiches SAP même clé fiscale).
  const { noVat, noSiret, noPa, duplicates, duplicateSet, dupGroupByCardcode } = useMemo(() => {
    const noVat = suppliers.filter((s) => !s.federaltaxid);
    const noSiret = suppliers.filter((s) => !s.taxId0);
    const noPa = suppliers.filter((s) => !s.pa_identifier);

    // Doublons : clé fiscale (TVA sinon SIRET) partagée par ≥ 2 cardcodes distincts.
    const dupKey = (s: SupplierCache) => (s.federaltaxid || s.taxId0 || '').trim();
    const groupsByKey = new Map<string, SupplierCache[]>();
    for (const s of suppliers) {
      const k = dupKey(s);
      if (!k) continue;
      const arr = groupsByKey.get(k);
      if (arr) arr.push(s);
      else groupsByKey.set(k, [s]);
    }
    const duplicates = suppliers.filter((s) => {
      const k = dupKey(s);
      const g = k ? groupsByKey.get(k) : undefined;
      return Boolean(g && new Set(g.map((x) => x.cardcode)).size > 1);
    });
    const duplicateSet = new Set(duplicates.map((s) => s.cardcode));
    const dupGroupByCardcode: Record<string, SupplierCache[]> = {};
    for (const s of duplicates) {
      const g = groupsByKey.get(dupKey(s));
      if (g) dupGroupByCardcode[s.cardcode] = g;
    }
    return { noVat, noSiret, noPa, duplicates, duplicateSet, dupGroupByCardcode };
  }, [suppliers]);

  // Filtres auto-alimentés (hybride par cardinalité), calculés sur `suppliers` (stable,
  // ne saute pas pendant la saisie) : `select` (égalité) si peu de valeurs, sinon
  // `text` (contient) + datalist de suggestions.
  const columnMode = useMemo(() => {
    const m: Record<string, { mode: 'select' | 'text'; values: string[] }> = {};
    for (const c of SUPPLIER_COLUMNS) {
      const values = Array.from(
        new Set(suppliers.map((s) => c.text(s)).filter((v) => v.trim() !== '')),
      ).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
      m[c.id] = { mode: values.length <= LOW_CARDINALITY_MAX ? 'select' : 'text', values };
    }
    return m;
  }, [suppliers]);

  const anomalyCards: {
    key: AnomalyKey;
    label: string;
    count: number;
    icon: typeof AlertCircle;
    iconClassName: string;
    accentClassName: string;
  }[] = [
    {
      key: 'NO_VAT',
      label: 'TVA intracom. manquante',
      count: noVat.length,
      icon: AlertCircle,
      iconClassName: 'bg-warning/10 text-warning ring-1 ring-warning/20',
      accentClassName: 'from-warning/20 to-transparent',
    },
    {
      key: 'NO_SIRET',
      label: 'SIRET manquant',
      count: noSiret.length,
      icon: AlertCircle,
      iconClassName: 'bg-destructive/10 text-destructive ring-1 ring-destructive/20',
      accentClassName: 'from-destructive/20 to-transparent',
    },
    {
      key: 'NO_PA',
      label: 'Identifiant PA manquant',
      count: noPa.length,
      icon: AlertCircle,
      iconClassName: 'bg-primary/10 text-primary ring-1 ring-primary/20',
      accentClassName: 'from-primary/20 to-transparent',
    },
    {
      key: 'DUPLICATE',
      label: 'Doublons (même TVA)',
      count: duplicates.length,
      icon: Copy,
      iconClassName: 'bg-[#E67E22]/10 text-[#E67E22] ring-1 ring-[#E67E22]/20',
      accentClassName: 'from-[#E67E22]/20 to-transparent',
    },
  ];

  const displayed =
    anomalyFilter === 'NO_VAT'
      ? noVat
      : anomalyFilter === 'NO_SIRET'
        ? noSiret
        : anomalyFilter === 'NO_PA'
          ? noPa
          : anomalyFilter === 'DUPLICATE'
            ? duplicates
            : suppliers;

  // Filtres colonne + tri appliqués PAR-DESSUS `displayed` (recherche serveur + anomalie).
  const rows = useMemo(() => {
    let r = displayed.filter((s) =>
      SUPPLIER_COLUMNS.every((c) => {
        const f = columnFilters[c.id]?.trim();
        if (!f) return true;
        const cell = c.text(s);
        return columnMode[c.id]?.mode === 'select'
          ? cell === f
          : cell.toLowerCase().includes(f.toLowerCase());
      }),
    );
    if (sort) {
      const col = SUPPLIER_COLUMNS.find((c) => c.id === sort.id);
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
  }, [displayed, columnFilters, sort, columnMode]);

  function toggleSort(id: string) {
    setSort((prev) =>
      prev?.id !== id ? { id, dir: 'asc' } : prev.dir === 'asc' ? { id, dir: 'desc' } : null,
    );
  }

  const hasColumnFiltersOrSort =
    Object.values(columnFilters).some((v) => v?.trim()) || Boolean(sort);

  async function handleCreateSupplier(data: SupplierForm) {
    await apiCreateSupplierInSap({
      cardCode: data.cardCode,
      cardName: data.cardName,
      federalTaxId: data.vatRegNum?.trim() || undefined,
      licTradNum: data.siret?.trim() || undefined,
      vatRegNum: data.vatRegNum?.trim() || undefined,
      street: data.street?.trim() || undefined,
      street2: data.street2?.trim() || undefined,
      city: data.city?.trim() || undefined,
      postalCode: data.postalCode?.trim() || undefined,
      country: data.country?.trim() || undefined,
      email: data.email?.trim() || undefined,
      phone: data.phone?.trim() || undefined,
    });
    await load(search);
    toast.success('Fournisseur créé dans SAP B1');
    setShowCreate(false);
  }

  return (
    <div className="app-page">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Référentiel</p>
          <p className="page-subtitle">
            {total} fournisseur{total !== 1 ? 's' : ''} en cache local
            {syncStatus?.lastSyncAt ? ` · dernière sync ${formatDate(syncStatus.lastSyncAt)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowMerges(true)} variant="outline" size="sm">
            <GitMerge className="h-3.5 w-3.5 mr-1.5" />
            Rattachements
            {mergesCount > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                {mergesCount}
              </span>
            )}
          </Button>
          <Button onClick={() => setShowCreate(true)} variant="outline" size="sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Créer un fournisseur
          </Button>
          <Button onClick={handleSync} disabled={syncing} size="sm">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Synchronisation…' : 'Synchroniser depuis SAP'}
          </Button>
        </div>
      </div>

      {syncResult && (
        <div className="alert-info text-sm">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          Synchronisation terminée — {syncResult.inserted} créé
          {syncResult.inserted !== 1 ? 's' : ''}, {syncResult.updated} mis à jour,{' '}
          {syncResult.disabled} désactivé{syncResult.disabled !== 1 ? 's' : ''} (total SAP :{' '}
          {syncResult.total}).
        </div>
      )}
      {(syncResult?.errors.length || syncStatus?.lastError) && (
        <div className="alert-error text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {syncResult?.errors[0]?.message ?? syncStatus?.lastError}
        </div>
      )}
      {syncError && (
        <div className="alert-error text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {syncError}
        </div>
      )}

      {error && (
        <div className="alert-error">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {reconcilePlan && reconcilePlan.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-2">
                <GitMerge className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                <div className="text-sm">
                  <p className="font-medium text-foreground">
                    {reconcilePlan.length} groupe{reconcilePlan.length !== 1 ? 's' : ''} de doublons
                    {reconcilePlan.length !== 1 ? ' peuvent' : ' peut'} être rattaché
                    {reconcilePlan.length !== 1 ? 's' : ''} automatiquement au bon fournisseur SAP —{' '}
                    {reconcilePlan.reduce((sum, p) => sum + p.invoicesToRepoint, 0)} facture(s)
                    seront repointées.
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-xs text-primary hover:underline"
                    onClick={() => setPlanExpanded((v) => !v)}
                    aria-expanded={planExpanded}
                  >
                    {planExpanded ? 'Masquer le détail' : 'Voir le détail'}
                  </button>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReconcilePlan(null)}
                  disabled={reconciling}
                >
                  Ignorer
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleConfirmReconcile()}
                  disabled={reconciling}
                >
                  {reconciling ? 'Rattachement…' : 'Confirmer les rattachements'}
                </Button>
              </div>
            </div>
            {planExpanded && (
              <ul className="space-y-1 border-t border-primary/20 pt-2 text-xs">
                {reconcilePlan.map((p) => (
                  <li key={p.masterCardcode} className="text-muted-foreground">
                    <span className="font-mono font-semibold text-primary">{p.masterCardcode}</span>{' '}
                    {p.masterName} ←{' '}
                    {p.aliases.map((a) => `${a.cardcode} (${a.invoiceCount} fact.)`).join(', ')}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Cartes d'anomalies (filtre toggle, calcul client) ── */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {anomalyCards.map((card) => {
          const active = anomalyFilter === card.key;
          const disabled = card.count === 0;
          return (
            <button
              key={card.key}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => setAnomalyFilter((prev) => (prev === card.key ? null : card.key))}
              className={`block w-full rounded-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 ${
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              }`}
            >
              <Card
                className={`relative overflow-hidden transition-shadow ${
                  active
                    ? 'ring-2 ring-primary shadow-md'
                    : 'hover:shadow-md hover:ring-1 hover:ring-border/60'
                }`}
              >
                <div
                  className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${card.accentClassName}`}
                />
                <CardContent className="relative p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        {card.label}
                      </p>
                      <p className="mt-3 font-display text-4xl uppercase tracking-[0.1em] text-foreground">
                        {card.count}
                      </p>
                    </div>
                    <div
                      className={`flex h-12 w-12 items-center justify-center rounded-2xl ${card.iconClassName}`}
                    >
                      <card.icon className="h-5 w-5" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
          );
        })}
      </section>

      {/* ── Bandeau de recherche pleine largeur ── */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          className="app-input h-10 w-full pl-10 text-sm"
          placeholder="Rechercher par code SAP, nom, identifiant PA, SIREN/SIRET, TVA…"
          value={inputValue}
          onChange={(e) => handleInput(e.target.value)}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-10" role="status" aria-label="Chargement…">
              <div
                className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                aria-hidden="true"
              />
            </div>
          ) : displayed.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {anomalyFilter
                ? 'Aucun fournisseur ne correspond à cette anomalie.'
                : search
                  ? `Aucun résultat pour « ${search} »`
                  : 'Aucun fournisseur en cache. Cliquez sur "Synchroniser depuis SAP".'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" aria-label="Liste des fournisseurs">
                <thead>
                  <tr>
                    {SUPPLIER_COLUMNS.map((c) => {
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
                    <th className="text-right">Actions</th>
                  </tr>
                  <tr className="bg-muted/20">
                    {SUPPLIER_COLUMNS.map((c) => (
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
                              list={`dl-${c.id}`}
                              value={columnFilters[c.id] ?? ''}
                              onChange={(e) =>
                                setColumnFilters((prev) => ({ ...prev, [c.id]: e.target.value }))
                              }
                            />
                            <datalist id={`dl-${c.id}`}>
                              {columnMode[c.id]?.values.map((v) => (
                                <option key={v} value={v} />
                              ))}
                            </datalist>
                          </>
                        )}
                      </th>
                    ))}
                    <th className="p-1 text-right">
                      {hasColumnFiltersOrSort && (
                        <button
                          type="button"
                          onClick={() => {
                            setColumnFilters({});
                            setSort(null);
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
                        colSpan={SUPPLIER_COLUMNS.length + 1}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Aucun fournisseur ne correspond aux filtres de colonne.
                      </td>
                    </tr>
                  )}
                  {rows.map((s) => {
                    const hasFiscalAnomaly = !s.federaltaxid || !s.taxId0 || !s.pa_identifier;
                    const isDuplicate = duplicateSet.has(s.cardcode);
                    return (
                      <tr key={s.id} className="transition-colors hover:bg-muted/20">
                        <td className="font-mono text-xs font-semibold">{s.cardcode}</td>
                        <td className="font-medium">{s.cardname}</td>
                        <td className="font-mono text-xs text-muted-foreground">
                          {s.pa_identifier || '—'}
                        </td>
                        <td className="font-mono text-xs text-muted-foreground">
                          {s.federaltaxid ?? '—'}
                        </td>
                        <td className="font-mono text-xs text-muted-foreground">
                          {s.taxId0 ? s.taxId0.slice(0, 9) : '—'}
                        </td>
                        <td className="font-mono text-xs text-muted-foreground">
                          {s.taxId0 ?? '—'}
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {[s.city, s.country].filter(Boolean).join(' / ') || '—'}
                        </td>
                        <td className="text-right font-mono text-xs text-muted-foreground">
                          {s.invoiceCount > 0 ? (
                            <span className="font-semibold text-foreground">{s.invoiceCount}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {formatDate(s.lastSyncAt)}
                        </td>
                        <td>
                          <div className="flex items-center gap-1.5">
                            {hasFiscalAnomaly && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setFiscalTarget(s)}
                              >
                                <Wrench className="h-3.5 w-3.5 mr-1" />
                                Corriger
                              </Button>
                            )}
                            {isDuplicate && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setMergeTarget(dupGroupByCardcode[s.cardcode] ?? [s])
                                }
                              >
                                <GitMerge className="h-3.5 w-3.5 mr-1" />
                                Rattacher
                              </Button>
                            )}
                            {!hasFiscalAnomaly && !isDuplicate && (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {showCreate && (
        <CreateSupplierModal
          initialValues={{ cardCode: nextSupplierCardCode(suppliers) }}
          onConfirm={handleCreateSupplier}
          onClose={() => setShowCreate(false)}
        />
      )}

      {fiscalTarget && (
        <FiscalCorrectionModal
          supplier={fiscalTarget}
          onClose={() => setFiscalTarget(null)}
          onSaved={() => {
            setFiscalTarget(null);
            void load(search);
          }}
        />
      )}

      {mergeTarget && (
        <MergeDuplicatesModal
          members={mergeTarget}
          onClose={() => setMergeTarget(null)}
          onMerged={() => {
            setMergeTarget(null);
            void load(search);
            void refreshMergesCount();
          }}
        />
      )}

      {showMerges && (
        <ActiveMergesModal
          onClose={() => setShowMerges(false)}
          onChanged={() => {
            void load(search);
            void refreshMergesCount();
          }}
        />
      )}
    </div>
  );
}
