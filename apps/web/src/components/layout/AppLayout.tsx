import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  LayoutDashboard,
  LogOut,
  ScrollText,
  FlaskConical,
  Sparkles,
  BookmarkCheck,
  Users,
  Settings2,
  Cable,
  ChevronLeft,
  ChevronRight,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { cn } from '../../lib/utils';
import { ThemeToggle } from '../ui/theme-toggle';

const NAV = [
  { to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true },
  { to: '/invoices', label: 'Liste des factures', icon: FileText, end: false },
  { to: '/suppliers', label: 'Fournisseurs SAP', icon: Users, end: false },
  { to: '/mapping-rules', label: 'Règles mappage', icon: BookmarkCheck, end: false },
  { to: '/audit', label: 'Audit', icon: ScrollText, end: false },
  { to: '/pa-channels', label: 'Canaux PA', icon: Cable, end: false },
  { to: '/chart-of-accounts', label: 'Plan comptable SAP', icon: BookOpen, end: false },
  { to: '/settings', label: 'Paramètres', icon: Settings2, end: false },
  { to: '/invoice-generator', label: 'Générateur de test', icon: FlaskConical, end: false },
];

export function AppLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const activeItem =
    NAV.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    ) ?? NAV[0];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={cn(
          'border-b border-sidebar-border bg-sidebar-gradient text-sidebar-foreground shadow-glow lg:flex lg:flex-col lg:border-b-0 lg:border-r lg:border-sidebar-border transition-all duration-200',
          collapsed ? 'lg:w-20' : 'lg:w-72',
        )}
      >
        {collapsed ? (
          /* ── Mode réduit : logo + toggle empilés, centrés ── */
          <div className="hidden lg:flex flex-col items-center gap-2 border-b border-sidebar-border/70 py-4">
            <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl">
              <img
                src={theme === 'dark' ? '/LogoITS_sombre.png' : '/LogoITS_clair.png'}
                alt="IT Spirit"
                className="h-10 w-10 object-contain"
              />
            </div>
            <button
              onClick={() => setCollapsed(false)}
              className="rounded-xl border border-sidebar-border/70 bg-sidebar-foreground/5 p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground"
              aria-label="Déplier le menu"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : (
          /* ── Mode déployé : logo + texte + toggle sur une ligne ── */
          <div className="flex items-center gap-4 border-b border-sidebar-border/70 px-5 py-5">
            <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl">
              <img
                src={theme === 'dark' ? '/LogoITS_sombre.png' : '/LogoITS_clair.png'}
                alt="IT Spirit"
                className="h-14 w-14 object-contain"
              />
            </div>
            <div className="min-w-0">
              <p className="font-display text-xl uppercase tracking-[0.18em] text-sidebar-foreground">
                NOVA - PA
              </p>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              className="ml-auto hidden rounded-xl border border-sidebar-border/70 bg-sidebar-foreground/5 p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground lg:flex"
              aria-label="Replier le menu"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        )}

        <nav
          aria-label="Navigation principale"
          className="flex gap-2 overflow-x-auto px-3 py-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:px-4 lg:py-5"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'group inline-flex min-w-fit items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-all duration-200 lg:w-full',
                  collapsed && 'lg:justify-center lg:px-3',
                  isActive
                    ? 'border-sidebar-border/80 bg-sidebar-foreground/10 text-sidebar-foreground shadow-soft'
                    : 'border-transparent text-sidebar-foreground/70 hover:border-sidebar-border/80 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground',
                )
              }
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-sidebar-foreground/5 text-sidebar-foreground/80 transition-colors group-hover:bg-sidebar-foreground/10">
                <item.icon className="h-4 w-4" />
              </span>
              {!collapsed && <span className="font-medium">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="hidden space-y-3 border-t border-sidebar-border/70 px-4 py-4 lg:block">
          {!collapsed && (
            <div className="rounded-2xl border border-sidebar-border/80 bg-sidebar-foreground/5 p-4 text-xs text-sidebar-foreground/60">
              <div className="flex items-center gap-2 text-sidebar-foreground/80">
                <Sparkles className="h-4 w-4 text-primary" />
                Session SAP active
              </div>
              {user && (
                <div className="mt-3 space-y-1">
                  <p className="text-sm font-semibold text-sidebar-foreground">{user.companyDb}</p>
                  <p className="font-mono text-[11px] text-sidebar-foreground/60">{user.user}</p>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleLogout}
            title={t('nav.logout')}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-2xl border border-sidebar-border/80 bg-sidebar-foreground/5 px-4 py-3 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground',
              collapsed && 'px-3',
            )}
            aria-label={t('nav.logout')}
          >
            <LogOut className="h-4 w-4 flex-shrink-0" />
            {!collapsed && t('nav.logout')}
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-background/75 backdrop-blur-xl">
          <div className="flex flex-col gap-4 px-6 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <div>
              <h1 className="font-display text-xl uppercase tracking-[0.16em] text-foreground">
                {activeItem.label}
              </h1>
            </div>

            <div className="flex items-center gap-3 self-start lg:self-auto">
              <ThemeToggle />
              {user && (
                <div className="rounded-2xl border border-border/80 bg-card-muted/70 px-4 py-2.5 text-right shadow-soft">
                  <p className="text-sm font-semibold text-foreground">{user.companyDb}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{user.user}</p>
                </div>
              )}
              <button
                onClick={handleLogout}
                className="rounded-2xl border border-border/80 bg-card-muted/70 p-3 text-muted-foreground shadow-soft transition-colors hover:border-primary/30 hover:text-primary lg:hidden"
                aria-label={t('nav.logout')}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <main id="main-content" className="min-w-0" role="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
