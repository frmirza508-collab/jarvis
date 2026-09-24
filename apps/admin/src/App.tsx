import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { CustomerDetail, Customers } from './pages/Customers';
import { AuditLog, Devices, Licenses, Payments, Plans, Settings, Subscriptions } from './pages/Lists';

const NAV: Array<[string, string]> = [
  ['/', 'Dashboard'],
  ['/customers', 'Customers'],
  ['/subscriptions', 'Subscriptions'],
  ['/licenses', 'Licenses'],
  ['/devices', 'Devices'],
  ['/payments', 'Payments'],
  ['/audit', 'Audit Logs'],
  ['/plans', 'Plans'],
  ['/settings', 'Settings'],
];

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => {
    const onLogout = () => setAuthed(false);
    window.addEventListener('jarvis-logout', onLogout);
    return () => window.removeEventListener('jarvis-logout', onLogout);
  }, []);
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return (
    <BrowserRouter>
      <div className="layout">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">JARVIS <span>Admin</span></div>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>
          ))}
          <button className="logout" onClick={async () => { await api('POST', '/v1/auth/logout').catch(() => {}); setToken(null); setAuthed(false); }}>Sign out</button>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/licenses" element={<Licenses />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
