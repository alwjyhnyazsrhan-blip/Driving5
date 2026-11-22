import React, { useState, useEffect } from 'react';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  LogIn,
  AlertTriangle,
  Loader2,
  KeyRound,
} from 'lucide-react';

interface AdminLoginViewProps {
  onAuthenticated: (token: string) => void;
}

type AdminAuthMode = 'loading' | 'locate_credentials' | 'admin_password' | 'setup';

export const AdminLoginView: React.FC<AdminLoginViewProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AdminAuthMode>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/admin-auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (data?.authenticated && data?.token) {
          onAuthenticated(data.token);
          return;
        }
        if (data?.mode === 'setup' || data?.mode === 'admin_password' || data?.mode === 'locate_credentials') {
          setMode(data.mode);
        } else {
          setMode('locate_credentials');
        }
      })
      .catch(() => {
        if (active) setMode('locate_credentials');
      });
    return () => {
      active = false;
    };
  }, [onAuthenticated]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'setup') {
      if (password.trim().length < 6) {
        setError('كلمة المرور يجب أن تكون 6 أحرف/أرقام على الأقل');
        return;
      }
      if (password.trim() !== confirmPassword.trim()) {
        setError('كلمتا المرور غير متطابقتين');
        return;
      }
      setIsSubmitting(true);
      try {
        const res = await fetch('/api/admin-auth/setup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.trim() }),
        });
        const data = await res.json();
        if (!res.ok || !data?.success || !data?.token) {
          setError(data?.message || 'تعذر حفظ كلمة مرور الإدارة');
          return;
        }
        setPassword('');
        setConfirmPassword('');
        onAuthenticated(data.token);
      } catch {
        setError('تعذر الاتصال بالخادم، يرجى المحاولة مرة أخرى');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (mode === 'locate_credentials' && !email.trim()) {
      setError('يرجى إدخال البريد الإلكتروني للإدارة');
      return;
    }

    if (!password.trim()) {
      setError('يرجى إدخال كلمة المرور');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin-auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: mode === 'locate_credentials' ? email.trim() : undefined,
          password: password.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.token) {
        setError(data?.message || 'بيانات الدخول غير صحيحة');
        return;
      }
      setPassword('');
      onAuthenticated(data.token);
    } catch {
      setError('تعذر الاتصال بالخادم، يرجى المحاولة مرة أخرى');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-8" dir="rtl">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-slate-900 px-6 py-6 text-white flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl overflow-hidden bg-slate-800 shadow-sm ring-2 ring-emerald-400/30 shrink-0 flex items-center justify-center">
            <img
              src="./pwa-192x192.png"
              alt="شعار متابع لوكيت"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-snug">دخول لوحة الإدارة</h1>
            <p className="text-xs text-slate-300 mt-0.5">
              لوحة التحكم محمية ولا يمكن الوصول إليها إلا من قِبل الإدارة
            </p>
          </div>
        </div>

        {mode === 'loading' ? (
          <div className="p-8 flex flex-col items-center justify-center gap-3 text-slate-500 text-xs font-semibold">
            <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
            <span>جاري التحقق من حالة الحماية...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {mode === 'setup' && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs leading-relaxed">
                <strong>الإعداد الأولي للأمان:</strong> يرجى تعيين كلمة مرور خاصة بلوحة الإدارة لمنع أي شخص أو مندوب من الدخول إليها.
              </div>
            )}

            {mode === 'locate_credentials' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  البريد الإلكتروني للإدارة (حساب لوكيت)
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    dir="ltr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@company.com"
                    autoComplete="username"
                    className="w-full pr-10 pl-3 py-2.5 rounded-xl border border-slate-300 text-sm text-left focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    required
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-700">
                {mode === 'setup' ? 'كلمة مرور لوحة الإدارة الجديدة' : 'كلمة المرور'}
              </label>
              <div className="relative">
                {mode === 'setup' ? (
                  <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                ) : (
                  <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                )}
                <input
                  type={showPassword ? 'text' : 'password'}
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                  className="w-full pr-10 pl-10 py-2.5 rounded-xl border border-slate-300 text-sm text-left focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label="إظهار أو إخفاء كلمة المرور"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === 'setup' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  تأكيد كلمة مرور الإدارة
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    dir="ltr"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    className="w-full pr-10 pl-3 py-2.5 rounded-xl border border-slate-300 text-sm text-left focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    required
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-sm font-bold transition shadow-xs cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>جاري التحقق...</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>{mode === 'setup' ? 'حفظ كلمة المرور والدخول' : 'دخول لوحة الإدارة'}</span>
                </>
              )}
            </button>

            <p className="text-[11px] text-slate-500 text-center leading-relaxed pt-1">
              يتم حفظ تسجيل الدخول تلقائياً لمرة واحدة فقط ولن يُطلب منك مجدداً عند فتح التطبيق إلا عند الضغط على «قفل».
            </p>
          </form>
        )}
      </div>
    </div>
  );
};
