import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiListChartOfAccounts, apiSyncSapChartOfAccounts, type SapAccount } from '../api/sap.api';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Button } from '../components/ui/button';

export default function ChartOfAccountsPage() {
  const [allAccounts, setAllAccounts] = useState<SapAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [codeFilter, setCodeFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiListChartOfAccounts();
      setAllAccounts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSync() {
    setSyncing(true);
    setSyncInfo(null);
    setSyncError(null);
    try {
      const result = await apiSyncSapChartOfAccounts();
      setSyncInfo(
        `Synchronisation terminée — ${result.activePostable} comptes actifs imputables importés.`,
      );
      await load();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Erreur de synchronisation');
    } finally {
      setSyncing(false);
    }
  }

  const filtered = allAccounts.filter((a) => {
    const codeOk = codeFilter === '' || a.acctCode.startsWith(codeFilter);
    const nameOk = nameFilter === '' || a.acctName.toLowerCase().includes(nameFilter.toLowerCase());
    return codeOk && nameOk;
  });

  const hasFilter = codeFilter !== '' || nameFilter !== '';

  return (
    <div className="app-page">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Référentiel</p>
          <p className="page-subtitle">
            {allAccounts.length} compte{allAccounts.length !== 1 ? 's' : ''} en cache local
          </p>
        </div>
        <Button onClick={handleSync} disabled={syncing} size="sm">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Synchronisation…' : 'Synchroniser depuis SAP'}
        </Button>
      </div>

      {syncInfo && (
        <div className="alert-info text-sm">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          {syncInfo}
        </div>
      )}
      {syncError && (
        <div className="alert-error text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {syncError}
        </div>
      )}
      {error && (
        <div className="alert-error text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className="app-input h-9 pl-9 text-xs font-mono w-full"
                placeholder="N° compte (commence par…)"
                value={codeFilter}
                onChange={(e) => setCodeFilter(e.target.value.trim())}
              />
            </div>
            <div className="relative flex-1 max-w-[280px]">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className="app-input h-9 pl-9 text-xs w-full"
                placeholder="Intitulé (contient…)"
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
              />
            </div>
            {hasFilter && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {filtered.length} résultat{filtered.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-10" role="status" aria-label="Chargement…">
              <div
                className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                aria-hidden="true"
              />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {hasFilter
                ? 'Aucun compte ne correspond aux filtres.'
                : 'Aucun compte en cache. Cliquez sur "Synchroniser depuis SAP".'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" aria-label="Plan comptable SAP">
                <thead>
                  <tr>
                    <th>N° compte</th>
                    <th>Intitulé</th>
                    <th className="text-center">Imputable</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.acctCode} className="transition-colors hover:bg-muted/20">
                      <td className="font-mono text-xs font-semibold">{a.acctCode}</td>
                      <td className="font-medium">{a.acctName}</td>
                      <td className="text-center">
                        {a.postable ? (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                            title="Imputable"
                          />
                        ) : (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30"
                            title="Non imputable"
                          />
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
