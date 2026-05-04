import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { apiGetAudit, type GetAuditParams } from '../api/audit.api';
import type { AuditEntry, AuditAction, AuditOutcome } from '../api/types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { PageLoader } from '../components/ui/spinner';
import { formatDate } from '../lib/utils';

const ACTION_LABELS: Record<AuditAction, string> = {
  LOGIN: 'Connexion',
  LOGOUT: 'Déconnexion',
  FETCH_PA: 'Ingestion PA',
  VIEW_INVOICE: 'Consultation',
  EDIT_MAPPING: 'Modif. règle',
  APPROVE: 'Approbation',
  REJECT: 'Rejet',
  POST_SAP: 'Intégration SAP',
  SEND_STATUS_PA: 'Retour statut PA',
  SYSTEM_ERROR: 'Erreur système',
  CONFIG_CHANGE: 'Config. modifiée',
  CREATE_SUPPLIER: 'Création fournisseur',
  SYNC_SUPPLIERS: 'Sync fournisseurs',
  LINK_SAP: 'Rattachement SAP',
};

const ACTION_COLOR: Record<AuditAction, string> = {
  LOGIN: 'border-primary/25 bg-primary/10 text-primary',
  LOGOUT: 'border-border bg-muted/60 text-muted-foreground',
  FETCH_PA: 'border-secondary/25 bg-secondary/10 text-secondary',
  VIEW_INVOICE: 'border-border bg-muted/60 text-muted-foreground',
  EDIT_MAPPING: 'border-warning/25 bg-warning/10 text-warning',
  APPROVE: 'border-success/25 bg-success/10 text-success',
  REJECT: 'border-destructive/25 bg-destructive/10 text-destructive',
  POST_SAP: 'border-info/25 bg-info/10 text-info',
  SEND_STATUS_PA: 'border-info/25 bg-info/10 text-info',
  SYSTEM_ERROR: 'border-destructive/25 bg-destructive/10 text-destructive',
  CONFIG_CHANGE: 'border-warning/25 bg-warning/10 text-warning',
  CREATE_SUPPLIER: 'border-success/25 bg-success/10 text-success',
  SYNC_SUPPLIERS: 'border-primary/25 bg-primary/10 text-primary',
  LINK_SAP: 'border-info/25 bg-info/10 text-info',
};

const AUDIT_ACTIONS: AuditAction[] = [
  'LOGIN',
  'LOGOUT',
  'FETCH_PA',
  'VIEW_INVOICE',
  'EDIT_MAPPING',
  'APPROVE',
  'REJECT',
  'POST_SAP',
  'SEND_STATUS_PA',
  'SYSTEM_ERROR',
  'CONFIG_CHANGE',
  'CREATE_SUPPLIER',
  'SYNC_SUPPLIERS',
  'LINK_SAP',
];

function ActionBadge({ action }: { action: AuditAction }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${ACTION_COLOR[action]}`}
    >
      {ACTION_LABELS[action]}
    </span>
  );
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [filterAction, setFilterAction] = useState<AuditAction | ''>('');
  const [filterOutcome, setFilterOutcome] = useState<AuditOutcome | ''>('');
  const [filterEntity, setFilterEntity] = useState('');

  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: GetAuditParams = { page, limit: LIMIT };
      if (filterAction) params.action = filterAction;
      if (filterOutcome) params.outcome = filterOutcome;
      if (filterEntity) params.entityId = filterEntity;
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

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters() {
    setPage(1);
    void load();
  }

  return (
    <div className="app-page">
      <section className="page-header">
        <div>
          <p className="page-eyebrow">Traçabilité</p>
          <h2 className="page-title">Journal d’audit</h2>
          <p className="page-subtitle">
            Historique opérationnel des actions utilisateurs et systèmes. Les états OK / erreur
            restent immédiatement repérables sans sacrifier la densité métier.
          </p>
        </div>
        <div className="rounded-2xl border border-border/80 bg-card-muted/70 px-4 py-3 text-right shadow-soft">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Entrées</p>
          <p className="font-display text-2xl uppercase tracking-[0.1em] text-foreground">
            {total}
          </p>
        </div>
      </section>

      <Card className="panel-surface-muted">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-[0.16em] text-muted-foreground">
            <Filter className="h-4 w-4 text-primary" />
            Filtres
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 xl:grid-cols-[220px_180px_minmax(0,1fr)_auto_auto] xl:items-end">
            <Select
              label="Action"
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value as AuditAction | '')}
            >
              <option value="">Toutes</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </Select>

            <Select
              label="Résultat"
              value={filterOutcome}
              onChange={(e) => setFilterOutcome(e.target.value as AuditOutcome | '')}
            >
              <option value="">Tous</option>
              <option value="OK">OK</option>
              <option value="ERROR">Erreur</option>
            </Select>

            <Input
              label="Entité (UUID / ID)"
              type="text"
              className="font-mono"
              placeholder="ex. 3f2504e0-4f89-..."
              value={filterEntity}
              onChange={(e) => setFilterEntity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
            />

            <Button onClick={applyFilters}>Appliquer</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFilterAction('');
                setFilterOutcome('');
                setFilterEntity('');
                setPage(1);
              }}
            >
              Réinitialiser
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        {loading ? (
          <PageLoader />
        ) : entries.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            Aucune entrée d’audit.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Utilisateur</th>
                  <th>Entité</th>
                  <th>Résultat</th>
                  <th>Détail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className={entry.outcome === 'ERROR' ? 'bg-destructive/5' : ''}
                  >
                    <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {formatDate(entry.occurredAt)}
                    </td>
                    <td>
                      <ActionBadge action={entry.action} />
                    </td>
                    <td className="text-xs text-foreground">
                      {entry.sapUser ?? <span className="text-muted-foreground">système</span>}
                    </td>
                    <td className="font-mono text-xs">
                      {entry.entityId ? (
                        entry.entityType === 'INVOICE' ? (
                          <Link
                            to={`/invoices/${entry.entityId}`}
                            className="block max-w-[140px] truncate text-primary transition-colors hover:text-primary/80"
                            title={entry.entityId}
                          >
                            {entry.entityId.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span
                            className="block max-w-[140px] truncate text-muted-foreground"
                            title={entry.entityId}
                          >
                            {entry.entityId.slice(0, 8)}…
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td>
                      {entry.outcome === 'OK' ? (
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                    </td>
                    <td className="max-w-[320px] text-xs text-muted-foreground">
                      <div className="space-y-1">
                        <p
                          className={
                            entry.outcome === 'ERROR'
                              ? 'line-clamp-2 text-destructive'
                              : 'line-clamp-2 text-foreground'
                          }
                        >
                          {entry.summary}
                        </p>
                        {(Boolean(entry.payloadBefore) || Boolean(entry.payloadAfter)) && (
                          <details className="font-mono text-[10px]">
                            <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">
                              Voir les détails
                            </summary>
                            <div className="mt-2 rounded-2xl border border-border/70 bg-card-muted/60 p-3">
                              {Boolean(entry.payloadBefore) && (
                                <div className="mb-3">
                                  <p className="mb-1 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                                    Avant
                                  </p>
                                  <pre className="whitespace-pre-wrap break-words">
                                    {String(JSON.stringify(entry.payloadBefore, null, 2))}
                                  </pre>
                                </div>
                              )}
                              {Boolean(entry.payloadAfter) && (
                                <div>
                                  <p className="mb-1 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                                    Après
                                  </p>
                                  <pre className="whitespace-pre-wrap break-words">
                                    {String(JSON.stringify(entry.payloadAfter, null, 2))}
                                  </pre>
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">
            <span>
              Page {page} / {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
