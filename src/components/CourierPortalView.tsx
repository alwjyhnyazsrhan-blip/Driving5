import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Phone,
  Lock,
  Eye,
  EyeOff,
  LogIn,
  LogOut,
  RotateCw,
  CheckCircle2,
  Package,
  Clock,
  AlertTriangle,
  Calendar,
  Search,
  MapPin,
  Store,
  TrendingUp,
  ChevronRight,
  ChevronLeft,
  ArrowRight,
  XCircle,
  Loader2,
} from 'lucide-react';
import { CourierPortalResponse, Order } from '../types';

interface CourierPortalViewProps {
  initialPhone?: string;
  onExitPortal?: () => void;
}

function getCurrentRiyadhMonth(): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }).slice(0, 7);
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

function shiftMonth(monthKey: string, delta: number): string {
  const [yStr, mStr] = monthKey.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return getCurrentRiyadhMonth();
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatArabicMonthLabel(monthKey: string): string {
  const [yStr, mStr] = monthKey.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return monthKey;
  try {
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('ar-SA', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return monthKey;
  }
}

function formatOrderRiyadhDateTime(order: Order): string {
  const ref = order.deliveryTime || order.assignedAt || order.createdAt || order.lastUpdated;
  if (!ref) return order.pickupTime || 'غير محدد';
  const parsed = new Date(ref);
  if (isNaN(parsed.getTime())) return order.pickupTime || 'غير محدد';
  try {
    return parsed.toLocaleString('ar-SA', {
      timeZone: 'Asia/Riyadh',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return parsed.toISOString();
  }
}

function formatDayLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  if (isNaN(parsed.getTime())) return dateKey;
  try {
    return parsed.toLocaleDateString('ar-SA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  } catch {
    return dateKey;
  }
}

export const CourierPortalView: React.FC<CourierPortalViewProps> = ({
  initialPhone = '',
  onExitPortal,
}) => {
  // Token lives strictly in React memory (never persisted in localStorage/sessionStorage)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState(initialPhone);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [selectedMonth, setSelectedMonth] = useState<string>(getCurrentRiyadhMonth);
  const [portalData, setPortalData] = useState<CourierPortalResponse | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'all' | 'delivered' | 'active' | 'delayed' | 'cancelled'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showDailyBreakdown, setShowDailyBreakdown] = useState(true);

  const fetchPortalData = useCallback(
    async (token: string, month: string) => {
      setIsLoadingData(true);
      setDataError(null);
      try {
        const res = await fetch(`/api/courier-portal/me?month=${encodeURIComponent(month)}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const data = await res.json();
        if (res.status === 401) {
          setAuthToken(null);
          setPortalData(null);
          setLoginError(data?.message || 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً');
          return;
        }
        if (!res.ok || !data?.success) {
          setDataError(data?.message || 'تعذر تحميل بيانات الطلبات');
          return;
        }
        setPortalData(data as CourierPortalResponse);
      } catch {
        setDataError('تعذر الاتصال بالخادم، يرجى المحاولة مرة أخرى');
      } finally {
        setIsLoadingData(false);
      }
    },
    []
  );

  useEffect(() => {
    if (authToken) {
      fetchPortalData(authToken, selectedMonth);
    }
  }, [authToken, selectedMonth, fetchPortalData]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);

    if (!phoneInput.trim() || !passwordInput.trim()) {
      setLoginError('يرجى إدخال رقم الجوال وكلمة المرور');
      return;
    }

    setIsLoggingIn(true);
    try {
      const res = await fetch('/api/courier-portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phoneInput.trim(),
          password: passwordInput,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.token) {
        setLoginError(data?.message || 'رقم الجوال أو كلمة المرور غير صحيحة');
        return;
      }

      setAuthToken(data.token);
      setPasswordInput('');
    } catch {
      setLoginError('تعذر الاتصال بالخادم، يرجى التأكد من الاتصال بالإنترنت');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    const tokenToRevoke = authToken;
    setAuthToken(null);
    setPortalData(null);
    setPasswordInput('');
    if (tokenToRevoke) {
      fetch('/api/courier-portal/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenToRevoke}` },
      }).catch(() => {});
    }
  };

  const filteredOrders = useMemo(() => {
    const list = portalData?.orders || [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((ord) => {
      if (statusFilter === 'delivered' && !(ord.status === 'delivered' || ord.isDelivered)) return false;
      if (statusFilter === 'cancelled' && !(ord.status === 'cancelled' || ord.isCanceled)) return false;
      if (statusFilter === 'delayed' && !(ord.isDelayed && !ord.isDelivered && !ord.isCanceled)) return false;
      if (statusFilter === 'active' && (ord.isDelivered || ord.isCanceled || ord.status === 'delivered' || ord.status === 'cancelled')) return false;

      if (q) {
        const hay = `${ord.id} ${ord.restaurant} ${ord.customerAddress || ''}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [portalData?.orders, statusFilter, searchQuery]);

  // --- LOGIN VIEW ---
  if (!authToken) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-8" dir="rtl">
        <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Top Brand Strip */}
          <div className="bg-emerald-700 px-6 py-6 text-white flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl overflow-hidden bg-emerald-800 shadow-sm ring-2 ring-white/25 shrink-0">
              <img
                src="/pwa-192x192.png"
                alt="شعار متابع لوكيت"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-snug">بوابة المندوب لمتابعة الطلبات</h1>
              <p className="text-xs text-emerald-100 mt-0.5">
                استعرض تفاصيل طلباتك وإحصائيات إنجازك الشهري
              </p>
            </div>
          </div>

          {/* Login Form */}
          <form onSubmit={handleLoginSubmit} className="p-6 space-y-4">
            {loginError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                رقم الجوال المسجل
              </label>
              <div className="relative">
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="05xxxxxxxx أو +9665xxxxxxxx"
                  className="w-full text-sm font-mono pl-3 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition text-left"
                  dir="ltr"
                  autoComplete="tel"
                  required
                />
                <Phone className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                كلمة المرور
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="أدخل كلمة المرور المعطاة من الإدارة"
                  className="w-full text-sm pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
                  autoComplete="current-password"
                  required
                />
                <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-xs transition cursor-pointer"
            >
              {isLoggingIn ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>جاري التحقق...</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>دخول إلى حسابي</span>
                </>
              )}
            </button>

            {onExitPortal && (
              <button
                type="button"
                onClick={onExitPortal}
                className="w-full py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span>العودة إلى لوحة الإدارة</span>
              </button>
            )}
          </form>
        </div>
      </div>
    );
  }

  // --- AUTHENTICATED COURIER DASHBOARD ---
  const courier = portalData?.courier;
  const stats = portalData?.stats;
  const dailyBreakdown = portalData?.dailyBreakdown || [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col" dir="rtl">
      {/* Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-2xs">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden bg-emerald-700 shrink-0 shadow-xs ring-2 ring-emerald-50">
              <img
                src="/pwa-192x192.png"
                alt="شعار متابع لوكيت"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <h1 className="text-sm sm:text-base font-bold text-slate-900">
                {courier?.name || 'بوابة المندوب'}
              </h1>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-mono" dir="ltr">{courier?.phone || phoneInput}</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  متصل بحسابك
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onExitPortal && (
              <button
                onClick={onExitPortal}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center gap-1 transition cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span>لوحة الإدارة</span>
              </button>
            )}
            <button
              onClick={() => fetchPortalData(authToken, selectedMonth)}
              disabled={isLoadingData}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1.5 transition cursor-pointer"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isLoadingData ? 'animate-spin' : ''}`} />
              <span>تحديث</span>
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 flex items-center gap-1.5 transition cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>خروج</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-5 space-y-5">
        {/* Month Filter Bar */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                ملخص طلبات شهر {formatArabicMonthLabel(selectedMonth)}
              </h2>
              <p className="text-[11px] text-slate-500">
                اختر الشهر لاستعراض عدد الطلبات المنجزة وكامل التفاصيل
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition cursor-pointer"
              title="الشهر السابق"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => {
                if (e.target.value) setSelectedMonth(e.target.value);
              }}
              className="px-3 py-1.5 text-xs font-bold font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              dir="ltr"
            />
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftMonth(m, 1))}
              disabled={selectedMonth >= getCurrentRiyadhMonth()}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700 transition cursor-pointer"
              title="الشهر التالي"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        {dataError && (
          <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{dataError}</span>
          </div>
        )}

        {/* Monthly Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-emerald-600 text-white rounded-xl p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-emerald-100 text-xs font-semibold">
              <span>المنجزة خلال الشهر</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-200" />
            </div>
            <div className="text-3xl font-extrabold mt-2">
              {isLoadingData && !stats ? '...' : stats?.deliveredMonth ?? 0}
            </div>
            <div className="text-[11px] text-emerald-100 mt-1">
              منها {stats?.deliveredToday ?? 0} طلب تم تسليمه اليوم
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
              <span>إجمالي طلبات الشهر</span>
              <Package className="w-4 h-4 text-blue-600" />
            </div>
            <div className="text-3xl font-extrabold text-slate-900 mt-2">
              {isLoadingData && !stats ? '...' : stats?.totalOrdersMonth ?? 0}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              ملغي: {stats?.cancelledMonth ?? 0} طلب
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
              <span>الطلبات النشطة الآن</span>
              <TrendingUp className="w-4 h-4 text-indigo-600" />
            </div>
            <div className="text-3xl font-extrabold text-slate-900 mt-2">
              {isLoadingData && !stats ? '...' : stats?.activeNow ?? 0}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {stats && stats.delayedMonth > 0 ? (
                <span className="text-rose-600 font-bold">متأخر حالياً: {stats.delayedMonth}</span>
              ) : (
                'جميعها ضمن الوقت'
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
              <span>متوسط وقت التوصيل</span>
              <Clock className="w-4 h-4 text-amber-500" />
            </div>
            <div className="text-3xl font-extrabold text-slate-900 mt-2">
              {isLoadingData && !stats ? '...' : `${stats?.avgDeliveryMinutesMonth ?? 0} د`}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {stats && stats.totalDeliveryCostMonth > 0
                ? `إجمالي رسوم التوصيل: ${stats.totalDeliveryCostMonth} ر.س`
                : 'متوسط المدة للطلبات المسلمة'}
            </div>
          </div>
        </div>

        {/* Daily Breakdown for the Month */}
        {dailyBreakdown.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <button
              type="button"
              onClick={() => setShowDailyBreakdown((v) => !v)}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-slate-800 hover:bg-slate-50 transition cursor-pointer"
            >
              <span>توزيع الطلبات اليومي خلال الشهر ({dailyBreakdown.length} يوم عمل)</span>
              <span className="text-emerald-700">{showDailyBreakdown ? 'إخفاء' : 'عرض'}</span>
            </button>
            {showDailyBreakdown && (
              <div className="px-4 pb-4 pt-1 flex gap-2 overflow-x-auto">
                {dailyBreakdown.map((day) => (
                  <div
                    key={day.date}
                    className="min-w-[115px] rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-center shrink-0"
                  >
                    <div className="text-[11px] font-bold text-slate-700">{formatDayLabel(day.date)}</div>
                    <div className="text-lg font-extrabold text-emerald-700 mt-1">{day.delivered}</div>
                    <div className="text-[10px] text-slate-500">
                      منجز من أصل {day.total}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Orders Filter & Search */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم الطلب، المطعم، أو العنوان..."
                className="w-full text-xs pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
              />
              <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {[
                { key: 'all', label: `الكل (${portalData?.orders.length ?? 0})` },
                { key: 'delivered', label: `تم التسليم (${stats?.deliveredMonth ?? 0})` },
                { key: 'active', label: `نشطة (${stats?.activeNow ?? 0})` },
                { key: 'delayed', label: `متأخرة (${stats?.delayedMonth ?? 0})` },
                { key: 'cancelled', label: `ملغاة (${stats?.cancelledMonth ?? 0})` },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setStatusFilter(tab.key as any)}
                  className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer ${
                    statusFilter === tab.key
                      ? 'bg-emerald-600 text-white shadow-2xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Orders List */}
          {isLoadingData && !portalData ? (
            <div className="py-12 text-center text-slate-500 text-xs flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
              <span>جاري تحميل طلبات الشهر...</span>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">
              لا توجد طلبات مطابقة في هذا الشهر.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredOrders.map((order) => {
                const isDelivered = order.status === 'delivered' || order.isDelivered;
                const isCancelled = order.status === 'cancelled' || order.isCanceled;
                const isDelayed = !isDelivered && !isCancelled && order.isDelayed;

                return (
                  <div
                    key={order.id}
                    className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 hover:bg-slate-50/70 px-2 rounded-lg transition"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-sm text-slate-900" dir="ltr">
                          {order.id}
                        </span>
                        {isDelivered ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" />
                            تم التسليم
                          </span>
                        ) : isCancelled ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                            <XCircle className="w-3 h-3" />
                            ملغي
                          </span>
                        ) : isDelayed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                            <AlertTriangle className="w-3 h-3" />
                            متأخر ({order.elapsedMinutes} د)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                            <Clock className="w-3 h-3" />
                            جاري التوصيل ({order.elapsedMinutes} د)
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                        <span className="flex items-center gap-1">
                          <Store className="w-3.5 h-3.5 text-slate-400" />
                          {order.restaurant || 'متجر لوكيت'}
                        </span>
                        {order.customerAddress && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-slate-400" />
                            {order.customerAddress}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-center sm:items-end justify-between gap-1 text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {formatOrderRiyadhDateTime(order)}
                      </span>
                      <div className="flex items-center gap-2 text-[11px]">
                        {order.elapsedMinutes > 0 && (
                          <span className="text-slate-500">المدة: {order.elapsedMinutes} دقيقة</span>
                        )}
                        {order.deliveryCost && Number(order.deliveryCost) > 0 && (
                          <span className="font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                            {order.deliveryCost} ر.س
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
