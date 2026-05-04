import { useEffect, useState, useCallback, useRef } from 'react';
import { Building2, Search, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  apiGetSuppliers,
  apiGetSuppliersSyncStatus,
  apiSyncSuppliers,
  type SupplierCache,
  type SupplierSyncStatus,
  type SupplierSyncResult,
} from '../api/suppliers.api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { formatDate } from '../lib/utils';

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    load(search);
  }, [load, search]);

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
        <Button onClick={handleSync} disabled={syncing} size="sm">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Synchronisation…' : 'Synchroniser depuis SAP'}
        </Button>
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center justify-between gap-4">
            <span className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Cache fournisseurs
            </span>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className="app-input h-9 pl-9 text-xs w-64 font-normal"
                placeholder="Rechercher par code SAP, nom, identifiant PA, SIREN/SIRET, TVA…"
                value={inputValue}
                onChange={(e) => handleInput(e.target.value)}
              />
            </div>
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
          ) : suppliers.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {search
                ? `Aucun résultat pour « ${search} »`
                : 'Aucun fournisseur en cache. Cliquez sur "Synchroniser depuis SAP".'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" aria-label="Liste des fournisseurs">
                <thead>
                  <tr>
                    <th>Code fournisseur SAP</th>
                    <th>Nom fournisseur</th>
                    <th>Identifiant fournisseur PA</th>
                    <th>TVA intracommunautaire</th>
                    <th>SIREN</th>
                    <th>SIRET</th>
                    <th>Ville / Pays</th>
                    <th className="text-right">Nb factures</th>
                    <th>Dernière synchronisation SAP</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.id} className="transition-colors hover:bg-muted/20">
                      <td className="font-mono text-xs font-semibold">{s.cardcode}</td>
                      <td className="font-medium">{s.cardname}</td>
                      <td className="font-mono text-xs text-muted-foreground">
                        {s.pa_identifier || '—'}
                      </td>
                      <td className="font-mono text-xs text-muted-foreground">
                        {s.federaltaxid ?? '—'}
                      </td>
                      <td className="font-mono text-xs text-muted-foreground">{s.taxId0 ?? '—'}</td>
                      <td className="font-mono text-xs text-muted-foreground">{s.taxId1 ?? '—'}</td>
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
                      <td className="text-xs text-muted-foreground">{formatDate(s.lastSyncAt)}</td>
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
