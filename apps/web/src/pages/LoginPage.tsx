import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ShieldCheck, Sparkles } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiLogin } from '../api/auth.api';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { ThemeToggle } from '../components/ui/theme-toggle';

const COMPANIES = [
  { value: 'SBODemoFR', label: 'SBODemoFR — Société démo' },
  { value: 'RON_20260109', label: 'RON_20260109 — Rondot' },
];

const loginSchema = z.object({
  companyDb: z.string().min(1, 'Société requise'),
  userName: z.string().min(1, 'Utilisateur requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { companyDb: 'SBODemoFR', userName: '', password: '' },
  });

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const onSubmit = async (data: LoginForm) => {
    setServerError(null);
    try {
      await apiLogin(data.companyDb, data.userName, data.password);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Erreur de connexion.');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="auth-backdrop absolute inset-0" />
      <div className="absolute inset-x-0 top-0 h-px bg-brand-gradient opacity-80" />
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>

      <div className="relative grid w-full max-w-6xl gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <section className="space-y-6 text-center lg:text-left">
          <p className="page-eyebrow">IT Spirit</p>
          <div className="space-y-4">
            <div className="inline-flex h-16 w-16 items-center justify-center rounded-[1.4rem] border border-border/70 bg-brand-gradient shadow-brand">
              <Building2 className="h-8 w-8 text-primary-foreground" />
            </div>
            <div className="space-y-3">
              <h1 className="font-display text-5xl uppercase tracking-[0.12em] text-foreground">
                Billing
              </h1>
              <p className="max-w-xl text-base leading-7 text-muted-foreground">
                Une interface de facturation orientee exploitation, alignee sur l’identite IT
                Spirit: contrastes nets, hierarchie claire et accents premium utiles.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-left sm:grid-cols-2">
            <div className="panel-surface-muted p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                Experience guidee
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Connexion rapide au Service Layer SAP Business One, sans changer les flux existants.
              </p>
            </div>
            <div className="panel-surface-muted p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-success" />
                Lecture metier priorisee
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Etats, erreurs et actions critiques restent visibles immediatement pour l’operateur.
              </p>
            </div>
          </div>
        </section>

        <Card className="mx-auto w-full max-w-lg border-border/80 bg-card/90">
          <CardHeader className="pb-4">
            <p className="page-eyebrow">Connexion</p>
            <CardTitle className="font-display text-3xl uppercase tracking-[0.1em]">
              Acces SAP
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Saisissez vos identifiants SAP Business One Service Layer pour ouvrir votre session
              BILLING.
            </p>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                void handleSubmit(onSubmit)(e);
              }}
              className="space-y-5"
            >
              <Select
                id="companyDb"
                label="Société SAP"
                {...register('companyDb')}
                error={errors.companyDb?.message}
              >
                {COMPANIES.map((company) => (
                  <option key={company.value} value={company.value}>
                    {company.label}
                  </option>
                ))}
              </Select>

              <Input
                id="userName"
                label="Utilisateur SAP"
                placeholder="ex. manager"
                autoComplete="username"
                error={errors.userName?.message}
                {...register('userName')}
              />

              <Input
                id="password"
                label="Mot de passe"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                error={errors.password?.message}
                {...register('password')}
              />

              {serverError && <div className="alert-error">{serverError}</div>}

              <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                Se connecter
              </Button>
            </form>

            <div className="mt-6 rounded-2xl border border-border/70 bg-card-muted/70 px-4 py-3 text-xs leading-6 text-muted-foreground">
              Les identifiants utilises sont ceux de SAP Business One Service Layer. L’application
              reste integralement en francais et conserve les flux metier existants.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
