import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, AlertCircle, CheckCircle2, TrendingUp, ArrowRight } from 'lucide-react';
import { apiGetInvoices } from '../api/invoices.api';
import { useAuth } from '../contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { StatusBadge } from '../components/ui/badge';
import { PageLoader } from '../components/ui/spinner';
import { formatAmount, formatDate } from '../lib/utils';
import type { InvoiceSummary } from '../api/types';

interface Stats {
  total: number;
  toReview: number;
  ready: number;
  posted: number;
  recent: InvoiceSummary[];
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiGetInvoices({ limit: 1 }),
      apiGetInvoices({ limit: 1, status: 'TO_REVIEW' }),
      apiGetInvoices({ limit: 1, status: 'READY' }),
      apiGetInvoices({ limit: 1, status: 'POSTED' }),
      apiGetInvoices({ limit: 5, sortBy: 'receivedAt', sortDir: 'desc' }),
    ])
      .then(([all, toReview, ready, posted, recent]) => {
        setStats({
          total: all.total,
          toReview: toReview.total,
          ready: ready.total,
          posted: posted.total,
          recent: recent.items,
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erreur de chargement'));
  }, []);

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      </div>
    );
  }

  if (!stats) return <PageLoader />;

  const STAT_CARDS = [
    { label: 'Total factures', value: stats.total, icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'À réviser', value: stats.toReview, icon: AlertCircle, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Prêtes', value: stats.ready, icon: CheckCircle2, color: 'text-indigo-600', bg: 'bg-indigo-50' },
    { label: 'Intégrées SAP', value: stats.posted, icon: TrendingUp, color: 'text-green-600', bg: 'bg-green-50' },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tableau de bord</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connecté en tant que <span className="font-medium">{user?.user}</span> sur <span className="font-medium">{user?.companyDb}</span>
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STAT_CARDS.map((card) => (
          <Card key={card.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{card.label}</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{card.value}</p>
                </div>
                <div className={`h-10 w-10 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <card.icon className={`h-5 w-5 ${card.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Factures récentes */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Factures récentes</CardTitle>
            <Link
              to="/invoices"
              className="flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Voir tout <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {stats.recent.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Aucune facture reçue pour l'instant.
            </div>
          ) : (
            <div className="divide-y">
              {stats.recent.map((inv) => (
                <Link
                  key={inv.id}
                  to={`/invoices/${inv.id}`}
                  className="flex items-center justify-between px-6 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{inv.supplierNameRaw}</p>
                    <p className="text-xs text-muted-foreground">{inv.docNumberPa} · {formatDate(inv.docDate)}</p>
                  </div>
                  <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                    <span className="text-sm font-medium">{formatAmount(inv.totalInclTax, inv.currency)}</span>
                    <StatusBadge status={inv.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
