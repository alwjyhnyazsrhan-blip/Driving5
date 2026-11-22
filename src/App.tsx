import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { LiveOrdersView } from './components/LiveOrdersView';
import { CouriersView } from './components/CouriersView';
import { AlertsLogView } from './components/AlertsLogView';
import { DailyReportView } from './components/DailyReportView';
import { AutomationScriptView } from './components/AutomationScriptView';
import { SettingsModal } from './components/SettingsModal';
import { CourierModal } from './components/CourierModal';
import { QuickOrderModal } from './components/QuickOrderModal';
import { WhatsAppTestModal } from './components/WhatsAppTestModal';
import { QuickWhatsAppModal } from './components/QuickWhatsAppModal';
import { GuideWalkthroughModal } from './components/GuideWalkthroughModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { CourierPortalView } from './components/CourierPortalView';
import { AdminLoginView } from './components/AdminLoginView';
import {
  getEngineConfig,
  subscribeEngineConfig,
  setAdminAuthToken,
  setAdminAuthenticated,
  subscribeAdminUnauthorized,
} from './services/apiBridge';
import { Order, Courier, SystemSettings, AlertLog, WhatsAppConnectionState, CloudSyncState } from './types';
import { Bell, CheckCircle2, AlertTriangle, X, Loader2 } from 'lucide-react';

function getInitialPortalParams(): { isPortal: boolean; phone: string } {
  if (typeof window === 'undefined') return { isPortal: false, phone: '' };
  try {
    const params = new URLSearchParams(window.location.search);
    const isPortal = params.get('portal') === 'courier' || window.location.pathname === '/courier';
    const phone = params.get('phone') || '';
    return { isPortal, phone };
  } catch {
    return { isPortal: false, phone: '' };
  }
}

export default function App() {
  const initialPortal = getInitialPortalParams();
  const [isCourierPortalMode, setIsCourierPortalMode] = useState<boolean>(initialPortal.isPortal);
  const [portalInitialPhone, setPortalInitialPhone] = useState<string>(initialPortal.phone);
  const [openedPortalFromAdmin, setOpenedPortalFromAdmin] = useState<boolean>(false);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [isCheckingAdminSession, setIsCheckingAdminSession] = useState<boolean>(!initialPortal.isPortal);
  const [currentTab, setCurrentTab] = useState<'orders' | 'couriers' | 'alerts' | 'report' | 'automation'>('orders');
  
  // Data states (clean initial state, filled only with real data from backend/Locat)
  const [settings, setSettings] = useState<SystemSettings>({
    delayThresholdMinutes: 30,
    criticalDelayMinutes: 45,
    adminPhone: '',
    adminName: '',
    adminPhone2: '',
    adminName2: '',
    autoNotifyOrderAssignment: true,
    autoAlertCourier: true,
    autoAlertAdmin: true,
    autoAlertAdmin2: true,
    alertCooldownMinutes: 20,
    antiBanMinDelaySeconds: 5,
    antiBanMaxDelaySeconds: 10,
    autoDailyReport: true,
    dailyReportTime: '23:00',
    whatsAppProvider: 'direct_chat',
    webhookUrl: '',
    webhookApiKey: '',
    locatSyncIntervalSeconds: 30,
    locatApiKey: 'locat_secret_key_8892',
  });

  const [orders, setOrders] = useState<Order[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [alerts, setAlerts] = useState<AlertLog[]>([]);
  const [whatsappState, setWhatsappState] = useState<WhatsAppConnectionState | null>(null);
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'alert'; text: string } | null>(null);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCourierModalOpen, setIsCourierModalOpen] = useState(false);
  const [courierToEdit, setCourierToEdit] = useState<Courier | null>(null);
  const [isAddOrderOpen, setIsAddOrderOpen] = useState(false);
  const [selectedCourierForOrder, setSelectedCourierForOrder] = useState<Courier | null>(null);
  const [isWhatsAppModalOpen, setIsWhatsAppModalOpen] = useState(false);
  const [isQuickWhatsAppOpen, setIsQuickWhatsAppOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);

  const showToast = (text: string, type: 'success' | 'alert' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4500);
  };

  // Fetch initial and poll data
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setIsSyncing(true);
    try {
      const [settingsRes, couriersRes, ordersRes, alertsRes, waRes, cloudRes] = await Promise.all([
        fetch('/api/settings').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/couriers').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/orders').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/alerts').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/whatsapp/status').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/locat/cloud-status').then((r) => r.json()).catch(() => ({ success: false })),
      ]);

      if (settingsRes?.success) setSettings(settingsRes.settings);
      if (couriersRes?.success) setCouriers(couriersRes.couriers);
      if (ordersRes?.success) setOrders(ordersRes.orders);
      if (alertsRes?.success) setAlerts(alertsRes.alerts);
      if (waRes?.success && waRes.whatsappState) {
        setWhatsappState(waRes.whatsappState);

        // Fail-safe persistence: If server has active session backup, save to browser localStorage
        if (waRes.sessionBackup && waRes.sessionBackup['creds.json']) {
          try {
            localStorage.setItem('baileys_session_backup', JSON.stringify(waRes.sessionBackup));
          } catch (e) {}
        }

        // If server lost session on restart (e.g. Render container rebuild) but browser has backup, auto-restore!
        if (!waRes.hasSavedSession && waRes.whatsappState.status !== 'connected') {
          try {
            const localBackup = localStorage.getItem('baileys_session_backup');
            if (localBackup) {
              const parsed = JSON.parse(localBackup);
              if (parsed && parsed['creds.json']) {
                console.log('[WhatsApp Auto-Restore] 🔄 استعادة تلقائية لجلسة الواتساب من ذاكرة المتصفح...');
                fetch('/api/whatsapp/restore-session', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionBackup: parsed }),
                })
                  .then((r) => r.json())
                  .then((data) => {
                    if (data.success) {
                      showToast('تمت استعادة جلسة الواتساب المحفوظة تلقائياً إلى السيرفر بدون إعادة مسح الرمز', 'success');
                      fetchData(true);
                    }
                  })
                  .catch(() => {});
              }
            }
          } catch (e) {}
        }
      }
      if (cloudRes?.success && cloudRes.cloudSyncState) setCloudSyncState(cloudRes.cloudSyncState);
    } catch (err) {
      console.error('Failed to sync system data:', err);
    } finally {
      if (!silent) setIsSyncing(false);
    }
  }, []);

  const handleTriggerCloudSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/locat/cloud-sync-now', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
      } else {
        showToast(data.message, 'alert');
      }
      fetchData(true);
    } catch {
      showToast('تعذر إجراء السحب الفوري', 'alert');
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    setAdminAuthToken(adminToken);
  }, [adminToken]);

  useEffect(() => {
    setAdminAuthenticated(isAdminAuthenticated);
  }, [isAdminAuthenticated]);

  useEffect(() => {
    if (isCourierPortalMode) {
      setIsCheckingAdminSession(false);
      return;
    }
    let active = true;
    setIsCheckingAdminSession(true);
    fetch('/api/admin-auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (data?.authenticated) {
          setAdminAuthenticated(true);
          setIsAdminAuthenticated(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsCheckingAdminSession(false);
      });
    return () => {
      active = false;
    };
  }, [isCourierPortalMode]);

  useEffect(() => {
    return subscribeAdminUnauthorized(() => {
      setAdminAuthToken(null);
      setAdminAuthenticated(false);
      setAdminToken(null);
      setIsAdminAuthenticated(false);
    });
  }, []);

  // Only attach Admin PWA manifest when an Admin is explicitly authenticated (never for couriers or unauthenticated visitors)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const existingAdminLink = document.querySelector('link[data-locat-manifest="admin"]');
    if (!isCourierPortalMode && isAdminAuthenticated) {
      if (!existingAdminLink) {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = '/admin-manifest.webmanifest';
        link.setAttribute('data-locat-manifest', 'admin');
        document.head.appendChild(link);
      }
    } else if (existingAdminLink) {
      existingAdminLink.remove();
    }
  }, [isCourierPortalMode, isAdminAuthenticated]);

  const handleAdminAuthenticated = useCallback((token: string) => {
    setAdminAuthToken(token);
    setAdminAuthenticated(true);
    setAdminToken(token);
    setIsAdminAuthenticated(true);
  }, []);

  const handleLogoutAdmin = useCallback(async () => {
    try {
      await fetch('/api/admin-auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    setAdminAuthToken(null);
    setAdminAuthenticated(false);
    setAdminToken(null);
    setIsAdminAuthenticated(false);
    setOrders([]);
    setCouriers([]);
    setAlerts([]);
  }, []);

  useEffect(() => {
    if (isCourierPortalMode || !isAdminAuthenticated) return;

    // Restore any custom courier phones previously configured from browser local storage
    try {
      const localCustom = localStorage.getItem('locat_custom_couriers');
      if (localCustom) {
        const parsed = JSON.parse(localCustom);
        if (Object.keys(parsed).length > 0) {
          fetch('/api/couriers/restore-custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customPhones: parsed }),
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('Failed restoring custom courier phones from local storage:', e);
    }

    // Attempt early restore of WhatsApp session if available in localStorage
    try {
      const localSession = localStorage.getItem('baileys_session_backup');
      if (localSession) {
        const parsedSession = JSON.parse(localSession);
        if (parsedSession && parsedSession['creds.json']) {
          fetch('/api/whatsapp/restore-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionBackup: parsedSession }),
          }).catch(() => {});
        }
      }
    } catch (e) {}

    fetchData();
    // Background polling every 20 seconds to sync live order changes from the script
    const interval = setInterval(() => {
      fetchData(true);
    }, 20000);
    return () => clearInterval(interval);
  }, [fetchData, isCourierPortalMode, isAdminAuthenticated]);

  useEffect(() => {
    if (isCourierPortalMode || !isAdminAuthenticated) return;
    let prevBackend = getEngineConfig().activeBackend;
    const unsubscribe = subscribeEngineConfig((cfg) => {
      if (cfg.activeBackend !== prevBackend) {
        prevBackend = cfg.activeBackend;
        fetchData(true);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [fetchData, isCourierPortalMode, isAdminAuthenticated]);

  // Quick follow-up poll until WhatsApp QR code is generated on startup
  useEffect(() => {
    if (isCourierPortalMode || !isAdminAuthenticated || whatsappState?.isLoggedIn || whatsappState?.qrDataUrl) return;
    const qrTimer = setInterval(() => {
      fetchData(true);
    }, 3500);
    return () => clearInterval(qrTimer);
  }, [whatsappState?.isLoggedIn, whatsappState?.qrDataUrl, fetchData, isCourierPortalMode, isAdminAuthenticated]);

  // Advance time simulation (+5 / +15 mins)
  const handleAdvanceTime = async (minutes: number) => {
    try {
      const res = await fetch('/api/orders/advance-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'alert');
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Trigger manual WhatsApp alert
  const handleTriggerManualAlert = async (orderId: string, target: 'courier' | 'admin' | 'admin2' | 'both') => {
    try {
      const nowRiyadh = new Date().toLocaleTimeString('ar-SA', {
        timeZone: 'Asia/Riyadh',
        hour: '2-digit',
        minute: '2-digit',
      });

      // Optimistic instant state update with accurate Riyadh local time
      setOrders((prev) =>
        prev.map((o) => {
          if (o.id === orderId) {
            return {
              ...o,
              alertSentToCourier: target === 'courier' || target === 'both' ? true : o.alertSentToCourier,
              courierAlertTime: target === 'courier' || target === 'both' ? nowRiyadh : o.courierAlertTime,
              alertSentToAdmin: target === 'admin' || target === 'both' ? true : o.alertSentToAdmin,
              adminAlertTime: target === 'admin' || target === 'both' ? nowRiyadh : o.adminAlertTime,
              alertSentToAdmin2: target === 'admin2' ? true : o.alertSentToAdmin2,
              admin2AlertTime: target === 'admin2' ? nowRiyadh : o.admin2AlertTime,
            };
          }
          return o;
        })
      );

      const res = await fetch('/api/alerts/trigger-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, target }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`تم توجيه التنبيه للطلب ${orderId} وتحديث السجل`, 'success');
        fetchData(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Save Settings
  const handleSaveSettings = async (newSettings: Partial<SystemSettings>) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.settings);
        showToast('تم حفظ وضبط إعدادات الأتمتة وحدود التأخير بنجاح');
        fetchData(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Save / Update Courier
  const handleSaveCourier = async (courierData: Partial<Courier> & { portalPassword?: string; clearPortalPassword?: boolean }) => {
    try {
      // Save custom phone to localStorage as a durable browser backup
      if (courierData.phone) {
        try {
          const stored = JSON.parse(localStorage.getItem('locat_custom_couriers') || '{}');
          if (courierData.id) stored[courierData.id] = { phone: courierData.phone, name: courierData.name };
          if (courierData.name) stored[courierData.name] = { phone: courierData.phone, name: courierData.name };
          localStorage.setItem('locat_custom_couriers', JSON.stringify(stored));
        } catch (e) {}
      }

      const res = await fetch('/api/couriers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(courierData),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        fetchData();
      } else if (data.message) {
        showToast(data.message, 'alert');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Set, update, or clear a courier's portal password
  const handleUpdateCourierPassword = async (courierId: string, password: string | null) => {
    try {
      const res = await fetch(`/api/couriers/${encodeURIComponent(courierId)}/portal-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(password === null ? { clear: true } : { password }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        fetchData(true);
      } else {
        showToast(data.message || 'تعذر تحديث كلمة سر المندوب', 'alert');
      }
    } catch (err) {
      console.error(err);
      showToast('تعذر الاتصال بالخادم لحفظ كلمة سر المندوب', 'alert');
    }
  };

  // Quick inline update & lock for courier phone
  const handleUpdateCourierPhone = async (identifier: {
    courierId?: string;
    orderId?: string;
    courierName?: string;
    phone: string;
  }) => {
    try {
      const newPhone = identifier.phone.trim();
      // Optimistic local state update
      setCouriers((prev) =>
        prev.map((c) => {
          if (
            (identifier.courierId && c.id === identifier.courierId) ||
            (identifier.courierName && c.name === identifier.courierName)
          ) {
            return { ...c, phone: newPhone, customPhone: newPhone, isCustomPhone: true };
          }
          return c;
        })
      );
      if (identifier.orderId) {
        setOrders((prev) =>
          prev.map((o) => {
            if (o.id === identifier.orderId) {
              return { ...o, courierPhone: newPhone };
            }
            return o;
          })
        );
      }

      // Persist in localStorage
      try {
        const stored = JSON.parse(localStorage.getItem('locat_custom_couriers') || '{}');
        const key = identifier.courierId || identifier.courierName || identifier.orderId || 'driver';
        stored[key] = {
          courierId: identifier.courierId,
          courierName: identifier.courierName,
          phone: newPhone,
          timestamp: Date.now(),
        };
        if (identifier.courierName) {
          stored[identifier.courierName] = { phone: newPhone };
        }
        localStorage.setItem('locat_custom_couriers', JSON.stringify(stored));
      } catch (e) {}

      const res = await fetch('/api/couriers/update-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(identifier),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        fetchData(true);
      } else {
        showToast(data.message || 'حدث خطأ في حفظ الرقم', 'alert');
      }
    } catch (err) {
      console.error(err);
      showToast('تعذر الاتصال بالخادم لحفظ رقم المندوب', 'alert');
    }
  };

  // Delete Courier
  const handleDeleteCourier = async (id: string) => {
    try {
      const res = await fetch(`/api/couriers/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Clear Alerts Log
  const handleClearAlerts = async () => {
    try {
      const res = await fetch('/api/alerts/clear', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setAlerts([]);
        showToast('تم مسح سجل التنبيهات');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Send Daily Report to Admin WhatsApp
  const handleSendReportToAdmin = async () => {
    try {
      const res = await fetch('/api/reports/send-daily', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('تم إرسال التقرير اليومي الشامل للإدارة عبر الواتساب بنجاح');
        fetchData(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Test sync or manual order intake
  const handleLocatSyncIngest = async (incomingOrders: any[]) => {
    try {
      const res = await fetch('/api/locat/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secretKey: settings.locatApiKey,
          liveOrders: incomingOrders,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, data.alertsGenerated > 0 ? 'alert' : 'success');
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (isCourierPortalMode) {
    return (
      <CourierPortalView
        initialPhone={portalInitialPhone}
        onExitPortal={
          openedPortalFromAdmin && isAdminAuthenticated
            ? () => {
                setIsCourierPortalMode(false);
                setOpenedPortalFromAdmin(false);
              }
            : undefined
        }
      />
    );
  }

  if (isCheckingAdminSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-8" dir="rtl">
        <div className="flex flex-col items-center gap-3 text-slate-600 text-xs font-semibold">
          <Loader2 className="w-7 h-7 animate-spin text-emerald-600" />
          <span>جاري التحقق من جلسة الإدارة المحفوظة...</span>
        </div>
      </div>
    );
  }

  if (!isAdminAuthenticated) {
    return <AdminLoginView onAuthenticated={handleAdminAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col antialiased">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 left-5 z-50 animate-in fade-in slide-in-from-bottom-5 duration-200">
          <div className={`px-4 py-3 rounded-xl shadow-lg border flex items-center gap-2.5 text-xs font-bold ${
            toastMessage.type === 'alert'
              ? 'bg-rose-900 text-white border-rose-800'
              : 'bg-emerald-900 text-white border-emerald-800'
          }`}>
            {toastMessage.type === 'alert' ? (
              <AlertTriangle className="w-4 h-4 text-rose-300" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-300" />
            )}
            <span>{toastMessage.text}</span>
            <button
              onClick={() => setToastMessage(null)}
              className="p-1 hover:opacity-75 transition mr-2"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Header */}
      <Header
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        settings={settings}
        orders={orders}
        unreadAlertsCount={alerts.length}
        onRefresh={() => fetchData(false)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onAdvanceTime={handleAdvanceTime}
        onSendQuickDailyReport={handleSendReportToAdmin}
        isSyncing={isSyncing}
        onOpenWhatsApp={() => setIsWhatsAppModalOpen(true)}
        onOpenQuickWhatsApp={() => setIsQuickWhatsAppOpen(true)}
        whatsappState={whatsappState}
        cloudSyncState={cloudSyncState}
        onOpenGuide={() => setIsGuideOpen(true)}
        onLogoutAdmin={handleLogoutAdmin}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {currentTab === 'orders' && (
          <LiveOrdersView
            orders={orders}
            couriers={couriers}
            settings={settings}
            onTriggerManualAlert={handleTriggerManualAlert}
            onOpenAddOrderModal={() => setIsAddOrderOpen(true)}
            onAdvanceTime={handleAdvanceTime}
            cloudSyncState={cloudSyncState}
            whatsappState={whatsappState}
            onTriggerCloudSync={handleTriggerCloudSync}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onSaveSettings={handleSaveSettings}
            onUpdateCourierPhone={handleUpdateCourierPhone}
          />
        )}

        {currentTab === 'couriers' && (
          <CouriersView
            couriers={couriers}
            orders={orders}
            onOpenAddCourierModal={() => {
              setCourierToEdit(null);
              setIsCourierModalOpen(true);
            }}
            onEditCourier={(c) => {
              setCourierToEdit(c);
              setIsCourierModalOpen(true);
            }}
            onDeleteCourier={handleDeleteCourier}
            onAssignOrderToCourier={(c) => {
              setSelectedCourierForOrder(c);
              setIsAddOrderOpen(true);
            }}
            onUpdateCourierPhone={handleUpdateCourierPhone}
            onUpdateCourierPassword={handleUpdateCourierPassword}
            onOpenCourierPortal={(phone) => {
              setPortalInitialPhone(phone || '');
              setOpenedPortalFromAdmin(true);
              setIsCourierPortalMode(true);
            }}
          />
        )}

        {currentTab === 'alerts' && (
          <AlertsLogView
            alerts={alerts}
            onClearAlerts={handleClearAlerts}
          />
        )}

        {currentTab === 'report' && (
          <DailyReportView
            settings={settings}
            onSendReportToAdmin={handleSendReportToAdmin}
          />
        )}

        {currentTab === 'automation' && (
          <AutomationScriptView
            settings={settings}
            onTestSync={handleLocatSyncIngest}
          />
        )}
      </main>

      {/* Modals */}
      <WhatsAppTestModal
        isOpen={isWhatsAppModalOpen}
        onClose={() => {
          setIsWhatsAppModalOpen(false);
          fetchData(true);
        }}
        settings={settings}
        couriers={couriers}
        onAlertGenerated={() => fetchData(true)}
        onSaveSettings={handleSaveSettings}
      />

      <QuickWhatsAppModal
        isOpen={isQuickWhatsAppOpen}
        onClose={() => setIsQuickWhatsAppOpen(false)}
        settings={settings}
        onSaved={handleSaveSettings}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
      />

      <CourierModal
        isOpen={isCourierModalOpen}
        onClose={() => setIsCourierModalOpen(false)}
        courierToEdit={courierToEdit}
        onSave={handleSaveCourier}
      />

      <QuickOrderModal
        isOpen={isAddOrderOpen}
        onClose={() => {
          setIsAddOrderOpen(false);
          setSelectedCourierForOrder(null);
        }}
        couriers={couriers}
        initialCourier={selectedCourierForOrder}
        onAddOrder={(single) => handleLocatSyncIngest([single])}
        onPasteJson={handleLocatSyncIngest}
      />

      <GuideWalkthroughModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
        onOpenWhatsApp={() => setIsWhatsAppModalOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenCouriers={() => setCurrentTab('couriers')}
      />

      <OfflineIndicator />
    </div>
  );
}
