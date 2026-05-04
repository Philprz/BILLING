import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  ArrowRight,
  XCircle,
  Radio,
  Clock,
  Activity,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import {
  apiGetInvoices,
  apiReEnrichAll,
  apiGetDailyStats,
  type DailyStatDay,
} from '../api/invoices.api';
import { apiGetWorkerStatus, type WorkerChannel } from '../api/worker-status.api';
import { apiGetAudit } from '../api/audit.api';
import { useAuth } from '../contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { DashboardSkeleton } from '../components/ui/skeleton';
import { toast } from '../lib/toast';
import { formatDate } from '../lib/utils';
import type { AuditEntry } from '../api/types';

interface Stats {
  total: number;
  toReview: number;
  ready: number;
  posted: number;
  error: number;
}

const ACTION_LABELS: Record<string, string> = {
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
  CONFIG_CHANGE: 'Config.',
};

function DailyBarChart({ days }: { days: DailyStatDay[] }) {
  const data = days.map((d) => ({
    date: d.date.slice(5), // "MM-DD"
    Reçues: d.received,
    Intégrées: d.posted,
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <CardTitle className="font-display text-base uppercase tracking-[0.08em]">
            Activité 30 derniers jours
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={6} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ fontSize: 11, borderRadius: 8 }}
              labelStyle={{ fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              dataKey="Reçues"
              fill="hsl(var(--primary) / 0.4)"
              radius={[3, 3, 0, 0]}
              maxBarSize={20}
            />
            <Bar
              dataKey="Intégrées"
              fill="hsl(var(--success) / 0.7)"
              radius={[3, 3, 0, 0]}
              maxBarSize={20}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'il y a < 1 min';
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

function WorkerStatusCard({ channels }: { channels: WorkerChannel[] }) {
  if (channels.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          <CardTitle className="font-display text-base uppercase tracking-[0.08em]">
            Canaux PA — statut worker
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/60">
          {channels.map((ch) => (
            <div key={ch.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`h-2 w-2 rounded-full flex-shrink-0 ${ch.active ? 'bg-success' : 'bg-muted-foreground/40'}`}
                />
                <span className="truncate text-sm font-medium text-foreground">{ch.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{ch.protocol}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                {ch.lastPollError ? (
                  <span className="text-destructive flex items-center gap-1">
                    <XCircle className="h-3 w-3" />
                    {ch.lastPollError.slice(0, 40)}
                  </span>
                ) : ch.lastPollAt ? (
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    {relativeTime(ch.lastPollAt)}
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Jamais interrogé
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [_reEnriching, setReEnriching] = useState(false);
  const [workerChannels, setWorkerChannels] = useState<WorkerChannel[]>([]);
  const [dailyDays, setDailyDays] = useState<DailyStatDay[]>([]);
  const [recentAudit, setRecentAudit] = useState<AuditEntry[]>([]);

  const loadStats = useCallback(async () => {
    setLoadError(null);
    try {
      const [all, toReview, ready, posted, error] = await Promise.all([
        apiGetInvoices({ limit: 1 }),
        apiGetInvoices({ limit: 1, status: 'TO_REVIEW' }),
        apiGetInvoices({ limit: 1, status: 'READY' }),
        apiGetInvoices({ limit: 1, status: 'POSTED' }),
        apiGetInvoices({ limit: 1, status: 'ERROR' }),
      ]);
      setStats({
        total: all.total,
        toReview: toReview.total,
        ready: ready.total,
        posted: posted.total,
        error: error.total,
      });
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Erreur de chargement');
    }
    apiGetWorkerStatus()
      .then((d) => setWorkerChannels(d.channels))
      .catch(() => {});
    apiGetDailyStats()
      .then((d) => setDailyDays(d.days))
      .catch(() => {});
    apiGetAudit({ limit: 5 })
      .then((d) => setRecentAudit(d.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  async function _handleReEnrichAll() {
    setReEnriching(true);
    try {
      const result = await apiReEnrichAll();
      toast.success(
        `${result.processed} facture${result.processed !== 1 ? 's' : ''} ré-analysée${result.processed !== 1 ? 's' : ''}${result.errors > 0 ? ` · ${result.errors} erreur(s)` : ''}`,
      );
      await loadStats();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la ré-analyse');
    } finally {
      setReEnriching(false);
    }
  }

  if (loadError) {
    return (
      <div className="app-page">
        <div className="alert-error">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          {loadError}
        </div>
      </div>
    );
  }

  if (!stats) return <DashboardSkeleton />;

  const statCards = [
    {
      label: 'Total factures',
      value: stats.total,
      icon: FileText,
      iconClassName: 'bg-primary/10 text-primary ring-1 ring-primary/20',
      accentClassName: 'from-primary/20 to-transparent',
      to: '/invoices?status=ALL',
      ariaLabel: `Total factures — ${stats.total} facture${stats.total !== 1 ? 's' : ''}. Voir la liste complète.`,
    },
    {
      label: 'À réviser',
      value: stats.toReview,
      icon: AlertCircle,
      iconClassName: 'bg-warning/10 text-warning ring-1 ring-warning/20',
      accentClassName: 'from-warning/20 to-transparent',
      to: '/invoices?status=TO_REVIEW',
      ariaLabel: `À réviser — ${stats.toReview} facture${stats.toReview !== 1 ? 's' : ''}. Voir les factures à réviser.`,
    },
    {
      label: 'Prêtes',
      value: stats.ready,
      icon: CheckCircle2,
      iconClassName: 'bg-secondary/20 text-secondary ring-1 ring-secondary/20',
      accentClassName: 'from-secondary/20 to-transparent',
      to: '/invoices?status=READY',
      ariaLabel: `Prêtes — ${stats.ready} facture${stats.ready !== 1 ? 's' : ''}. Voir les factures prêtes.`,
    },
    {
      label: 'En erreur',
      value: stats.error,
      icon: XCircle,
      iconClassName: 'bg-destructive/10 text-destructive ring-1 ring-destructive/20',
      accentClassName: 'from-destructive/20 to-transparent',
      to: '/invoices?status=ERROR',
      ariaLabel: `En erreur — ${stats.error} facture${stats.error !== 1 ? 's' : ''}. Voir les factures en erreur.`,
    },
  ];

  return (
    <div className="app-page">
      <section className="page-header">
        <div>
          <p className="page-subtitle">
            Connecté en tant que <span className="font-semibold text-foreground">{user?.user}</span>{' '}
            sur <span className="font-semibold text-foreground">{user?.companyDb}</span>.
          </p>
        </div>
      </section>

      {stats.error > 0 && (
        <div className="alert-error text-sm">
          <XCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            <strong>{stats.error}</strong> facture{stats.error !== 1 ? 's' : ''} en erreur SAP.
          </span>
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        {statCards.map((card) => (
          <Link
            key={card.label}
            to={card.to}
            aria-label={card.ariaLabel}
            className="block rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
          >
            <Card className="relative overflow-hidden cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-border/60">
              <div
                className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${card.accentClassName}`}
              />
              <CardContent className="relative p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                      {card.label}
                    </p>
                    <p className="mt-3 font-display text-4xl uppercase tracking-[0.1em] text-foreground">
                      {card.value}
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
          </Link>
        ))}
      </section>

      <WorkerStatusCard channels={workerChannels} />

      {dailyDays.length > 0 && <DailyBarChart days={dailyDays} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <CardTitle className="font-display text-base uppercase tracking-[0.08em]">
                Activité récente
              </CardTitle>
            </div>
            <Link
              to="/audit"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-primary/80"
            >
              Journal complet <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {recentAudit.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              Aucune action enregistrée pour l'instant.
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              {recentAudit.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-4 px-6 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${entry.outcome === 'OK' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}
                    >
                      {entry.outcome === 'OK' ? '✓' : '✗'}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </p>
                      {entry.sapUser && (
                        <p className="text-xs text-muted-foreground">{entry.sapUser}</p>
                      )}
                    </div>
                  </div>
                  <p className="flex-shrink-0 text-xs text-muted-foreground">
                    {formatDate(entry.occurredAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
