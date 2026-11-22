import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  GitBranch,
  HardDrive,
  Laptop,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { EngineMode, EngineRuntimeConfig } from '../services/localEngine';
import {
  getEngineConfig,
  probeBackendHealth,
  subscribeEngineConfig,
  updateEngineMode,
} from '../services/apiBridge';
import { exportFullDatabase, importFullDatabase } from '../services/localEngine';

interface StandaloneAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged: () => void;
}

const WINDOWS_BAT_CONTENT = `@echo off
chcp 65001 >nul
title Locat Monitor - Local Desktop App
echo ========================================================
echo   Locat Monitor - تشغيل التطبيق محلياً بدون استضافة
echo ========================================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [!] Node.js غير مثبت على جهازك. يرجى تثبيت Node.js LTS من https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [*] جاري تثبيت الحزم المطلوبة لأول مرة فقط...
  call npm install
)
echo [*] جاري تشغيل محرك التطبيق والواتساب محلياً على المنفذ 3000...
start "" cmd /c "timeout /t 4 /nobreak >nul && (start msedge --app=http://localhost:3000 || start chrome --app=http://localhost:3000 || start http://localhost:3000)"
call npm run dev
pause
`;

const MAC_LINUX_SH_CONTENT = `#!/usr/bin/env bash
set -e
echo "========================================================"
echo "  Locat Monitor - Local Standalone Desktop Runner"
echo "========================================================"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed. Download LTS from https://nodejs.org"
  exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "[*] Installing dependencies (first run only)..."
  npm install
fi
(
  sleep 4
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3000"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:3000"
  fi
) &
npm run dev
`;

export const StandaloneAppModal: React.FC<StandaloneAppModalProps> = ({
  isOpen,
  onClose,
  onDataChanged,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [engineConfig, setEngineConfig] = useState<EngineRuntimeConfig>(getEngineConfig());
  const [localUrl, setLocalUrl] = useState(engineConfig.localServerUrl || 'http://localhost:3000');
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [notifPermission, setNotifPermission] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return subscribeEngineConfig((cfg) => {
      setEngineConfig(cfg);
    });
  }, []);

  if (!isOpen) return null;

  const handleModeChange = async (mode: EngineMode) => {
    setStatusMsg(null);
    updateEngineMode(mode, localUrl);
    if (mode === 'standalone') {
      setStatusMsg({
        type: 'success',
        text: 'تم تفعيل الوضع المستقل 100%: يعمل التطبيق الآن مباشرة من جهازك ويتصل بـ لوكيت دون الحاجة لأي سيرفر أو استضافة!',
      });
    } else if (mode === 'local_server') {
      setProbing(true);
      const ok = await probeBackendHealth(localUrl.trim().replace(/\/+$/, ''));
      setProbing(false);
      setStatusMsg(
        ok
          ? { type: 'success', text: `تم الاتصال بنجاح بسيرفرك المحلي على ${localUrl} (مع تشغيل Baileys QR محلياً)!` }
          : { type: 'error', text: `لم يتم العثور على سيرفر يعمل على ${localUrl} حالياً — تم تفعيل المحرك المستقل تلقائياً حتى تقوم بتشغيله.` }
      );
    } else {
      setStatusMsg({ type: 'success', text: 'تم تفعيل الوضع التلقائي الذكي (يتصل بالسيرفر إذا توفر، ويتحول للمحرك المستقل تلقائياً عند انقطاع الاستضافة).' });
    }
    onDataChanged();
  };

  const handleRequestNotifications = async () => {
    if (typeof Notification === 'undefined') {
      setStatusMsg({ type: 'error', text: 'متصفحك لا يدعم إشعارات سطح المكتب.' });
      return;
    }
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      new Notification('نظام متابعة لوكيت المستقل', {
        body: 'تم تفعيل الإشعارات الفورية للتأخيرات بنجاح!',
        icon: '/pwa-192x192.png',
      });
      setStatusMsg({ type: 'success', text: 'تم تفعيل إشعارات سطح المكتب والهاتف بنجاح!' });
    } else {
      setStatusMsg({ type: 'error', text: 'تم رفض إذن الإشعارات من إعدادات المتصفح.' });
    }
  };

  const downloadTextFile = (filename: string, content: string, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportBackup = async () => {
    const json = await exportFullDatabase();
    downloadTextFile(`locat_database_backup_${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json');
    setStatusMsg({ type: 'success', text: 'تم تنزيل نسخة احتياطية كاملة لجميع الطلبات والمناديب والإعدادات!' });
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      if (!content) return;
      const res = await importFullDatabase(content);
      setStatusMsg({ type: res.success ? 'success' : 'error', text: res.message });
      if (res.success) onDataChanged();
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200 my-6">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-xs">
              <Laptop className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">مركز التشغيل المستقل 100% (بدون استضافة)</h2>
              <p className="text-xs text-slate-500">
                تثبيت كتطبيق على جهازك + محرك سحب ومراقبة محلي يعمل حتى لو توقفت الاستضافة السحابية
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-xs">
          {statusMsg && (
            <div
              className={`p-3 rounded-xl border font-bold flex items-center gap-2 ${
                statusMsg.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{statusMsg.text}</span>
            </div>
          )}

          {/* Section 1: Install as PWA App */}
          <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-700" />
                <h3 className="font-bold text-sm text-slate-900">1. تثبيت البرنامج كتطبيق مستقل على الجهاز (PWA)</h3>
              </div>
              {isInstalled ? (
                <span className="px-2.5 py-1 rounded-full bg-emerald-600 text-white font-bold text-[11px]">
                  ✅ مثبت كتطبيق مستقل
                </span>
              ) : isInstallable ? (
                <button
                  type="button"
                  onClick={install}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-1.5 shadow-xs transition cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>تثبيت التطبيق على جهازك الآن</span>
                </button>
              ) : null}
            </div>
            <p className="text-slate-600 leading-relaxed">
              عند تثبيت التطبيق، يفتح في نافذة مستقلة خاصة به على الكمبيوتر أو الجوال، ويحفظ جميع ملفاته وبياناته محلياً في قاعدة بيانات الجهاز (<span className="font-mono">IndexedDB</span>) ويعمل فوراً حتى لو توقف السيرفر أو انقطعت الاستضافة.
            </p>
            {!isInstalled && !isInstallable && (
              <div className="p-2.5 bg-white rounded-lg border border-emerald-200 text-[11px] text-slate-700">
                {isIOS
                  ? 'على الآيفون/الآيباد: اضغط زر المشاركة (Share) في Safari ثم اختر "إضافة إلى الشاشة الرئيسية".'
                  : 'في Chrome / Edge: اضغط على أيقونة التثبيت (+) في شريط العنوان أعلى المتصفح لتثبيت التطبيق فوراً على سطح المكتب.'}
              </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-emerald-200/70">
              <div className="flex items-center gap-2 text-slate-700">
                <Bell className="w-4 h-4 text-amber-600" />
                <span>إشعارات سطح المكتب والهاتف الفورية عند التأخير:</span>
              </div>
              <button
                type="button"
                onClick={handleRequestNotifications}
                className={`px-3 py-1.5 rounded-lg font-bold transition ${
                  notifPermission === 'granted'
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                }`}
              >
                {notifPermission === 'granted' ? '✅ الإشعارات مفعّلة' : 'تفعيل الإشعارات'}
              </button>
            </div>
          </div>

          {/* Section 2: Engine Mode Switcher */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-indigo-600" />
                <h3 className="font-bold text-sm text-slate-900">2. وضع تشغيل المحرك (Engine Mode)</h3>
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-900 text-white">
                {engineConfig.activeBackend === 'standalone'
                  ? 'يعمل الآن: مستقل 100% على جهازك'
                  : engineConfig.activeBackend === 'local_server'
                  ? 'يعمل الآن: سيرفر جهازك المحلي'
                  : 'يعمل الآن: الوضع التلقائي'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleModeChange('auto')}
                className={`p-3 rounded-xl border text-right transition ${
                  engineConfig.mode === 'auto'
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <div className="font-bold mb-1 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  <span>تلقائي ذكي (موصى به)</span>
                </div>
                <div className={`text-[10px] ${engineConfig.mode === 'auto' ? 'text-emerald-50' : 'text-slate-500'}`}>
                  يتصل بالسيرفر إن وجد، ويتحول للوضع المستقل فوراً عند توقف الاستضافة.
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleModeChange('standalone')}
                className={`p-3 rounded-xl border text-right transition ${
                  engineConfig.mode === 'standalone'
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <div className="font-bold mb-1 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>مستقل 100% بدون سيرفر</span>
                </div>
                <div className={`text-[10px] ${engineConfig.mode === 'standalone' ? 'text-emerald-50' : 'text-slate-500'}`}>
                  يسحب مباشرة من لوكيت من جهازك دون الاعتماد على أي استضافة.
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleModeChange('local_server')}
                className={`p-3 rounded-xl border text-right transition ${
                  engineConfig.mode === 'local_server'
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <div className="font-bold mb-1 flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5" />
                  <span>ربط بسيرفر جهازك الشخصي</span>
                </div>
                <div className={`text-[10px] ${engineConfig.mode === 'local_server' ? 'text-emerald-50' : 'text-slate-500'}`}>
                  يربط التطبيق بتشغيلك المحلي على الكمبيوتر (لتفعيل Baileys QR تلقائياً).
                </div>
              </button>
            </div>

            {engineConfig.mode === 'local_server' && (
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="url"
                  value={localUrl}
                  onChange={(e) => setLocalUrl(e.target.value)}
                  placeholder="http://localhost:3000"
                  className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-lg font-mono text-xs"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => handleModeChange('local_server')}
                  disabled={probing}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`} />
                  <span>فحص واتصال</span>
                </button>
              </div>
            )}
          </div>

          {/* Section 3: 1-Click Local Desktop Runner (For Full Baileys Auto-WhatsApp with ZERO Hosting) */}
          <div className="p-4 rounded-xl bg-indigo-50/60 border border-indigo-200 space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-indigo-700" />
              <h3 className="font-bold text-sm text-slate-900">
                3. التشغيل الدائم على جهازك الشخصي (لإرسال Baileys التلقائي 100% بدون استضافة)
              </h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              لأن بروتوكول واتساب (Baileys QR) يتطلب Node.js، يمكنك تشغيل البرنامج بالكامل على كمبيوترك الشخصي بنقرة واحدة بدون رفع على أي استضافة وبدون أي تكلفة أو توقف. حمّل ملف التشغيل وضعه في مجلد المشروع واضغط عليه مرتين ليفتح كبرنامج مستقل:
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadTextFile('start-local.bat', WINDOWS_BAT_CONTENT)}
                className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold flex items-center gap-1.5 shadow-2xs transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>تحميل مشغّل ويندوز (start-local.bat)</span>
              </button>
              <button
                type="button"
                onClick={() => downloadTextFile('start-local.sh', MAC_LINUX_SH_CONTENT)}
                className="px-3.5 py-2 bg-white hover:bg-indigo-100 text-indigo-900 border border-indigo-300 rounded-lg font-bold flex items-center gap-1.5 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>تحميل مشغّل Mac / Linux (start-local.sh)</span>
              </button>
            </div>
          </div>

          {/* Section 4: GitHub Actions Auto-App Builder (.exe + .apk + Free Pages PWA) */}
          <div className="p-4 rounded-xl bg-slate-900 text-slate-100 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-emerald-400" />
                <h3 className="font-bold text-sm text-white">
                  4. الرفع على GitHub وتحويله تلقائياً لتطبيق (.exe و .apk و PWA)
                </h3>
              </div>
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">
                GitHub Actions جاهز
              </span>
            </div>
            <p className="text-slate-300 leading-relaxed">
              تم تضمين ملفات البناء التلقائي داخل مجلد <span className="font-mono text-emerald-300">.github/workflows/</span>. بمجرد رفع المشروع إلى مستودعك في GitHub، سيقوم ببناء 3 تطبيقات تلقائياً:
            </p>
            <ul className="space-y-1 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong className="text-white">برنامج ويندوز (.exe):</strong> ملف تثبيت + نسخة محمولة تتضمن خادم Baileys QR وتعمل في شريط النظام بدون Node.js.
              </li>
              <li>
                <strong className="text-white">تطبيق أندرويد (.apk):</strong> ملف جاهز للتثبيت المباشر على جوالات الأندرويد عبر Capacitor.
              </li>
              <li>
                <strong className="text-white">تطبيق ويب PWA مجاني (GitHub Pages):</strong> من <span className="font-mono text-amber-300">Settings &gt; Pages &gt; GitHub Actions</span>.
              </li>
            </ul>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-300 space-y-1" dir="ltr">
              <div className="flex items-center justify-between text-slate-400 text-[10px] pb-1 border-b border-slate-800">
                <span>أوامر الرفع إلى مستودع GitHub الجديد:</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      'git init && git add . && git commit -m "Build Locat Monitor App" && git branch -M main && git remote add origin https://github.com/USERNAME/REPO_NAME.git && git push -u origin main'
                    );
                    setStatusMsg({ type: 'success', text: 'تم نسخ أوامر الرفع إلى GitHub! استبدل USERNAME و REPO_NAME باسم مستودعك.' });
                  }}
                  className="inline-flex items-center gap-1 text-emerald-300 hover:text-white cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>نسخ</span>
                </button>
              </div>
              <div className="overflow-x-auto whitespace-nowrap">
                git init &amp;&amp; git add . &amp;&amp; git commit -m &quot;Build Locat Monitor App&quot;
              </div>
              <div className="overflow-x-auto whitespace-nowrap">
                git branch -M main &amp;&amp; git remote add origin https://github.com/USERNAME/REPO_NAME.git
              </div>
              <div className="overflow-x-auto whitespace-nowrap">git push -u origin main</div>
            </div>
          </div>

          {/* Section 5: Full Database Backup & Restore */}
          <div className="p-4 rounded-xl bg-white border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-bold text-slate-900 text-xs">النسخ الاحتياطي ونقل البيانات محلياً</div>
              <div className="text-[11px] text-slate-500">
                تصدير أو استيراد كامل قاعدة البيانات (الطلبات، المناديب، الأرقام المثبتة، والإعدادات)
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleExportBackup}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg font-bold flex items-center gap-1 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>تصدير نسخة</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold flex items-center gap-1 transition"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>استيراد نسخة</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportBackup}
                className="hidden"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
