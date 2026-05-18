import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiLogin } from '../api/auth.api';
import { ApiError } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
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

function mapLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USER_NOT_PROVISIONED':
        return "Votre compte SAP est valide mais n'est pas autorisé sur NOVA - PA. Contactez l'administrateur.";
      case 'USER_DISABLED':
        return "Votre accès NOVA - PA a été désactivé. Contactez l'administrateur.";
      case 'INVALID_CREDENTIALS':
        return 'Identifiants SAP incorrects.';
      case 'SAP_UNREACHABLE':
        return 'SAP Business One est injoignable. Réessayez dans un instant.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Erreur de connexion.';
}

export default function LoginPage() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { theme } = useTheme();
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
      setServerError(mapLoginError(err));
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
        <section className="flex flex-col items-center space-y-8 text-center lg:items-start lg:text-left">
          <img
            src={theme === 'dark' ? '/LogoITS_sombre.png' : '/LogoITS_clair.png'}
            alt="IT Spirit"
            className="h-80 w-auto lg:h-[28rem]"
          />
          <h1 className="font-display text-5xl uppercase tracking-[0.12em] text-foreground lg:text-6xl">
            NOVA - PA
          </h1>
        </section>

        <Card className="mx-auto w-full max-w-lg border-border/80 bg-card/90">
          <CardHeader className="pb-4">
            <p className="page-eyebrow">Connexion</p>
            <CardTitle className="font-display text-3xl uppercase tracking-[0.1em]">
              Acces SAP
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Saisissez vos identifiants SAP Business One Service Layer pour ouvrir votre session
              NOVA - PA.
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
