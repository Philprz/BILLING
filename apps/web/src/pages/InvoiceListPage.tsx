import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  RotateCcw,
  Upload,
  Download,
  Send,
  HelpCircle,
} from 'lucide-react';
import { apiGetInvoices, apiBulkPost, apiBulkSendStatus } from '../api/invoices.api';
import { apiUploadInvoice } from '../api/upload.api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { StatusBadge } from '../components/ui/badge';
import { InvoiceListSkeleton } from '../components/ui/skeleton';
import { toast } from '../lib/toast';
import { formatAmount, formatDate } from '../lib/utils';
import type { InvoiceSummary, InvoiceStatus } from '../api/types';

const STATUS_OPTIONS: { value: InvoiceStatus | ''; label: string }[] = [
  { value: '', label: 'Tous les statuts' },
  { value: 'NEW', label: 'Nouvelles' },
  { value: 'TO_REVIEW', label: 'A reviser' },
  { value: 'READY', label: 'Pretes' },
  { value: 'POSTED', label: 'Integrees' },
  { value: 'REJECTED', label: 'Rejetees' },
  { value: 'ERROR', label: 'Erreur' },
];

const PAGE_SIZE = 20;

const DIRECTION_OPTIONS = [
  { value: '', label: 'Toutes directions' },
  { value: 'INVOICE', label: 'Factures' },
  { value: 'CREDIT_NOTE', label: 'Avoirs' },
];

export default function InvoiceListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);

  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPosting, setBulkPosting] = useState(false);
  const [bulkSendingStatus, setBulkSendingStatus] = useState(false);

  // Keyboard help
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const page = Number(searchParams.get('page') ?? 1);
  const status = (searchParams.get('status') ?? '') as InvoiceStatus | '';
  const search = searchParams.get('search') ?? '';
  const direction = (searchParams.get('direction') ?? '') as 'INVOICE' | 'CREDIT_NOTE' | '';
  const paSource = searchParams.get('paSource') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const amountMin = searchParams.get('amountMin')
    ? Number(searchParams.get('amountMin'))
    : undefined;
  const amountMax = searchParams.get('amountMax')
    ? Number(searchParams.get('amountMax'))
    : undefined;

  const [searchInput, setSearchInput] = useState(search);
  const [amountMinInput, setAmountMinInput] = useState(searchParams.get('amountMin') ?? '');
  const [amountMaxInput, setAmountMaxInput] = useState(searchParams.get('amountMax') ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const result = await apiGetInvoices({
        page,
        limit: PAGE_SIZE,
        status: status || undefined,
        search: search || undefined,
        direction: direction || undefined,
        paSource: paSource || undefined,
        amountMin,
        amountMax,
        sortBy: 'receivedAt',
        sortDir: 'desc',
      });
      setInvoices(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setHighlightedIndex(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [page, status, search, direction, paSource, amountMin, amountMax]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) next.set(key, value);
      else next.delete(key);
    });
    if (!('page' in updates)) next.delete('page');
    setSearchParams(next);
  };

  const hasFilters = !!(
    status ||
    search ||
    direction ||
    paSource ||
    dateFrom ||
    dateTo ||
    amountMin !== undefined ||
    amountMax !== undefined
  );

  const clearAll = () => {
    setSearchInput('');
    setAmountMinInput('');
    setAmountMaxInput('');
    updateParams({
      status: '',
      search: '',
      direction: '',
      paSource: '',
      dateFrom: '',
      dateTo: '',
      amountMin: '',
      amountMax: '',
    });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ search: searchInput });
  };

  const handleAmountFilter = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ amountMin: amountMinInput, amountMax: amountMaxInput });
  };

  const buildExportUrl = () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    if (direction) params.set('direction', direction);
    if (paSource) params.set('paSource', paSource);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (amountMin !== undefined) params.set('amountMin', String(amountMin));
    if (amountMax !== undefined) params.set('amountMax', String(amountMax));
    const qs = params.toString();
    return `/api/invoices/export.csv${qs ? `?${qs}` : ''}`;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const result = await apiUploadInvoice(file);
      if (result.created) {
        toast.success(`Facture importée (${result.invoiceId.slice(0, 8)}…)`);
        void load();
      } else {
        toast.info('Facture déjà existante — doublon ignoré');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec import');
    } finally {
      setUploading(false);
    }
  };

  const handleBulkPost = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkPosting(true);
    try {
      const result = await apiBulkPost(ids);
      if (result.failed === 0) {
        toast.success(
          `${result.succeeded} facture${result.succeeded !== 1 ? 's' : ''} intégrée${result.succeeded !== 1 ? 's' : ''}`,
        );
      } else {
        toast.error(`${result.succeeded} intégrée(s) · ${result.failed} échec(s)`);
      }
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBulkPosting(false);
    }
  };

  const handleBulkSendStatus = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkSendingStatus(true);
    try {
      const result = await apiBulkSendStatus(ids);
      if (result.failed === 0) {
        toast.success(
          `Statut PA renvoyé pour ${result.succeeded} facture${result.succeeded !== 1 ? 's' : ''}`,
        );
      } else {
        toast.error(`${result.succeeded} envoyé(s) · ${result.failed} échec(s)`);
      }
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBulkSendingStatus(false);
    }
  };

  const selectedReadyIds = [...selectedIds].filter(
    (id) => invoices.find((i) => i.id === id)?.status === 'READY',
  );
  const selectedPostedIds = [...selectedIds].filter((id) =>
    invoices.find((i) => i.id === id && ['POSTED', 'REJECTED'].includes(i.status)),
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).matches('input,textarea,select')) return;
      if (e.key === '/' || e.key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === '?') {
        e.preventDefault();
        setShowKeyHelp((v) => !v);
      }
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, invoices.length - 1));
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter' && highlightedIndex >= 0 && invoices[highlightedIndex]) {
        navigate(`/invoices/${invoices[highlightedIndex].id}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [invoices, highlightedIndex, navigate]);

  return (
    <div className="app-page">
      <section className="page-header">
        <div>
          <p className="page-eyebrow">Pilotage</p>
          <h2 className="page-title">Liste des factures</h2>
          <p className="page-subtitle">
            Recherche, filtrage et consultation detaillee des documents recus.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!loading && (
            <div className="rounded-2xl border border-border/80 bg-card-muted/70 px-4 py-3 text-right shadow-soft">
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Volume</p>
              <p className="font-display text-2xl uppercase tracking-[0.1em] text-foreground">
                {total}
              </p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.pdf"
            className="hidden"
            onChange={(e) => {
              void handleFileChange(e);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Import…' : 'Importer'}
          </Button>
          <a href={buildExportUrl()} download="factures.csv">
            <Button variant="outline" size="sm" type="button">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </a>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowKeyHelp(true)}
            title="Raccourcis clavier"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Keyboard help modal */}
      {showKeyHelp && (
        <div className="modal-backdrop" onClick={() => setShowKeyHelp(false)}>
          <div className="modal-panel max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-xl uppercase tracking-[0.08em]">Raccourcis clavier</h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/60">
                {[
                  ['J / ↓', 'Ligne suivante'],
                  ['K / ↑', 'Ligne précédente'],
                  ['Entrée', 'Ouvrir la facture sélectionnée'],
                  ['/ ou F', 'Focus sur la recherche'],
                  ['?', 'Afficher / masquer cette aide'],
                ].map(([key, desc]) => (
                  <tr key={key}>
                    <td className="py-2 pr-4">
                      <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs">
                        {key}
                      </kbd>
                    </td>
                    <td className="py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setShowKeyHelp(false)}
            >
              Fermer
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <section className="panel-surface-muted p-4">
        <div className="grid gap-3">
          {/* Row 1: search + status + direction + clear */}
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_180px_180px_auto] xl:items-end">
            <form onSubmit={handleSearch} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                ref={searchRef}
                placeholder="Fournisseur, numero de document..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <Button type="submit" variant="outline">
                <Search className="h-4 w-4" />
                Rechercher
              </Button>
            </form>
            <Select value={status} onChange={(e) => updateParams({ status: e.target.value })}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select value={direction} onChange={(e) => updateParams({ direction: e.target.value })}>
              {DIRECTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {hasFilters && (
              <Button variant="ghost" onClick={clearAll}>
                <RotateCcw className="h-4 w-4" />
                Reinitialiser
              </Button>
            )}
          </div>

          {/* Row 2: canal PA + date range */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Canal PA :</span>
              <input
                className="app-input h-8 w-36 text-xs"
                placeholder="ex: CHORUS"
                value={paSource}
                onChange={(e) => updateParams({ paSource: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Période :</span>
              <input
                type="date"
                className="app-input h-8 text-xs"
                value={dateFrom}
                onChange={(e) => updateParams({ dateFrom: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">—</span>
              <input
                type="date"
                className="app-input h-8 text-xs"
                value={dateTo}
                onChange={(e) => updateParams({ dateTo: e.target.value })}
              />
            </div>
          </div>

          {/* Row 3: amount filter */}
          <form onSubmit={handleAmountFilter} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Montant TTC :</span>
            <Input
              className="h-8 w-28 text-xs"
              placeholder="Min €"
              value={amountMinInput}
              onChange={(e) => setAmountMinInput(e.target.value)}
              type="number"
              min={0}
              step={0.01}
            />
            <span className="text-xs text-muted-foreground">—</span>
            <Input
              className="h-8 w-28 text-xs"
              placeholder="Max €"
              value={amountMaxInput}
              onChange={(e) => setAmountMaxInput(e.target.value)}
              type="number"
              min={0}
              step={0.01}
            />
            <Button type="submit" variant="outline" size="sm" className="h-8 text-xs px-3">
              Filtrer
            </Button>
          </form>
        </div>
      </section>

      {error && (
        <div className="alert-error">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-2.5">
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} facture(s) sélectionnée(s)
          </span>
          {selectedReadyIds.length > 0 && (
            <Button
              size="sm"
              onClick={() => {
                void handleBulkPost();
              }}
              disabled={bulkPosting}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              {bulkPosting ? 'Intégration…' : `Valider SAP (${selectedReadyIds.length})`}
            </Button>
          )}
          {selectedPostedIds.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void handleBulkSendStatus();
              }}
              disabled={bulkSendingStatus}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              {bulkSendingStatus ? 'Envoi…' : `Relancer statut PA (${selectedPostedIds.length})`}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Désélectionner
          </Button>
        </div>
      )}

      <section className="data-table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={
                    invoices.length > 0 &&
                    invoices
                      .filter((i) => ['READY', 'POSTED', 'REJECTED'].includes(i.status))
                      .every((i) => selectedIds.has(i.id))
                  }
                  onChange={(e) => {
                    const selectableIds = invoices
                      .filter((i) => ['READY', 'POSTED', 'REJECTED'].includes(i.status))
                      .map((i) => i.id);
                    setSelectedIds(e.target.checked ? new Set(selectableIds) : new Set());
                  }}
                />
              </th>
              <th>Date</th>
              <th>Fournisseur</th>
              <th>N° document</th>
              <th>Source</th>
              <th className="text-right">Montant TTC</th>
              <th className="text-center">Statut</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-0">
                  <InvoiceListSkeleton />
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                  Aucune facture trouvee.
                </td>
              </tr>
            ) : (
              invoices.map((invoice, index) => (
                <tr
                  key={invoice.id}
                  onClick={() => navigate(`/invoices/${invoice.id}`)}
                  className={`data-row-interactive ${highlightedIndex === index ? 'bg-primary/5 ring-1 ring-inset ring-primary/20' : ''}`}
                >
                  <td onClick={(e) => e.stopPropagation()} className="w-8">
                    {['READY', 'POSTED', 'REJECTED'].includes(invoice.status) && (
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={selectedIds.has(invoice.id)}
                        onChange={(e) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) {
                              next.add(invoice.id);
                            } else {
                              next.delete(invoice.id);
                            }
                            return next;
                          });
                        }}
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap text-muted-foreground">
                    {formatDate(invoice.docDate)}
                  </td>
                  <td className="max-w-[260px]">
                    <p className="truncate font-semibold text-foreground">
                      {invoice.supplierNameRaw}
                    </p>
                    {invoice.supplierB1Cardcode && (
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {invoice.supplierB1Cardcode}
                      </p>
                    )}
                  </td>
                  <td className="font-mono text-xs text-muted-foreground">{invoice.docNumberPa}</td>
                  <td className="text-muted-foreground">{invoice.paSource}</td>
                  <td className="whitespace-nowrap text-right font-semibold text-foreground">
                    {formatAmount(invoice.totalInclTax, invoice.currency)}
                  </td>
                  <td className="text-center">
                    <StatusBadge status={invoice.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {totalPages > 1 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} sur {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) })}
            >
              <ChevronLeft className="h-4 w-4" /> Precedent
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) })}
            >
              Suivant <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
