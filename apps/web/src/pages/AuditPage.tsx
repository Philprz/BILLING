import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { apiGetAudit, type GetAuditParams } from '../api/audit.api';
import type { AuditEntry, AuditAction, AuditOutcome } from '../api/types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { PageLoader } from '../components/ui/spinner';
import { formatDate } from '../lib/utils';

const ACTION_LABELS: Record<AuditAction, string> = {
  LOGIN:          'Connexion',
  LOGOUT:         'Déconnexion',
  FETCH_PA:       'Ingestion PA',
  VIEW_INVOICE:   'Consultation',
  EDIT_MAPPING:   'Modif. règle',
  APPROVE:        'Approbation',
  REJECT:         'Rejet',
  POST_SAP:       'Intégration SAP',
  SEND_STATUS_PA: 'Retour statut PA',
  SYSTEM_ERROR:   'Erreur système',
  CONFIG_CHANGE:  'Config. modifiée',
};

const ACTION_COLOR: Record<AuditAction, string> = {
  LOGIN:          'bg-blue-50 text-blue-700 border-blue-200',
  LOGOUT:         'bg-slate-50 text-slate-600 border-slate-200',
  FETCH_PA:       'bg-purple-50 text-purple-700 border-purple-200',
  VIEW_INVOICE:   'bg-slate-50 text-slate-600 border-slate-200',
  EDIT_MAPPING:   'bg-amber-50 text-amber-700 border-amber-200',
  APPROVE:        'bg-green-50 text-green-700 border-green-200',
  REJECT:         'bg-red-50 text-red-700 border-red-200',
  POST_SAP:       'bg-indigo-50 text-indigo-700 border-indigo-200',
  SEND_STATUS_PA: 'bg-teal-50 text-teal-700 border-teal-200',
  SYSTEM_ERROR:   'bg-red-50 text-red-700 border-red-200',
  CONFIG_CHANGE:  'bg-orange-50 text-orange-700 border-orange-200',
};

const AUDIT_ACTIONS: AuditAction[] = [
  'LOGIN', 'LOGOUT', 'FETCH_PA', 'VIEW_INVOICE', 'EDIT_MAPPING',
  'APPROVE', 'REJECT', 'POST_SAP', 'SEND_STATUS_PA', 'SYSTEM_ERROR', 'CONFIG_CHANGE',
];

function ActionBadge({ action }: { action: AuditAction }) {
  return (
    <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded border ${ACTION_COLOR[action] ?? 'bg-muted text-muted-foreground border-border'}`}>
      {ACTION_LABELS[action] ?? action}
    </span>
  );
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal]     = useState(0);

  const [filterAction,  setFilterAction]  = useState<AuditAction | ''>('');
  const [filterOutcome, setFilterOutcome] = useState<AuditOutcome | ''>('');
  const [filterEntity,  setFilterEntity]  = useState('');

  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: GetAuditParams = { page, limit: LIMIT };
      if (filterAction)  params.action   = filterAction;
      if (filterOutcome) params.outcome  = filterOutcome;
      if (filterEntity)  params.entityId = filterEntity;
      const result = await apiGetAudit(params);
      setEntries(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [page, filterAction, filterOutcome, filterEntity]);

  useEffect(() => { void load(); }, [load]);

  function applyFilters() {
    setPage(1);
    void load();
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Journal d'audit</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{total} entrée{total !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Filtres */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Filter className="h-4 w-4" /> Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Action</label>
              <select
                className="text-xs border rounded-md px-2 py-1.5 bg-background w-44"
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value as AuditAction | '')}
              >
                <option value="">Toutes</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Résultat</label>
              <select
                className="text-xs border rounded-md px-2 py-1.5 bg-background w-32"
                value={filterOutcome}
                onChange={(e) => setFilterOutcome(e.target.value as AuditOutcome | '')}
              >
                <option value="">Tous</option>
                <option value="OK">OK</option>
                <option value="ERROR">Erreur</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Entité (UUID / ID)</label>
              <input
                type="text"
                className="text-xs border rounded-md px-2 py-1.5 bg-background w-64 font-mono"
                placeholder="ex. 3f2504e0-4f89-..."
                value={filterEntity}
                onChange={(e) => setFilterEntity(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
              />
            </div>
            <button
              className="text-xs px-3 py-1.5 rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={applyFilters}
            >
              Appliquer
            </button>
            <button
              className="text-xs px-3 py-1.5 rounded-md border hover:bg-muted"
              onClick={() => { setFilterAction(''); setFilterOutcome(''); setFilterEntity(''); setPage(1); }}
            >
              Réinitialiser
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        {loading ? (
          <PageLoader />
        ) : entries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Aucune entrée d'audit.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Action</th>
                  <th className="text-left px-3 py-2 font-medium">Utilisateur</th>
                  <th className="text-left px-3 py-2 font-medium">Entité</th>
                  <th className="text-left px-3 py-2 font-medium">Résultat</th>
                  <th className="text-left px-3 py-2 font-medium">Détail</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => (
                  <tr key={e.id} className={`hover:bg-muted/20 ${e.outcome === 'ERROR' ? 'bg-red-50/40' : ''}`}>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap font-mono">
                      {formatDate(e.occurredAt)}
                    </td>
                    <td className="px-3 py-2">
                      <ActionBadge action={e.action} />
                    </td>
                    <td className="px-3 py-2 text-xs">{e.sapUser ?? <span className="text-muted-foreground">système</span>}</td>
                    <td className="px-3 py-2 text-xs font-mono">
                      {e.entityId
                        ? e.entityType === 'INVOICE'
                          ? <Link to={`/invoices/${e.entityId}`} className="text-primary hover:underline truncate block max-w-[120px]" title={e.entityId}>{e.entityId.slice(0, 8)}…</Link>
                          : <span className="text-muted-foreground truncate block max-w-[120px]" title={e.entityId}>{e.entityId.slice(0, 8)}…</span>
                        : <span className="text-muted-foreground">—</span>
                      }
                    </td>
                    <td className="px-3 py-2">
                      {e.outcome === 'OK'
                        ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                        : <XCircle className="h-4 w-4 text-destructive" />
                      }
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[280px]">
                      <div className="space-y-1">
                        <p className={e.outcome === 'ERROR' ? 'text-destructive line-clamp-2' : 'line-clamp-2 text-foreground'}>
                          {e.summary}
                        </p>
                        {(Boolean(e.payloadBefore) || Boolean(e.payloadAfter)) && (
                          <details className="text-[10px] font-mono">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                              Voir les détails
                            </summary>
                            <div className="mt-1 rounded border bg-muted/30 p-2 space-y-2">
                              {Boolean(e.payloadBefore) && (
                                <div>
                                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Avant</p>
                                  <pre className="whitespace-pre-wrap break-words">{String(JSON.stringify(e.payloadBefore, null, 2))}</pre>
                                </div>
                              )}
                              {Boolean(e.payloadAfter) && (
                                <div>
                                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Après</p>
                                  <pre className="whitespace-pre-wrap break-words">{String(JSON.stringify(e.payloadAfter, null, 2))}</pre>
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-xs text-muted-foreground">
            <span>Page {page} / {totalPages}</span>
            <div className="flex gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="p-1 rounded hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="p-1 rounded hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
