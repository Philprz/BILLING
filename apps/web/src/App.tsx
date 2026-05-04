import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthGuard } from './components/layout/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import InvoiceListPage from './pages/InvoiceListPage';
import InvoiceDetailPage from './pages/InvoiceDetailPage';
import AuditPage from './pages/AuditPage';
import InvoiceGeneratorPage from './pages/InvoiceGeneratorPage';
import MappingRulesPage from './pages/MappingRulesPage';
import SuppliersPage from './pages/SuppliersPage';
import SettingsPage from './pages/SettingsPage';
import PaChannelsPage from './pages/PaChannelsPage';
import ChartOfAccountsPage from './pages/ChartOfAccountsPage';

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <Toaster position="top-right" richColors closeButton duration={4000} />
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <AuthGuard>
                  <AppLayout />
                </AuthGuard>
              }
            >
              <Route path="/" element={<DashboardPage />} />
              <Route path="/invoices" element={<InvoiceListPage />} />
              <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/invoice-generator" element={<InvoiceGeneratorPage />} />
              <Route path="/mapping-rules" element={<MappingRulesPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/pa-channels" element={<PaChannelsPage />} />
              <Route path="/chart-of-accounts" element={<ChartOfAccountsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
