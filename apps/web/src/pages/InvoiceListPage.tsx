import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { apiGetInvoices } from '../api/invoices.api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { StatusBadge } from '../components/ui/badge';
import { formatAmount, formatDate } from '../lib/utils';
import type { InvoiceSummary, InvoiceStatus } from '../api/types';

const STATUS_OPTIONS: { value: InvoiceStatus | ''; label: string }[] = [
  { value: '', label: 'Tous les statuts' },
  { value: 'NEW', label: 'Nouvelles' },
  { value: 'TO_REVIEW', label: 'À réviser' },
  { value: 'READY', label: 'Prêtes' },
  { value: 'POSTED', label: 'Intégrées' },
  { value: 'REJECTED', label: 'Rejetées' },
  { value: 'ERROR', label: 'Erreur' },
];

const PAGE_SIZE = 20;

export default function InvoiceListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters from URL params
  const page = Number(searchParams.get('page') ?? 1);
  const status = (searchParams.get('status') ?? '') as InvoiceStatus | '';
  const search = searchParams.get('search') ?? '';
  const [searchInput, setSearchInput] = useState(search);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGetInvoices({
        page,
        limit: PAGE_SIZE,
        status: status || undefined,
        search: search || undefined,
        sortBy: 'receivedAt',
        sortDir: 'desc',
      });
      setInvoices(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => { load(); }, [load]);

  const updateParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([k, v]) => {
      if (v) next.set(k, v); else next.delete(k);
    });
    if (!('page' in updates)) next.delete('page'); // reset page on filter change
    setSearchParams(next);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ search: searchInput });
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Factures</h1>
          {!loading && <p className="text-sm text-muted-foreground mt-0.5">{total} document{total > 1 ? 's' : ''}</p>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <form onSubmit={handleSearch} className="flex gap-2 items-end">
          <Input
            placeholder="Fournisseur, N° document…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-64"
          />
          <Button type="submit" variant="outline" size="sm">
            <Search className="h-4 w-4" />
          </Button>
        </form>

        <Select
          value={status}
          onChange={(e) => updateParams({ status: e.target.value })}
          className="w-48"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>

        {(status || search) && (
          <Button variant="ghost" size="sm" onClick={() => { setSearchInput(''); updateParams({ status: '', search: '' }); }}>
            Réinitialiser
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Fournisseur</th>
              <th className="text-left px-4 py-3 font-medium">N° document</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
              <th className="text-right px-4 py-3 font-medium">Montant TTC</th>
              <th className="text-center px-4 py-3 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={6} className="py-16 text-center">
                  <div className="flex justify-center"><div className="animate-spin h-5 w-5 rounded-full border-2 border-primary border-t-transparent" /></div>
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-16 text-center text-muted-foreground">
                  Aucune facture trouvée.
                </td>
              </tr>
            ) : (
              invoices.map((inv) => (
                <tr
                  key={inv.id}
                  onClick={() => navigate(`/invoices/${inv.id}`)}
                  className="cursor-pointer hover:bg-muted/40 transition-colors"
                >
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(inv.docDate)}</td>
                  <td className="px-4 py-3 max-w-[220px]">
                    <p className="font-medium truncate">{inv.supplierNameRaw}</p>
                    {inv.supplierB1Cardcode && (
                      <p className="text-xs text-muted-foreground">{inv.supplierB1Cardcode}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{inv.docNumberPa}</td>
                  <td className="px-4 py-3 text-muted-foreground">{inv.paSource}</td>
                  <td className="px-4 py-3 text-right font-medium whitespace-nowrap">
                    {formatAmount(inv.totalInclTax, inv.currency)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={inv.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
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
              <ChevronLeft className="h-4 w-4" />
              Précédent
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) })}
            >
              Suivant
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
