import { lazy, useEffect } from 'react';
import { useAuth } from '@/stores/auth';
import { Route, Routes } from 'react-router-dom';
import { Layout } from '@/layouts/Layout';
import Home from '@/pages/Home';
import NotFound from '@/pages/NotFound';
import { ForgotPassword, Register, RequireAuth, ResetPassword, SignIn, VerifyEmail } from '@/pages/Auth';

const Tools = lazy(() => import('@/pages/Tools'));
const Pricing = lazy(() => import('@/pages/Pricing'));
const ToolPage = lazy(() => import('@/features/tools/ToolPage'));
const Privacy = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.Privacy })));
const Account = lazy(() => import('@/pages/Account'));
const Admin = lazy(() => import('@/pages/admin/Admin'));
const Terms = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.Terms })));

export default function App() {
  useEffect(() => { void useAuth.getState().init(); }, []);
  return (
    <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="tools" element={<Tools />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="terms" element={<Terms />} />
          <Route path="signin" element={<SignIn />} />
          <Route path="register" element={<Register />} />
          <Route path="forgot-password" element={<ForgotPassword />} />
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="verify-email" element={<VerifyEmail />} />
          <Route path="account" element={<RequireAuth><Account /></RequireAuth>} />
          <Route path="admin" element={<RequireAuth admin><Admin /></RequireAuth>} />
          <Route path=":toolId" element={<ToolPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
    </Routes>
  );
}
