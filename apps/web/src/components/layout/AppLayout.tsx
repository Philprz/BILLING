import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { FileText, LayoutDashboard, LogOut, Building2, ScrollText, FlaskConical } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { cn } from '../../lib/utils';

const NAV = [
  { to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true },
  { to: '/invoices', label: 'Factures', icon: FileText, end: false },
  { to: '/audit', label: 'Audit', icon: ScrollText, end: false },
  { to: '/invoice-generator', label: 'Générateur de test', icon: FlaskConical, end: false },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-sidebar text-sidebar-foreground flex flex-col">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <Building2 className="h-6 w-6 text-blue-400" />
          <div>
            <p className="font-semibold text-sm leading-none">PA-SAP Bridge</p>
            <p className="text-xs text-white/50 mt-0.5">Facturation électronique</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-white/15 text-white font-medium'
                    : 'text-white/70 hover:bg-white/10 hover:text-white',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User + logout */}
        <div className="px-3 pb-4 border-t border-white/10 pt-4 space-y-2">
          {user && (
            <div className="px-3 py-2 text-xs text-white/50">
              <p className="font-medium text-white/80">{user.user}</p>
              <p>{user.companyDb}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-white/70 hover:bg-white/10 hover:text-white transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Déconnexion
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
