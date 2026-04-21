import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { apiLogin } from '../api/auth.api';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const COMPANIES = [
  { value: 'SBODemoFR', label: 'SBODemoFR — Société démo' },
  { value: 'RON_20260109', label: 'RON_20260109 — Rondot' },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();

  const [companyDb, setCompanyDb] = useState('SBODemoFR');
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Si déjà authentifié, redirige
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userName || !password) {
      setError('Tous les champs sont requis.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await apiLogin(companyDb, userName, password);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="flex justify-center mb-3">
            <div className="h-12 w-12 rounded-xl bg-primary flex items-center justify-center">
              <Building2 className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground">PA-SAP Bridge</h1>
          <p className="text-sm text-muted-foreground mt-1">Connexion au serveur SAP Business One</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connexion</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Société */}
              <div className="space-y-1">
                <label htmlFor="companyDb" className="block text-sm font-medium text-foreground">
                  Société SAP
                </label>
                <select
                  id="companyDb"
                  value={companyDb}
                  onChange={(e) => setCompanyDb(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {COMPANIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              <Input
                id="userName"
                label="Utilisateur SAP"
                placeholder="ex. manager"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                autoComplete="username"
              />

              <Input
                id="password"
                label="Mot de passe"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />

              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" loading={loading}>
                Se connecter
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Les identifiants sont ceux de SAP Business One Service Layer.
        </p>
      </div>
    </div>
  );
}
