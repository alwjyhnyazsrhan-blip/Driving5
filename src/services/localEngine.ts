import {
  AlertLog,
  CloudSyncState,
  Courier,
  CourierPerformanceItem,
  DailyReportSummary,
  Order,
  OrderStatus,
  PuppeteerScraperStatus,
  QueuedWhatsAppMessage,
  SystemSettings,
  WhatsAppConnectionState,
} from '../types';

export type EngineMode = 'auto' | 'standalone' | 'local_server';

export interface EngineRuntimeConfig {
  mode: EngineMode;
  localServerUrl: string;
  activeBackend: 'server' | 'standalone' | 'local_server';
  lastFallbackReason?: string;
  notificationsEnabled: boolean;
}

const DB_NAME = 'locat_monitor_standalone_db';
const DB_VERSION = 1;
const STORE_NAME = 'app_state';
const STATE_KEY = 'main_database';
const CONFIG_STORAGE_KEY = 'locat_engine_config';
const FALLBACK_LS_KEY = 'locat_standalone_snapshot_v1';

const DEFAULT_SETTINGS: SystemSettings = {
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
  lastAutoDailyReportDate: undefined,
  whatsAppProvider: 'direct_chat',
  webhookUrl: '',
  webhookApiKey: '',
  locatSyncIntervalSeconds: 20,
  locatApiKey: 'locat_secret_key_8892',
  enablePuppeteerHeadless: false,
  locateUsername: '',
  locatePassword: '',
  locateEmail: '',
  locateCompanyId: '',
  locateAccessToken: '',
  enableCloudAutoSync: true,
};

interface PersistedDatabase {
  settings: SystemSettings;
  couriers: Courier[];
  orders: Order[];
  alerts: AlertLog[];
  customCourierPhones: Record<string, { phone: string; name?: string; updatedAt: string }>;
  updatedAt: string;
}

let dbState: PersistedDatabase = {
  settings: { ...DEFAULT_SETTINGS },
  couriers: [],
  orders: [],
  alerts: [],
  customCourierPhones: {},
  updatedAt: new Date().toISOString(),
};

let cloudSyncState: CloudSyncState = {
  isActive: true,
  status: 'idle',
  lastCount: 0,
  hasCredentials: false,
  hasToken: false,
};

const whatsappState: WhatsAppConnectionState = {
  status: 'disconnected',
  isLoggedIn: false,
  qrDataUrl: null,
  qrRaw: null,
  lastConnectedAt: null,
  lastError: 'وضع المتصفح المستقل يستخدم إشعارات النظام + رابط الواتساب المباشر + Webhook (لتشغيل Baileys QR تلقائياً شغّل الحزمة المحلية على جهازك)',
};

const puppeteerStatus: PuppeteerScraperStatus = {
  enabled: false,
  isRunning: false,
  status: 'idle',
  lastScrapedCount: 0,
};

const alertCooldownMap = new Map<string, number>();
let messageQueue: QueuedWhatsAppMessage[] = [];
let isQueueProcessing = false;
let queueStats = {
  totalProcessed: 0,
  totalSent: 0,
  totalSkippedCooldown: 0,
};

let isInitialized = false;
let initPromise: Promise<void> | null = null;
let cloudSyncTimer: ReturnType<typeof setInterval> | null = null;
let watcherTimer: ReturnType<typeof setInterval> | null = null;

// --- CONFIG MANAGEMENT ---
export function loadEngineConfig(): EngineRuntimeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        mode: parsed.mode === 'standalone' || parsed.mode === 'local_server' ? parsed.mode : 'auto',
        localServerUrl: parsed.localServerUrl || 'http://localhost:3000',
        activeBackend: parsed.mode === 'standalone' ? 'standalone' : parsed.mode === 'local_server' ? 'local_server' : 'server',
        notificationsEnabled: Boolean(parsed.notificationsEnabled),
      };
    }
  } catch {}
  return {
    mode: 'auto',
    localServerUrl: 'http://localhost:3000',
    activeBackend: 'server',
    notificationsEnabled: typeof Notification !== 'undefined' && Notification.permission === 'granted',
  };
}

export function saveEngineConfig(partial: Partial<EngineRuntimeConfig>): EngineRuntimeConfig {
  const current = loadEngineConfig();
  const next = { ...current, ...partial };
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

// --- INDEXEDDB PERSISTENCE ---
function openIndexedDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadFromBrowserStorage(): Promise<void> {
  let loaded: PersistedDatabase | null = null;
  const db = await openIndexedDb();
  if (db) {
    loaded = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(STATE_KEY);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  if (!loaded) {
    try {
      const raw = localStorage.getItem(FALLBACK_LS_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch {}
  }

  // Merge any legacy locat_settings / locat_custom_couriers stored by earlier versions
  try {
    const legacySettings = localStorage.getItem('locat_settings');
    if (legacySettings) {
      const parsed = JSON.parse(legacySettings);
      dbState.settings = { ...dbState.settings, ...parsed };
    }
  } catch {}

  if (loaded) {
    if (loaded.settings) dbState.settings = { ...DEFAULT_SETTINGS, ...dbState.settings, ...loaded.settings };
    if (Array.isArray(loaded.couriers)) dbState.couriers = loaded.couriers;
    if (Array.isArray(loaded.orders)) dbState.orders = loaded.orders;
    if (Array.isArray(loaded.alerts)) dbState.alerts = loaded.alerts;
    if (loaded.customCourierPhones) dbState.customCourierPhones = loaded.customCourierPhones;
  }

  try {
    const legacyCustom = localStorage.getItem('locat_custom_couriers');
    if (legacyCustom) {
      const parsed = JSON.parse(legacyCustom);
      if (parsed && typeof parsed === 'object') {
        dbState.customCourierPhones = { ...dbState.customCourierPhones, ...parsed };
      }
    }
  } catch {}
}

let persistTimeout: ReturnType<typeof setTimeout> | null = null;
async function persistToBrowserStorage(): Promise<void> {
  dbState.updatedAt = new Date().toISOString();
  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(async () => {
    try {
      localStorage.setItem('locat_settings', JSON.stringify(dbState.settings));
    } catch {}

    const db = await openIndexedDb();
    if (db) {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(dbState, STATE_KEY);
      } catch {}
    }

    try {
      // Keep a compact snapshot in localStorage as secondary redundancy
      const snapshot = {
        ...dbState,
        orders: dbState.orders.slice(0, 300),
        alerts: dbState.alerts.slice(0, 200),
      };
      localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(snapshot));
    } catch {}
  }, 150);
}

export async function ensureLocalEngineInitialized(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await loadFromBrowserStorage();
    isInitialized = true;
  })();
  return initPromise;
}

// Mirror live data received from a connected Node server into local IndexedDB so switching offline is seamless
export async function mirrorServerDataToLocal(endpoint: string, data: any): Promise<void> {
  await ensureLocalEngineInitialized();
  if (!data || !data.success) return;

  let changed = false;
  if (endpoint === '/api/settings' && data.settings) {
    dbState.settings = { ...dbState.settings, ...data.settings };
    changed = true;
  } else if (endpoint === '/api/couriers' && Array.isArray(data.couriers)) {
    dbState.couriers = data.couriers;
    changed = true;
  } else if (endpoint === '/api/orders' && Array.isArray(data.orders)) {
    dbState.orders = data.orders;
    changed = true;
  } else if (endpoint === '/api/alerts' && Array.isArray(data.alerts)) {
    dbState.alerts = data.alerts;
    changed = true;
  } else if (endpoint === '/api/locat/cloud-status' && data.cloudSyncState) {
    cloudSyncState = { ...cloudSyncState, ...data.cloudSyncState };
  }

  if (changed) {
    persistToBrowserStorage();
  }
}

// --- HELPERS (Mirroring server.ts logic identically) ---
function normalizeArabic(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ');
}

function stripDriverPrefix(name: string): string {
  if (!name) return '';
  return name.replace(/^#?\d+[\s\-_:]*/, '').trim();
}

function normalizeSaudiPhone(phone: string): string {
  if (!phone) return '';
  let digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.startsWith('00966')) digits = digits.slice(2);
  else if (digits.startsWith('05')) digits = '966' + digits.slice(1);
  else if (digits.startsWith('5') && digits.length === 9) digits = '966' + digits;
  return digits;
}

function formatPhoneForWhatsApp(phone: string): string {
  return normalizeSaudiPhone(phone);
}

function formatPhoneWithPlus(phone: string): string {
  const norm = normalizeSaudiPhone(phone);
  return norm ? `+${norm}` : String(phone).trim();
}

function matchDriverName(name1: string, name2: string): boolean {
  if (!name1 || !name2) return false;
  const n1 = normalizeArabic(name1);
  const n2 = normalizeArabic(name2);
  if (n1 === n2) return true;
  const s1 = normalizeArabic(stripDriverPrefix(name1));
  const s2 = normalizeArabic(stripDriverPrefix(name2));
  if (s1 && s2 && s1 === s2) return true;
  if (s1 && s2 && (s1.includes(s2) || s2.includes(s1))) return true;
  return false;
}

function getRiyadhTimeString(date: Date = new Date()): string {
  return date.toLocaleTimeString('ar-SA', {
    timeZone: 'Asia/Riyadh',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRiyadhDateKey(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
}

function getRiyadh24HourTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Riyadh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function isOrderFromToday(order: Order, todayKey: string = getRiyadhDateKey()): boolean {
  const refIso = order.deliveryTime || order.assignedAt || order.createdAt || order.lastUpdated;
  if (!refIso) return true;
  const parsed = new Date(refIso);
  if (isNaN(parsed.getTime())) return true;
  return getRiyadhDateKey(parsed) === todayKey;
}

const notifiedOrderAssignments = new Set<string>();

function findCourierForOrder(account?: string, courierName?: string, courierId?: string, courierPhone?: string): Courier | undefined {
  if (courierId) {
    const foundById = dbState.couriers.find((c) => c.id === courierId);
    if (foundById) return foundById;
  }
  const cleanAccount = normalizeArabic(account || '');
  const cleanName = normalizeArabic(courierName || '');
  const cleanPhone = normalizeSaudiPhone(courierPhone || '');

  return dbState.couriers.find((c) => {
    const cPhone = normalizeSaudiPhone(c.phone);
    if (cleanPhone && cPhone && (cleanPhone === cPhone || cleanPhone.endsWith(cPhone) || cPhone.endsWith(cleanPhone))) {
      return true;
    }
    if (cleanName && matchDriverName(c.name, cleanName)) return true;
    if (cleanAccount && matchDriverName(c.name, cleanAccount)) return true;
    return c.locatAccounts.some((acc) => matchDriverName(acc, cleanAccount) || matchDriverName(acc, cleanName));
  });
}

function applyCustomPhoneToCourier(courier: Courier, phone: string, name?: string) {
  const formatted = formatPhoneWithPlus(phone);
  courier.phone = formatted;
  courier.customPhone = formatted;
  courier.isCustomPhone = true;
  courier.updatedAt = new Date().toISOString();

  const driverName = name || courier.name;
  const stripped = stripDriverPrefix(driverName);
  const normName = normalizeArabic(driverName);
  const normStripped = normalizeArabic(stripped);

  const entry = { phone: formatted, name: driverName, updatedAt: new Date().toISOString() };
  dbState.customCourierPhones[courier.id] = entry;
  if (normName) dbState.customCourierPhones[normName] = entry;
  if (normStripped) dbState.customCourierPhones[normStripped] = entry;

  courier.locatAccounts.forEach((acc) => {
    const aNorm = normalizeArabic(acc);
    const aStripped = normalizeArabic(stripDriverPrefix(acc));
    if (aNorm) dbState.customCourierPhones[aNorm] = entry;
    if (aStripped) dbState.customCourierPhones[aStripped] = entry;
  });

  dbState.orders.forEach((o) => {
    const match = findCourierForOrder(o.locatAccount, o.courierName, o.courierId, o.courierPhone);
    if (match && match.id === courier.id) {
      o.courierId = courier.id;
      o.courierName = courier.name;
      o.courierPhone = formatted;
    }
  });

  persistToBrowserStorage();
}

function buildOrderAssignmentMessage(order: Order, _courierName: string): string {
  const riyadhNow = getRiyadhTimeString();
  return `🌟 يا هلا يا بطل، رزقك جايك في الطريق!\nعندك طلب جديد جاهز الآن (رقم الطلب: ${order.id}). انطلق وبارك الله في جهودك، موفق يا غالي!\n⏰ وقت الطلب الحالي: ${riyadhNow}`;
}

function buildCourierMessage(order: Order, courierName: string): string {
  const isDelivered = order.isDelivered || order.status === 'delivered';
  const riyadhNow = getRiyadhTimeString();
  if (isDelivered) {
    return `السلام عليكم أخي ${courierName}،\nبخصوص الطلب ${order.id} (المسلّم):\n• المطعم: ${order.restaurant}\n• المدة المستغرقة: ${order.elapsedMinutes} دقيقة\n• وقت الاستلام: ${order.pickupTime || 'غير محدد'}\n• وقت الإشعار: ${riyadhNow}\nشكراً لجهودك!`;
  }
  return `☕ الله يعطيك العافية ويقويك يا رب..\nملاحظين إن الطلب رقم ${order.id} أخذ وقت أطول شوي. عسى ما شر؟ هل تواجه أي مشكلة أو ظرف في الطريق نقدر نساعدك فيه؟ طمنا عليك.`;
}

function buildAdminMessage(order: Order, courierName: string, activeCount: number): string {
  const riyadhNow = getRiyadhTimeString();
  const isDelivered = order.isDelivered || order.status === 'delivered';
  if (isDelivered) {
    return `ℹ️ [إشعار طلب مسلّم - لوكيت]\n• رقم الطلب: ${order.id}\n• المندوب: ${courierName}\n• الحالة: تم التسليم بنجاح\n• المدة المستغرقة: ${order.elapsedMinutes} دقيقة\n• وقت الاستلام: ${order.pickupTime || 'غير محدد'}\n• وقت الإشعار: ${riyadhNow}\n• المطعم: ${order.restaurant}`;
  }
  return `🚨 [تنبيه تأخير طلب - لوكيت]\n• رقم الطلب: ${order.id}\n• المندوب: ${courierName}\n• المدة المستغرقة: ${order.elapsedMinutes} دقيقة (الحد المسموح: ${dbState.settings.delayThresholdMinutes} دقيقة)\n• وقت الاستلام: ${order.pickupTime || 'غير محدد'}\n• وقت التنبيه: ${riyadhNow}\n• عدد الطلبات النشطة بحوزته: ${activeCount} طلبات\n• المطعم: ${order.restaurant}\n• الحي: ${order.customerAddress || 'غير محدد'}`;
}

function buildAdminCriticalDelayMessage(order: Order, courierName: string, courierPhone: string, activeCount: number): string {
  const riyadhNow = getRiyadhTimeString();
  const cleanCourierPhone = courierPhone ? formatPhoneForWhatsApp(courierPhone) : '';
  const waCourierDirectLink = cleanCourierPhone ? `https://wa.me/${cleanCourierPhone}` : '';
  const critThreshold = Number(dbState.settings.criticalDelayMinutes) || 45;

  let msg = `🚨 *[تنبيه تأخير حرج - تجاوز ${critThreshold} دقيقة]*\n`;
  msg += `نحيطكم علماً بأن الطلب استمر بالتأخير وتجاوز *${order.elapsedMinutes} دقيقة* دون إتمام التسليم.\n`;
  msg += `يرجى التواصل الفوري مع المندوب لمتابعة الحالة.\n\n`;
  msg += `🛵 *بيانات المندوب للمتابعة:*\n`;
  msg += `• اسم المندوب: *${courierName}*\n`;
  msg += `• جوال المندوب: *${courierPhone || 'غير مسجل'}*\n`;
  msg += `• عدد الطلبات النشطة بحوزته: *${activeCount}* طلبات\n`;
  if (waCourierDirectLink) {
    msg += `💬 *رابط محادثة واتساب المباشرة مع المندوب:*\n${waCourierDirectLink}\n`;
  }
  msg += `\n📋 *تفاصيل الطلب:*\n`;
  msg += `• رقم الطلب: *${order.id}*\n`;
  msg += `• المطعم / المتجر: ${order.restaurant}\n`;
  msg += `• وجهة العميل: ${order.customerAddress || 'الوجهة المحددة'}\n`;
  msg += `• وقت الاستلام: ${order.pickupTime || 'غير محدد'}\n`;
  msg += `• المدة المستغرقة: *${order.elapsedMinutes} دقيقة* (تأخر عن ${critThreshold} دقيقة)\n`;
  msg += `• وقت التنبيه: ${riyadhNow}\n`;
  msg += `───────────────────────\n`;
  msg += `⚠️ تم التوليد تلقائياً عبر تطبيق متابعة لوكيت المستقل.`;
  return msg;
}

function notifyBrowserDesktop(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body,
      icon: '/pwa-192x192.png',
      dir: 'rtl',
      lang: 'ar',
    });
  } catch {}
}

async function dispatchWhatsAppStandalone(phone: string, text: string): Promise<{ success: boolean; method: string; waLink: string; error?: string }> {
  const cleanPhone = formatPhoneForWhatsApp(phone);
  const waLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;

  // 1. Forward to Webhook URL / Meta WhatsApp Cloud API / UltraMsg / Green-API / CallMeBot if configured
  if (dbState.settings.webhookUrl && dbState.settings.webhookUrl.trim().startsWith('http')) {
    const targetUrl = dbState.settings.webhookUrl.trim();
    const isMetaCloudApi = targetUrl.includes('graph.facebook.com');
    const isUltraMsg = targetUrl.includes('ultramsg.com');
    const isCallMeBot = targetUrl.includes('callmebot.com');
    const apiKey = (dbState.settings.webhookApiKey || '').trim();

    try {
      if (isCallMeBot) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        const cmbUrl = `${targetUrl}${sep}phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(text)}${apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ''}`;
        const res = await fetch(cmbUrl, { method: 'GET' });
        if (res.ok) {
          return { success: true, method: 'webhook_gateway', waLink };
        }
        const errText = await res.text().catch(() => '');
        return { success: false, method: 'webhook_error', waLink, error: errText || `HTTP ${res.status}` };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        if (!isMetaCloudApi && !isUltraMsg) {
          headers['x-api-key'] = apiKey;
        }
      }
      const payload = isMetaCloudApi
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'text',
            text: { preview_url: false, body: text },
          }
        : isUltraMsg
        ? {
            token: apiKey,
            to: `+${cleanPhone}`,
            body: text,
          }
        : {
            phone: cleanPhone,
            to: cleanPhone,
            number: cleanPhone,
            chatId: `${cleanPhone}@c.us`,
            message: text,
            body: text,
            text,
            token: apiKey || undefined,
            apiKey: apiKey || undefined,
            timestamp: new Date().toISOString(),
            riyadhTime: getRiyadhTimeString(),
          };

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        return { success: true, method: isMetaCloudApi ? 'meta_cloud_api' : 'webhook_gateway', waLink };
      }
      const errText = await res.text().catch(() => '');
      return { success: false, method: 'webhook_error', waLink, error: errText || `HTTP ${res.status}` };
    } catch (e: any) {
      return { success: false, method: 'webhook_error', waLink, error: e?.message };
    }
  }

  return { success: true, method: 'standalone_notification_and_walink', waLink };
}

function enqueueAlert(
  recipientType: 'courier' | 'admin' | 'admin2',
  recipientName: string,
  recipientPhone: string,
  orderId: string,
  message: string,
  customCooldownKey?: string
) {
  if (!recipientPhone && recipientType !== 'courier') return;
  const cooldownKey = customCooldownKey || `${orderId}_${recipientType}`;
  const lastSent = alertCooldownMap.get(cooldownKey) || 0;
  const cooldownMs = (dbState.settings.alertCooldownMinutes || 20) * 60 * 1000;

  if (Date.now() - lastSent < cooldownMs) {
    queueStats.totalSkippedCooldown++;
    messageQueue.unshift({
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      recipientType,
      recipientName,
      recipientPhone,
      orderId,
      message,
      status: 'skipped_cooldown',
      delayAppliedSeconds: 0,
      scheduledAt: new Date().toISOString(),
      error: `فترة Cooldown نشطة (${dbState.settings.alertCooldownMinutes} دقيقة)`,
    });
    return;
  }

  const minDelay = dbState.settings.antiBanMinDelaySeconds || 5;
  const maxDelay = Math.max(minDelay, dbState.settings.antiBanMaxDelaySeconds || 10);
  const delaySeconds = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  const cleanPhone = formatPhoneForWhatsApp(recipientPhone);
  const waLink = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}` : '';

  messageQueue.push({
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    recipientType,
    recipientName,
    recipientPhone,
    orderId,
    message,
    status: 'waiting',
    delayAppliedSeconds: delaySeconds,
    scheduledAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    waLink,
  });

  alertCooldownMap.set(cooldownKey, Date.now());
  processQueue();
}

async function processQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  while (messageQueue.some((i) => i.status === 'waiting')) {
    const nextItem = messageQueue.find((i) => i.status === 'waiting');
    if (!nextItem) break;
    nextItem.status = 'sending';
    await new Promise((r) => setTimeout(r, Math.min(nextItem.delayAppliedSeconds, 10) * 1000));

    const sendRes = await dispatchWhatsAppStandalone(nextItem.recipientPhone, nextItem.message);
    nextItem.status = 'sent';
    nextItem.sentAt = new Date().toISOString();
    nextItem.waLink = sendRes.waLink;
    queueStats.totalProcessed++;
    queueStats.totalSent++;

    dbState.alerts.unshift({
      id: `alt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      recipientType: nextItem.recipientType,
      recipientName: nextItem.recipientName,
      recipientPhone: nextItem.recipientPhone,
      orderId: nextItem.orderId,
      elapsedMinutes: 0,
      activeOrdersCount: 0,
      message: nextItem.message,
      status: 'sent',
      waLink: sendRes.waLink,
      delayAppliedSeconds: nextItem.delayAppliedSeconds,
    });

    notifyBrowserDesktop(
      `تنبيه تأخير طلب ${nextItem.orderId}`,
      `${nextItem.recipientName}: جاهز للإرسال عبر الواتساب`
    );
    persistToBrowserStorage();
  }

  isQueueProcessing = false;
}

function triggerAlertsForOrder(order: Order) {
  const courier = findCourierForOrder(order.locatAccount, order.courierName, order.courierId, order.courierPhone);
  const courierName = courier ? courier.name : (order.courierName || 'المندوب');
  const courierPhone = (courier?.isCustomPhone && courier?.phone) || courier?.phone || order.courierPhone || '';
  const activeCount = order.activeOrdersHeldByCourier || (courier ? courier.activeOrdersCount : 1);

  if (courierPhone && !order.courierPhone) order.courierPhone = courierPhone;
  if (courier) {
    order.courierId = courier.id;
    order.courierName = courier.name;
  }

  if (order.elapsedMinutes >= dbState.settings.delayThresholdMinutes && !order.alertSentToCourier && dbState.settings.autoAlertCourier && courierPhone) {
    const msg = buildCourierMessage(order, courierName);
    enqueueAlert('courier', courierName, courierPhone, order.id, msg);
    order.alertSentToCourier = true;
    order.courierAlertTime = getRiyadhTimeString();
  }

  const criticalMinutes = Number(dbState.settings.criticalDelayMinutes) || 45;
  if (order.elapsedMinutes >= criticalMinutes && !order.alertSentToAdmin && dbState.settings.autoAlertAdmin && dbState.settings.adminPhone) {
    const adminMsg = buildAdminCriticalDelayMessage(order, courierName, courierPhone, activeCount);
    enqueueAlert('admin', dbState.settings.adminName || 'مشرف العمليات', dbState.settings.adminPhone, order.id, adminMsg);
    order.alertSentToAdmin = true;
    order.adminAlertTime = getRiyadhTimeString();
  }

  if (order.elapsedMinutes >= criticalMinutes && !order.alertSentToAdmin2 && dbState.settings.autoAlertAdmin2 && dbState.settings.adminPhone2) {
    const admin2Msg = buildAdminCriticalDelayMessage(order, courierName, courierPhone, activeCount);
    enqueueAlert('admin2', dbState.settings.adminName2 || 'إدارة العمليات 2', dbState.settings.adminPhone2, order.id, admin2Msg);
    order.alertSentToAdmin2 = true;
    order.admin2AlertTime = getRiyadhTimeString();
  }
}

function triggerAssignmentNotificationForOrder(order: Order): boolean {
  if (dbState.settings.autoNotifyOrderAssignment === false) return false;
  if (order.isDelivered || order.isCanceled || order.status === 'delivered' || order.status === 'cancelled') {
    return false;
  }

  const courier = findCourierForOrder(order.locatAccount, order.courierName, order.courierId, order.courierPhone);
  const courierName = courier ? courier.name : (order.courierName || 'المندوب');
  const courierPhone = (courier?.isCustomPhone && courier?.phone) || courier?.phone || order.courierPhone || '';

  if (courierPhone && !order.courierPhone) order.courierPhone = courierPhone;
  if (courier) {
    order.courierId = courier.id;
    order.courierName = courier.name;
  }
  if (!courierPhone) return false;

  const courierKey = courier?.id || order.locatAccount || courierPhone;
  const assignKey = `${order.id}__${courierKey}`;
  if (order.assignmentNotifiedToCourier || notifiedOrderAssignments.has(assignKey)) {
    return false;
  }

  const msg = buildOrderAssignmentMessage(order, courierName);
  enqueueAlert('courier', courierName, courierPhone, order.id, msg, `${order.id}_assignment_${courierKey}`);
  notifiedOrderAssignments.add(assignKey);
  order.assignmentNotifiedToCourier = true;
  order.assignmentNotifiedTime = getRiyadhTimeString();
  return true;
}

function checkAutomatedAlerts() {
  const now = Date.now();
  let changed = false;
  dbState.orders.forEach((order) => {
    if (order.isDelivered || order.isCanceled || order.status === 'delivered' || order.status === 'cancelled') return;
    const startIso = order.assignedAt || order.createdAt;
    if (startIso) {
      const startMs = new Date(startIso).getTime();
      if (!isNaN(startMs) && startMs > 0) {
        order.elapsedMinutes = Math.max(0, Math.floor((now - startMs) / 60000));
      }
    }
    const isDelayed = order.elapsedMinutes >= dbState.settings.delayThresholdMinutes;
    order.isDelayed = isDelayed;
    if (isDelayed && order.status !== 'delayed') {
      order.status = 'delayed';
      changed = true;
    }
    const beforeCourier = order.alertSentToCourier;
    const beforeAdmin = order.alertSentToAdmin;
    const beforeAdmin2 = order.alertSentToAdmin2;
    triggerAlertsForOrder(order);
    if (beforeCourier !== order.alertSentToCourier || beforeAdmin !== order.alertSentToAdmin || beforeAdmin2 !== order.alertSentToAdmin2) {
      changed = true;
    }
  });
  if (changed) persistToBrowserStorage();
}

// --- DIRECT CLIENT-SIDE LOCATE API SYNC ---
async function autoLoginToLocatCloud(email: string, password: string, companyId?: string): Promise<{ token?: string; companyId?: string; error?: string }> {
  try {
    let resolvedCompanyId = companyId?.trim();
    if (!resolvedCompanyId) {
      try {
        const preRes = await fetch('https://api.supplier.locate.sa/api/v1/partners/pre-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (preRes.ok) {
          const preData: any = await preRes.json();
          if (Array.isArray(preData.companies) && preData.companies.length > 0) {
            resolvedCompanyId = String(preData.companies[0].id);
          }
        }
      } catch {}
    }
    if (!resolvedCompanyId) resolvedCompanyId = '1';

    const loginRes = await fetch('https://api.supplier.locate.sa/api/v1/partners/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim(),
        password: password.trim(),
        company_id: String(resolvedCompanyId),
      }),
    });
    const loginData: any = await loginRes.json();
    if (!loginRes.ok) {
      const errMsg = loginData.message || loginData.error || 'فشل تسجيل الدخول إلى لوكيت';
      return { error: Array.isArray(errMsg) ? errMsg.join(', ') : String(errMsg) };
    }
    const token = loginData.accessToken || loginData.token || loginData.access_token || loginData.data?.accessToken;
    if (!token) return { error: 'لم يُرجع خادم لوكيت رمز التفويض (Access Token)' };
    return { token, companyId: resolvedCompanyId };
  } catch (err: any) {
    return { error: err?.message || 'تعذر الاتصال بخادم لوكيت مباشرة' };
  }
}

export async function executeStandaloneLocatSync(): Promise<{
  success: boolean;
  count: number;
  activeCount: number;
  couriersCount: number;
  message: string;
}> {
  if (cloudSyncState.status === 'syncing') {
    return { success: false, count: 0, activeCount: 0, couriersCount: 0, message: 'عملية السحب جارية حالياً...' };
  }
  if (dbState.settings.enableCloudAutoSync === false) {
    cloudSyncState.status = 'idle';
    return { success: false, count: 0, activeCount: 0, couriersCount: 0, message: 'السحب التلقائي معطل في الإعدادات' };
  }

  const email = dbState.settings.locateEmail?.trim() || dbState.settings.locateUsername?.trim();
  const password = dbState.settings.locatePassword?.trim();
  let token = dbState.settings.locateAccessToken?.trim();
  const companyId = dbState.settings.locateCompanyId?.trim() || '';

  if (!token && email && password) {
    cloudSyncState.status = 'syncing';
    const loginRes = await autoLoginToLocatCloud(email, password, companyId);
    if (loginRes.token) {
      token = loginRes.token;
      dbState.settings.locateAccessToken = token;
      if (loginRes.companyId && !dbState.settings.locateCompanyId) {
        dbState.settings.locateCompanyId = loginRes.companyId;
      }
      persistToBrowserStorage();
    } else {
      cloudSyncState.status = 'error';
      cloudSyncState.lastError = loginRes.error;
      return { success: false, count: 0, activeCount: 0, couriersCount: 0, message: loginRes.error || 'فشل تسجيل الدخول' };
    }
  }

  if (!token) {
    cloudSyncState.status = 'unauthenticated';
    cloudSyncState.isConfigured = false;
    cloudSyncState.hasCredentials = Boolean(email && password);
    cloudSyncState.hasToken = false;
    cloudSyncState.lastError = 'يرجى ربط حساب لوكيت من الإعدادات للبدء في السحب المباشر من جهازك';
    return { success: false, count: 0, activeCount: 0, couriersCount: 0, message: cloudSyncState.lastError };
  }

  cloudSyncState.status = 'syncing';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (companyId) headers['company-id'] = companyId;

  try {
    // 1. Fetch drivers
    let allDrivers: any[] = [];
    let dPage = 1;
    while (dPage <= 5) {
      const dRes = await fetch(`https://api.supplier.locate.sa/api/v1/suppliers/drivers?page=${dPage}&limit=100`, { headers });
      if (dRes.status === 401 && email && password) {
        const relogin = await autoLoginToLocatCloud(email, password, companyId);
        if (relogin.token) {
          token = relogin.token;
          dbState.settings.locateAccessToken = token;
          headers.Authorization = `Bearer ${token}`;
          persistToBrowserStorage();
          continue;
        }
      }
      if (!dRes.ok) break;
      const dJson: any = await dRes.json();
      const pageDrivers = dJson.data?.results || [];
      if (!Array.isArray(pageDrivers) || pageDrivers.length === 0) break;
      allDrivers.push(...pageDrivers);
      const total = dJson.data?.total || pageDrivers.length;
      if (allDrivers.length >= total) break;
      dPage++;
    }

    allDrivers.forEach((driver: any) => {
      const driverId = String(driver._id || driver.id || '');
      const driverName = String(driver.name || `${driver.firstName || ''} ${driver.lastName || ''}`).trim();
      const rawPhone = normalizeSaudiPhone(String(driver.phone || driver.mobile || ''));
      const formattedPhone = rawPhone ? `+${rawPhone}` : '';

      const existingIdx = dbState.couriers.findIndex(
        (c) =>
          c.id === driverId ||
          c.locatAccounts.includes(driverId) ||
          matchDriverName(c.name, driverName) ||
          c.locatAccounts.some((acc) => matchDriverName(acc, driverName))
      );

      const customEntry =
        (existingIdx !== -1 && dbState.customCourierPhones[dbState.couriers[existingIdx].id]) ||
        (driverId && dbState.customCourierPhones[driverId]) ||
        (driverName && dbState.customCourierPhones[normalizeArabic(driverName)]) ||
        (driverName && dbState.customCourierPhones[normalizeArabic(stripDriverPrefix(driverName))]);

      if (existingIdx !== -1) {
        const existing = dbState.couriers[existingIdx];
        if (existing.isCustomPhone || customEntry) {
          if (customEntry?.phone) {
            existing.phone = customEntry.phone;
            existing.customPhone = customEntry.phone;
          }
          existing.isCustomPhone = true;
        } else if (formattedPhone && (!existing.phone || existing.phone.length < 10)) {
          existing.phone = formattedPhone;
        }
        if (driverId && !existing.locatAccounts.includes(driverId)) existing.locatAccounts.push(driverId);
        if (driverName && !existing.locatAccounts.includes(driverName)) existing.locatAccounts.push(driverName);
        existing.status = driver.isActive === false ? 'idle' : 'active';
        existing.updatedAt = new Date().toISOString();
      } else {
        dbState.couriers.push({
          id: driverId || `c-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: driverName || 'مندوب لوكيت',
          firstName: driver.firstName || '',
          lastName: driver.lastName || '',
          idNumber: driver.id_number || '',
          cityId: driver.city_id || '',
          gift: typeof driver.gift === 'number' ? driver.gift : 0,
          balance: typeof driver.balance === 'number' ? driver.balance : 0,
          locatAccounts: [driverName, driverId].filter(Boolean),
          phone: customEntry?.phone || formattedPhone || '',
          customPhone: customEntry?.phone,
          isCustomPhone: Boolean(customEntry),
          status: driver.isActive === false ? 'idle' : 'active',
          activeOrdersCount: 0,
          totalDeliveredToday: 0,
          avgDeliveryTimeMinutes: 25,
          delayedOrdersCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }
    });

    // 2. Fetch orders
    let rawList: any[] = [];
    let oPage = 1;
    while (oPage <= 3) {
      let oRes = await fetch(`https://api.supplier.locate.sa/api/v2/orders?page=${oPage}&limit=100`, { headers });
      if (oRes.status === 401 && email && password) {
        const relogin = await autoLoginToLocatCloud(email, password, companyId);
        if (relogin.token) {
          token = relogin.token;
          dbState.settings.locateAccessToken = token;
          headers.Authorization = `Bearer ${token}`;
          persistToBrowserStorage();
          oRes = await fetch(`https://api.supplier.locate.sa/api/v2/orders?page=${oPage}&limit=100`, { headers });
        }
      }
      if (!oRes.ok) {
        if (oPage === 1) throw new Error(`استجابة لوكيت (${oRes.status})`);
        break;
      }
      const json: any = await oRes.json();
      const pageOrders: any[] = Array.isArray(json)
        ? json
        : json.results || json.data?.results || (Array.isArray(json.data) ? json.data : json.orders) || [];
      if (!Array.isArray(pageOrders) || pageOrders.length === 0) break;
      rawList.push(...pageOrders);
      if (pageOrders.length < 100) break;
      oPage++;
    }

    let activeCount = 0;
    const syncedOrders: Order[] = [];
    const seenIds = new Set<string>();
    const hadSyncedBefore = dbState.orders.length > 0 || Boolean(dbState.settings.lastCloudSyncTimestamp);
    const todayKey = getRiyadhDateKey();

    rawList.forEach((item: any) => {
      const isDelivered = Boolean(item.isDelivered);
      const isCanceled = Boolean(item.isCanceled);
      const rawNum = item.order_number || item.orderNumber || item._id || item.id || '';
      const orderId = rawNum ? String(rawNum).trim() : `LOC-${Math.floor(1000 + Math.random() * 9000)}`;
      if (seenIds.has(orderId)) return;
      seenIds.add(orderId);

      const driverId = String(item.driver_id || item.driverId || '').trim();
      const driverName = String(item.driver_name || item.driverName || item.delegate || item.driver?.name || '').trim();
      let matchedCourier = findCourierForOrder(driverId, driverName, driverId, item.driver_phone);
      const customEntry =
        (matchedCourier && dbState.customCourierPhones[matchedCourier.id]) ||
        (driverId && dbState.customCourierPhones[driverId]) ||
        (driverName && (dbState.customCourierPhones[normalizeArabic(driverName)] || dbState.customCourierPhones[normalizeArabic(stripDriverPrefix(driverName))]));

      if (!matchedCourier && (driverId || driverName)) {
        matchedCourier = {
          id: driverId || `c-${Date.now()}`,
          name: driverName || 'مندوب لوكيت',
          locatAccounts: [driverName, driverId].filter(Boolean),
          phone: customEntry?.phone || (item.driver_phone ? formatPhoneWithPlus(item.driver_phone) : ''),
          customPhone: customEntry?.phone,
          isCustomPhone: Boolean(customEntry),
          status: 'active',
          activeOrdersCount: 0,
          totalDeliveredToday: 0,
          avgDeliveryTimeMinutes: 25,
          delayedOrdersCount: 0,
          updatedAt: new Date().toISOString(),
        };
        dbState.couriers.push(matchedCourier);
      }

      const courierPhone =
        matchedCourier?.isCustomPhone && matchedCourier?.phone
          ? matchedCourier.phone
          : customEntry?.phone || matchedCourier?.phone || (item.driver_phone ? formatPhoneWithPlus(item.driver_phone) : '');

      const timeStart = item.assigned_at || item.acceptance_time || item.order_time || item.ordered_at || item.created_at;
      let elapsedMinutes = 0;
      if (timeStart) {
        const timeEnd = isDelivered && item.delivery_time ? new Date(item.delivery_time).getTime() : Date.now();
        elapsedMinutes = Math.max(0, Math.floor((timeEnd - new Date(timeStart).getTime()) / 60000));
      } else if (typeof item.elapsed_minutes === 'number') {
        elapsedMinutes = item.elapsed_minutes;
      }

      const isDelayed = !isDelivered && !isCanceled && elapsedMinutes >= dbState.settings.delayThresholdMinutes;
      let orderStatus: OrderStatus = 'in_transit';
      if (isCanceled) orderStatus = 'cancelled';
      else if (isDelivered) orderStatus = 'delivered';
      else if (isDelayed) {
        orderStatus = 'delayed';
        activeCount++;
      } else {
        activeCount++;
      }

      const existing = dbState.orders.find((o) => o.id === orderId || o.id === `#${orderId}` || (item._id && o.locateMongoId === item._id));
      const reassignedCourier = Boolean(
        existing &&
        matchedCourier &&
        ((existing.courierId && existing.courierId !== matchedCourier.id) ||
         (!existing.courierId && !existing.locatAccount))
      );

      const orderRecord: Order = {
        id: orderId,
        locateMongoId: item._id || existing?.locateMongoId,
        locatAccount: driverId || driverName,
        courierId: matchedCourier?.id || existing?.courierId,
        courierName: matchedCourier?.name || driverName || 'مندوب لوكيت',
        courierPhone: courierPhone || existing?.courierPhone || '',
        restaurant: item.store_name || item.storeName || item.merchant_name || item.restaurant_name || 'متجر لوكيت',
        customerAddress: item.customer_address || item.customerAddress || item.customer_city || item.address || item.city || '',
        customerCoordinates: item.customer_coordinates || existing?.customerCoordinates || '',
        deliveryCost: String(item.delivery_cost || existing?.deliveryCost || ''),
        paymentMethod: item.payment_method || existing?.paymentMethod || 'Card',
        pickupTime: timeStart ? getRiyadhTimeString(new Date(timeStart)) : existing?.pickupTime || '',
        assignedAt: item.assigned_at || existing?.assignedAt,
        deliveryTime: item.delivery_time || existing?.deliveryTime,
        createdAt: item.created_at || existing?.createdAt,
        isDelivered,
        isCanceled,
        elapsedMinutes,
        status: orderStatus,
        isDelayed,
        alertSentToCourier: existing ? existing.alertSentToCourier : false,
        alertSentToAdmin: existing ? existing.alertSentToAdmin : false,
        alertSentToAdmin2: existing ? existing.alertSentToAdmin2 : false,
        courierAlertTime: existing?.courierAlertTime,
        adminAlertTime: existing?.adminAlertTime,
        admin2AlertTime: existing?.admin2AlertTime,
        assignmentNotifiedToCourier: reassignedCourier ? false : Boolean(existing?.assignmentNotifiedToCourier),
        assignmentNotifiedTime: reassignedCourier ? undefined : existing?.assignmentNotifiedTime,
        activeOrdersHeldByCourier: 1,
        lastUpdated: new Date().toISOString(),
      };

      const isNewlyAssignedActive = !isDelivered && !isCanceled && !orderRecord.assignmentNotifiedToCourier && (
        hadSyncedBefore ? (!existing || reassignedCourier) : elapsedMinutes <= 15
      );
      if (isNewlyAssignedActive) {
        triggerAssignmentNotificationForOrder(orderRecord);
      }

      if (!isDelivered && !isCanceled && ((isDelayed && !orderRecord.alertSentToCourier) || (orderRecord.elapsedMinutes >= (Number(dbState.settings.criticalDelayMinutes) || 45) && (!orderRecord.alertSentToAdmin || !orderRecord.alertSentToAdmin2)))) {
        triggerAlertsForOrder(orderRecord);
      }

      syncedOrders.push(orderRecord);
    });

    dbState.orders = syncedOrders.sort((a, b) => {
      const tA = new Date(a.createdAt || a.assignedAt || 0).getTime();
      const tB = new Date(b.createdAt || b.assignedAt || 0).getTime();
      return tB - tA;
    });

    dbState.couriers.forEach((c) => {
      const cOrders = dbState.orders.filter(
        (o) =>
          o.courierId === c.id ||
          c.locatAccounts.some((acc) => normalizeArabic(acc) === normalizeArabic(o.locatAccount || '')) ||
          normalizeArabic(c.name) === normalizeArabic(o.courierName || '')
      );
      c.activeOrdersCount = cOrders.filter((o) => o.status === 'in_transit' || o.status === 'delayed').length;
      c.totalDeliveredToday = cOrders.filter((o) => o.status === 'delivered' && isOrderFromToday(o, todayKey)).length;
      c.delayedOrdersCount = cOrders.filter((o) => o.isDelayed).length;
      const done = cOrders.filter((o) => o.status === 'delivered' && o.elapsedMinutes > 0);
      if (done.length > 0) {
        c.avgDeliveryTimeMinutes = Math.round(done.reduce((s, o) => s + o.elapsedMinutes, 0) / done.length);
      }
    });

    cloudSyncState = {
      ...cloudSyncState,
      isActive: true,
      isConfigured: true,
      status: 'connected',
      lastSyncTime: new Date().toISOString(),
      lastCount: rawList.length,
      lastOrdersCount: rawList.length,
      lastCouriersCount: dbState.couriers.length,
      activeOrdersCount: activeCount,
      lastError: undefined,
      hasCredentials: Boolean(email && password),
      hasToken: Boolean(token),
      email,
      companyId: dbState.settings.locateCompanyId,
    };

    dbState.settings.lastCloudSyncTimestamp = cloudSyncState.lastSyncTime;
    dbState.settings.lastCloudSyncCount = rawList.length;
    persistToBrowserStorage();

    return {
      success: true,
      count: rawList.length,
      activeCount,
      couriersCount: dbState.couriers.length,
      message: `تم السحب المباشر من جهازك: ${dbState.couriers.length} مندوب و ${rawList.length} طلب (${activeCount} نشط)`,
    };
  } catch (err: any) {
    cloudSyncState.status = 'error';
    cloudSyncState.lastError = err?.message || 'تعذر الاتصال بسيرفر لوكيت';
    return { success: false, count: 0, activeCount: 0, couriersCount: 0, message: cloudSyncState.lastError || 'خطأ في المزامنة' };
  }
}

export function startStandaloneBackgroundRunners() {
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);
  if (watcherTimer) clearInterval(watcherTimer);

  const intervalSec = Math.max(10, Number(dbState.settings.locatSyncIntervalSeconds) || 20);
  cloudSyncTimer = setInterval(() => {
    const cfg = loadEngineConfig();
    if (cfg.activeBackend === 'standalone' && dbState.settings.enableCloudAutoSync !== false) {
      executeStandaloneLocatSync().catch(() => {});
    }
  }, intervalSec * 1000);

  watcherTimer = setInterval(() => {
    const cfg = loadEngineConfig();
    if (cfg.activeBackend === 'standalone') {
      checkAutomatedAlerts();
      if (dbState.settings.autoDailyReport && dbState.settings.adminPhone) {
        const todayKey = getRiyadhDateKey();
        const targetTime = dbState.settings.dailyReportTime || '23:00';
        if (dbState.settings.lastAutoDailyReportDate !== todayKey && getRiyadh24HourTime() >= targetTime) {
          const summary = generateDailyReport();
          dispatchWhatsAppStandalone(dbState.settings.adminPhone, summary.whatsappFormattedText).catch(() => {});
          if (dbState.settings.adminPhone2 && dbState.settings.autoAlertAdmin2) {
            dispatchWhatsAppStandalone(dbState.settings.adminPhone2, summary.whatsappFormattedText).catch(() => {});
          }
          dbState.settings.lastAutoDailyReportDate = todayKey;
          persistToBrowserStorage();
        }
      }
    }
  }, 25000);
}

function generateDailyReport(): DailyReportSummary {
  const today = new Date().toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todayKey = getRiyadhDateKey();

  const courierStats: CourierPerformanceItem[] = dbState.couriers.map((c) => {
    const courierOrders = dbState.orders.filter((o) => {
      if (o.courierId && o.courierId === c.id) return true;
      const match = findCourierForOrder(o.locatAccount, o.courierName, o.courierId, o.courierPhone);
      return match ? match.id === c.id : false;
    });
    const activeForC = courierOrders.filter((o) => !o.isDelivered && !o.isCanceled && o.status !== 'delivered' && o.status !== 'cancelled');
    const deliveredFromOrdersToday = courierOrders.filter(
      (o) => (o.isDelivered || o.status === 'delivered') && isOrderFromToday(o, todayKey)
    ).length;

    const totalDelivered = courierOrders.length > 0 ? deliveredFromOrdersToday : (c.totalDeliveredToday || 0);
    const delayedCurrent = activeForC.filter((o) => o.isDelayed).length;
    const totalDelayed = courierOrders.length > 0
      ? courierOrders.filter((o) => o.isDelayed && isOrderFromToday(o, todayKey)).length
      : (c.delayedOrdersCount + delayedCurrent);
    const avgTime = c.avgDeliveryTimeMinutes || 25;
    const isAbsentToday = c.status === 'off_duty' || (totalDelivered === 0 && activeForC.length === 0);

    let score = 85;
    if (totalDelivered >= 15) score += 10;
    else if (totalDelivered <= 8) score -= 15;
    if (totalDelayed === 0) score += 10;
    else score -= totalDelayed * 12;
    if (avgTime <= 25) score += 5;
    else if (avgTime >= 35) score -= 15;
    score = Math.max(20, Math.min(100, score));

    let tier: 'top' | 'good' | 'low' = 'good';
    let assessmentNote = isAbsentToday ? 'لم ينفذ أي طلب اليوم (غير مداوم)' : 'أداء جيد ومستقر ضمن المعدل الطبيعي';
    if (!isAbsentToday && score >= 85 && totalDelivered >= 14 && totalDelayed <= 1) {
      tier = 'top';
      assessmentNote = '🌟 مندوب متميز: إنتاجية عالية وسرعة تسليم مع انعدام التأخيرات';
    } else if (!isAbsentToday && (score < 60 || totalDelayed >= 2 || (totalDelivered <= 8 && avgTime >= 35))) {
      tier = 'low';
      assessmentNote = '⚠️ يحتاج متابعة: بطء ملحوظ أو تكرار تأخيرات وقلة في عدد التسليمات';
    }

    return {
      courierId: c.id,
      courierName: c.name,
      locatAccounts: c.locatAccounts,
      phone: c.phone,
      deliveredCount: totalDelivered,
      activeCount: activeForC.length,
      delayedCount: totalDelayed,
      avgTime,
      efficiencyScore: score,
      performanceTier: tier,
      assessmentNote,
      isAbsentToday,
    };
  });

  const workingCouriers = courierStats
    .filter((c) => !c.isAbsentToday)
    .sort((a, b) => b.deliveredCount - a.deliveredCount || b.activeCount - a.activeCount);

  const absentCouriers = courierStats
    .filter((c) => c.isAbsentToday)
    .sort((a, b) => a.courierName.localeCompare(b.courierName, 'ar'));

  courierStats.sort((a, b) => Number(Boolean(a.isAbsentToday)) - Number(Boolean(b.isAbsentToday)) || b.deliveredCount - a.deliveredCount || b.efficiencyScore - a.efficiencyScore);

  const topPerformers = workingCouriers.filter((c) => c.performanceTier === 'top');
  const underPerformers = workingCouriers.filter((c) => c.performanceTier === 'low');
  const totalDeliveredToday = courierStats.reduce((s, c) => s + c.deliveredCount, 0);
  const totalDelayedToday = courierStats.reduce((s, c) => s + c.delayedCount, 0);
  const activeOrdersRightNow = dbState.orders.filter((o) => !o.isDelivered && !o.isCanceled && o.status !== 'delivered' && o.status !== 'cancelled').length;
  const overallAvgTimeMinutes = workingCouriers.length > 0 ? Math.round(workingCouriers.reduce((s, c) => s + c.avgTime, 0) / workingCouriers.length) : 0;
  const onTimeRate =
    totalDeliveredToday + totalDelayedToday > 0
      ? Math.round((Math.max(0, totalDeliveredToday - totalDelayedToday) / (totalDeliveredToday + totalDelayedToday)) * 100)
      : 100;

  let waText = `📋 *تقرير نهاية اليوم المختصر*\n📅 *التاريخ:* ${today}\n⏰ *الوقت:* ${getRiyadhTimeString()}\n───────────────────────\n`;
  waText += `📦 *إجمالي الطلبات المنفذة اليوم:* *${totalDeliveredToday}* طلب\n`;
  waText += `🛵 *المناديب المداومون:* *${workingCouriers.length}* | *غير المداومين:* *${absentCouriers.length}*\n───────────────────────\n\n`;

  if (courierStats.length === 0) {
    waText += `ℹ️ لم يتم تسجيل أي مندوب في لوحة التحكم بعد.\n`;
  } else {
    waText += `✅ *إجمالي الطلبات التي نفذها كل مندوب:*\n`;
    if (workingCouriers.length > 0) {
      workingCouriers.forEach((c, idx) => {
        waText += `${idx + 1}. *${c.courierName}*: *${c.deliveredCount}* طلب\n`;
      });
    } else {
      waText += `• لا توجد طلبات منفذة اليوم حتى الآن.\n`;
    }
    waText += `\n🚫 *أسماء المناديب غير المداومين (المتغيبين):*\n`;
    if (absentCouriers.length > 0) {
      absentCouriers.forEach((c, idx) => {
        waText += `${idx + 1}. ${c.courierName}\n`;
      });
    } else {
      waText += `• لا يوجد مناديب متغيبون اليوم ✅\n`;
    }
  }
  waText += `\n───────────────────────\nتم التوليد والإرسال عبر نظام متابعة لوكيت.`;

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    totalOrdersToday: totalDeliveredToday + activeOrdersRightNow,
    deliveredOrdersToday: totalDeliveredToday,
    delayedOrdersToday: totalDelayedToday,
    activeOrdersRightNow,
    overallAvgTimeMinutes,
    onTimeRate,
    workingCouriersCount: workingCouriers.length,
    absentCouriersCount: absentCouriers.length,
    absentCouriers,
    topPerformers,
    underPerformers,
    allCouriers: courierStats,
    whatsappFormattedText: waText,
  };
}

// --- BACKUP & RESTORE ---
export async function exportFullDatabase(): Promise<string> {
  await ensureLocalEngineInitialized();
  return JSON.stringify(
    {
      couriers: dbState.couriers,
      orders: dbState.orders,
      alerts: dbState.alerts,
      settings: dbState.settings,
      customCourierPhones: dbState.customCourierPhones,
      exportedAt: new Date().toISOString(),
    },
    null,
    2
  );
}

export async function importFullDatabase(jsonStr: string): Promise<{ success: boolean; message: string }> {
  await ensureLocalEngineInitialized();
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, message: 'صيغة الملف غير صالحة' };
    }
    if (Array.isArray(parsed.couriers)) dbState.couriers = parsed.couriers;
    if (Array.isArray(parsed.orders)) dbState.orders = parsed.orders;
    if (Array.isArray(parsed.alerts)) dbState.alerts = parsed.alerts;
    if (parsed.settings && typeof parsed.settings === 'object') {
      dbState.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    }
    if (parsed.customCourierPhones && typeof parsed.customCourierPhones === 'object') {
      dbState.customCourierPhones = parsed.customCourierPhones;
    }
    await persistToBrowserStorage();
    return {
      success: true,
      message: `تم استيراد ${dbState.couriers.length} مندوب و ${dbState.orders.length} طلب بنجاح!`,
    };
  } catch (err: any) {
    return { success: false, message: 'خطأ في قراءة ملف النسخة الاحتياطية: ' + (err?.message || '') };
  }
}

// --- COMPLETE LOCAL API ROUTER ---
function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function handleLocalApiRequest(pathname: string, method: string, body: any): Promise<Response> {
  await ensureLocalEngineInitialized();
  const upperMethod = (method || 'GET').toUpperCase();

  if (pathname === '/api/health') {
    return jsonResp({
      status: 'ok',
      mode: 'standalone_browser',
      timestamp: new Date().toISOString(),
      riyadhTime: getRiyadhTimeString(),
      ordersCount: dbState.orders.length,
      couriersCount: dbState.couriers.length,
    });
  }

  if (pathname === '/api/settings') {
    if (upperMethod === 'GET') {
      return jsonResp({ success: true, settings: dbState.settings });
    }
    if (upperMethod === 'POST') {
      dbState.settings = { ...dbState.settings, ...(body || {}) };
      dbState.orders.forEach((o) => {
        o.isDelayed = o.elapsedMinutes >= dbState.settings.delayThresholdMinutes;
        if (o.isDelayed && o.status !== 'delayed' && o.status !== 'delivered') o.status = 'delayed';
      });
      checkAutomatedAlerts();
      persistToBrowserStorage();
      return jsonResp({ success: true, settings: dbState.settings, message: 'تم حفظ الإعدادات محلياً في التطبيق بنجاح' });
    }
  }

  if (pathname === '/api/settings/delays' && upperMethod === 'POST') {
    if (body?.delayThresholdMinutes) dbState.settings.delayThresholdMinutes = Number(body.delayThresholdMinutes);
    if (body?.criticalDelayMinutes) dbState.settings.criticalDelayMinutes = Number(body.criticalDelayMinutes);
    if (body?.antiBanMinDelaySeconds) dbState.settings.antiBanMinDelaySeconds = Number(body.antiBanMinDelaySeconds);
    if (body?.antiBanMaxDelaySeconds) dbState.settings.antiBanMaxDelaySeconds = Number(body.antiBanMaxDelaySeconds);
    if (body?.alertCooldownMinutes) dbState.settings.alertCooldownMinutes = Number(body.alertCooldownMinutes);
    checkAutomatedAlerts();
    persistToBrowserStorage();
    return jsonResp({ success: true, settings: dbState.settings, message: 'تم حفظ أزمنة الإرسال محلياً بنجاح' });
  }

  if (pathname === '/api/settings/whatsapp-contact' && upperMethod === 'POST') {
    if (body?.adminPhone !== undefined) dbState.settings.adminPhone = String(body.adminPhone).trim();
    if (body?.adminName !== undefined) dbState.settings.adminName = String(body.adminName).trim();
    if (body?.adminPhone2 !== undefined) dbState.settings.adminPhone2 = String(body.adminPhone2).trim();
    if (body?.adminName2 !== undefined) dbState.settings.adminName2 = String(body.adminName2).trim();
    if (body?.webhookUrl !== undefined) dbState.settings.webhookUrl = String(body.webhookUrl).trim();
    if (body?.webhookApiKey !== undefined) dbState.settings.webhookApiKey = String(body.webhookApiKey).trim();
    if (body?.whatsAppProvider) dbState.settings.whatsAppProvider = body.whatsAppProvider;
    checkAutomatedAlerts();
    persistToBrowserStorage();
    return jsonResp({ success: true, settings: dbState.settings, message: 'تم حفظ بيانات التواصل محلياً بنجاح' });
  }

  if (pathname === '/api/couriers') {
    if (upperMethod === 'GET') {
      const enriched = dbState.couriers.map((c) => ({
        ...c,
        activeOrdersCount: dbState.orders.filter((o) => {
          const match = findCourierForOrder(o.locatAccount, o.courierName, o.courierId, o.courierPhone);
          return match ? match.id === c.id : false;
        }).length,
      }));
      return jsonResp({ success: true, couriers: enriched });
    }
    if (upperMethod === 'POST') {
      const { id, name, locatAccounts, phone, notes, status } = body || {};
      if (!name || !phone) return jsonResp({ success: false, message: 'اسم المندوب ورقم الواتساب مطلوبان' }, 400);
      const accountsArray = Array.isArray(locatAccounts)
        ? locatAccounts.map((a: string) => a.trim()).filter(Boolean)
        : typeof locatAccounts === 'string'
        ? locatAccounts.split(',').map((a: string) => a.trim()).filter(Boolean)
        : [];
      const formattedPhone = formatPhoneWithPlus(phone);
      if (id) {
        const idx = dbState.couriers.findIndex((c) => c.id === id);
        if (idx !== -1) {
          dbState.couriers[idx] = {
            ...dbState.couriers[idx],
            name,
            locatAccounts: accountsArray.length > 0 ? accountsArray : dbState.couriers[idx].locatAccounts,
            phone: formattedPhone,
            customPhone: formattedPhone,
            isCustomPhone: true,
            notes: notes !== undefined ? notes : dbState.couriers[idx].notes,
            status: status || dbState.couriers[idx].status,
            updatedAt: new Date().toISOString(),
          };
          applyCustomPhoneToCourier(dbState.couriers[idx], formattedPhone, name);
          return jsonResp({ success: true, courier: dbState.couriers[idx], message: 'تم تحديث بيانات المندوب محلياً بنجاح' });
        }
      }
      const newCourier: Courier = {
        id: `c-${Date.now()}`,
        name,
        locatAccounts: accountsArray.length > 0 ? accountsArray : [name],
        phone: formattedPhone,
        customPhone: formattedPhone,
        isCustomPhone: true,
        status: status || 'active',
        activeOrdersCount: 0,
        totalDeliveredToday: 0,
        avgDeliveryTimeMinutes: 25,
        delayedOrdersCount: 0,
        notes: notes || '',
        updatedAt: new Date().toISOString(),
      };
      dbState.couriers.push(newCourier);
      applyCustomPhoneToCourier(newCourier, formattedPhone, name);
      return jsonResp({ success: true, courier: newCourier, message: 'تمت إضافة المندوب وتثبيت رقمه بنجاح' });
    }
  }

  if (pathname === '/api/couriers/update-phone' && upperMethod === 'POST') {
    const { courierId, orderId, courierName, phone } = body || {};
    if (!phone) return jsonResp({ success: false, message: 'رقم الهاتف مطلوب' }, 400);
    const formatted = formatPhoneWithPlus(phone);
    let courier = courierId ? dbState.couriers.find((c) => c.id === courierId) : undefined;
    if (!courier && orderId) {
      const ord = dbState.orders.find((o) => o.id === orderId);
      if (ord) courier = findCourierForOrder(ord.locatAccount, ord.courierName, ord.courierId, ord.courierPhone);
    }
    if (!courier && courierName) {
      courier = dbState.couriers.find((c) => matchDriverName(c.name, courierName));
    }
    if (!courier) {
      courier = {
        id: courierId || `c-${Date.now()}`,
        name: courierName || 'مندوب لوكيت',
        locatAccounts: [courierName].filter(Boolean) as string[],
        phone: formatted,
        isCustomPhone: true,
        customPhone: formatted,
        status: 'active',
        activeOrdersCount: 0,
        totalDeliveredToday: 0,
        avgDeliveryTimeMinutes: 25,
        delayedOrdersCount: 0,
        updatedAt: new Date().toISOString(),
      };
      dbState.couriers.push(courier);
    }
    applyCustomPhoneToCourier(courier, formatted, courier.name);
    return jsonResp({ success: true, message: `تم تثبيت رقم (${courier.name}): ${formatted}`, courier, phone: formatted });
  }

  if (pathname === '/api/couriers/restore-custom' && upperMethod === 'POST') {
    return jsonResp({ success: true, restoredCount: Object.keys(dbState.customCourierPhones).length });
  }

  if (pathname.startsWith('/api/couriers/') && upperMethod === 'DELETE') {
    const id = pathname.split('/').pop();
    dbState.couriers = dbState.couriers.filter((c) => c.id !== id);
    persistToBrowserStorage();
    return jsonResp({ success: true, message: 'تم حذف المندوب بنجاح' });
  }

  if (pathname === '/api/orders' && upperMethod === 'GET') {
    dbState.orders.forEach((order) => {
      if (!order.isDelivered && !order.isCanceled && (order.assignedAt || order.createdAt)) {
        const startTime = new Date(order.assignedAt || order.createdAt!).getTime();
        order.elapsedMinutes = Math.max(0, Math.floor((Date.now() - startTime) / 60000));
        order.isDelayed = order.elapsedMinutes >= dbState.settings.delayThresholdMinutes;
        order.status = order.isDelayed ? 'delayed' : 'in_transit';
      }
    });
    return jsonResp({ success: true, orders: dbState.orders, delayThreshold: dbState.settings.delayThresholdMinutes });
  }

  if (pathname === '/api/orders/advance-time' && upperMethod === 'POST') {
    const minutes = Number(body?.minutes || 5);
    let triggered = 0;
    dbState.orders.forEach((o) => {
      if (o.status !== 'delivered' && o.status !== 'cancelled') {
        o.elapsedMinutes += minutes;
        o.isDelayed = o.elapsedMinutes >= dbState.settings.delayThresholdMinutes;
        if (o.isDelayed) o.status = 'delayed';
        if (o.isDelayed && (!o.alertSentToCourier || !o.alertSentToAdmin)) {
          triggerAlertsForOrder(o);
          triggered++;
        }
      }
    });
    persistToBrowserStorage();
    return jsonResp({ success: true, message: `تم تقديم الوقت بـ ${minutes} دقيقة وتوليد ${triggered} تنبيه`, orders: dbState.orders });
  }

  if (pathname === '/api/alerts') {
    if (upperMethod === 'GET') return jsonResp({ success: true, alerts: dbState.alerts, count: dbState.alerts.length });
  }

  if (pathname === '/api/alerts/clear' && upperMethod === 'DELETE') {
    dbState.alerts = [];
    persistToBrowserStorage();
    return jsonResp({ success: true, message: 'تم مسح سجل التنبيهات' });
  }

  if (pathname === '/api/alerts/trigger-manual' && upperMethod === 'POST') {
    const { orderId, target } = body || {};
    const order = dbState.orders.find((o) => o.id === orderId);
    if (!order) return jsonResp({ success: false, message: 'الطلب غير موجود' }, 404);
    const courier = findCourierForOrder(order.locatAccount, order.courierName, order.courierId, order.courierPhone);
    const courierName = courier ? courier.name : order.courierName;
    const courierPhone = courier ? courier.phone : order.courierPhone;
    const activeCount = order.activeOrdersHeldByCourier || 1;
    let courierLink = '';
    let adminLink = '';
    let admin2Link = '';

    if (target === 'courier' || target === 'both') {
      const msg = buildCourierMessage(order, courierName);
      courierLink = `https://wa.me/${formatPhoneForWhatsApp(courierPhone)}?text=${encodeURIComponent(msg)}`;
      enqueueAlert('courier', courierName, courierPhone, order.id, msg);
      order.alertSentToCourier = true;
      order.courierAlertTime = getRiyadhTimeString();
    }
    if (target === 'admin' || target === 'both') {
      const msg = buildAdminMessage(order, courierName, activeCount);
      adminLink = `https://wa.me/${formatPhoneForWhatsApp(dbState.settings.adminPhone)}?text=${encodeURIComponent(msg)}`;
      enqueueAlert('admin', dbState.settings.adminName || 'الإدارة الأولى', dbState.settings.adminPhone, order.id, msg);
      order.alertSentToAdmin = true;
      order.adminAlertTime = getRiyadhTimeString();
    }
    if (target === 'admin2') {
      const msg = buildAdminCriticalDelayMessage(order, courierName, courierPhone, activeCount);
      admin2Link = `https://wa.me/${formatPhoneForWhatsApp(dbState.settings.adminPhone2)}?text=${encodeURIComponent(msg)}`;
      enqueueAlert('admin2', dbState.settings.adminName2 || 'الإدارة الثانية', dbState.settings.adminPhone2, order.id, msg);
      order.alertSentToAdmin2 = true;
      order.admin2AlertTime = getRiyadhTimeString();
    }
    persistToBrowserStorage();
    return jsonResp({ success: true, message: 'تم إدراج التنبيه محلياً بنجاح', courierLink, adminLink, admin2Link, order });
  }

  if (pathname === '/api/reports/daily' && upperMethod === 'GET') {
    const summary = generateDailyReport();
    const waLink = `https://wa.me/${formatPhoneForWhatsApp(dbState.settings.adminPhone)}?text=${encodeURIComponent(summary.whatsappFormattedText)}`;
    return jsonResp({ success: true, summary, adminWhatsAppLink: waLink, adminPhone: dbState.settings.adminPhone });
  }

  if (pathname === '/api/reports/send-daily' && upperMethod === 'POST') {
    const summary = generateDailyReport();
    const waLink = `https://wa.me/${formatPhoneForWhatsApp(dbState.settings.adminPhone)}?text=${encodeURIComponent(summary.whatsappFormattedText)}`;
    if (dbState.settings.adminPhone) {
      await dispatchWhatsAppStandalone(dbState.settings.adminPhone, summary.whatsappFormattedText).catch(() => {});
    }
    if (dbState.settings.adminPhone2 && dbState.settings.autoAlertAdmin2) {
      await dispatchWhatsAppStandalone(dbState.settings.adminPhone2, summary.whatsappFormattedText).catch(() => {});
    }
    dbState.alerts.unshift({
      id: `alt-report-${Date.now()}`,
      timestamp: new Date().toISOString(),
      recipientType: 'admin',
      recipientName: dbState.settings.adminName || 'الإدارة',
      recipientPhone: dbState.settings.adminPhone,
      orderId: 'تقرير نهاية اليوم المختصر',
      elapsedMinutes: 0,
      activeOrdersCount: summary.activeOrdersRightNow,
      message: summary.whatsappFormattedText,
      status: 'sent',
      waLink,
    });
    dbState.settings.lastAutoDailyReportDate = getRiyadhDateKey();
    persistToBrowserStorage();
    return jsonResp({ success: true, message: 'تم إرسال تقرير نهاية اليوم المختصر بنجاح', waLink });
  }

  if (pathname === '/api/locat/cloud-status' && upperMethod === 'GET') {
    const email = dbState.settings.locateEmail || dbState.settings.locateUsername || '';
    const password = dbState.settings.locatePassword || '';
    return jsonResp({
      success: true,
      cloudSyncState: {
        ...cloudSyncState,
        isActive: dbState.settings.enableCloudAutoSync !== false,
        isConfigured: Boolean((email && password) || dbState.settings.locateAccessToken),
        hasCredentials: Boolean(email && password),
        hasToken: Boolean(dbState.settings.locateAccessToken),
        email,
        companyId: dbState.settings.locateCompanyId,
      },
      ordersCount: dbState.orders.length,
      delayedCount: dbState.orders.filter((o) => o.isDelayed).length,
      intervalSeconds: dbState.settings.locatSyncIntervalSeconds || 20,
    });
  }

  if (pathname === '/api/locat/cloud-pre-login' && upperMethod === 'POST') {
    try {
      const preRes = await fetch('https://api.supplier.locate.sa/api/v1/partners/pre-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(body?.email || '').trim() }),
      });
      const data: any = await preRes.json();
      if (!preRes.ok) return jsonResp({ success: false, message: data.message || 'تعذر العثور على الحساب' }, 400);
      return jsonResp({ success: true, companies: data.companies || [], data });
    } catch (err: any) {
      return jsonResp({ success: false, message: err?.message || 'فشل الاتصال بخادم لوكيت' }, 500);
    }
  }

  if (pathname === '/api/locat/cloud-login' && upperMethod === 'POST') {
    const email = String(body?.email || '').trim();
    const password = String(body?.password || '').trim();
    const result = await autoLoginToLocatCloud(email, password, body?.company_id);
    if (result.token) {
      dbState.settings.locateEmail = email;
      dbState.settings.locatePassword = password;
      dbState.settings.locateAccessToken = result.token;
      if (result.companyId) dbState.settings.locateCompanyId = result.companyId;
      dbState.settings.enableCloudAutoSync = true;
      persistToBrowserStorage();
      const syncResult = await executeStandaloneLocatSync();
      return jsonResp({
        success: true,
        message: 'تم تسجيل الدخول وتفعيل السحب المباشر من جهازك بنجاح!',
        syncResult,
        cloudSyncState: { ...cloudSyncState, token: result.token },
      });
    }
    return jsonResp({ success: false, message: result.error || 'فشل تسجيل الدخول' }, 400);
  }

  if (pathname === '/api/locat/cloud-sync-now' && upperMethod === 'POST') {
    const syncRes = await executeStandaloneLocatSync();
    return jsonResp({
      ...syncRes,
      cloudSyncState,
      orders: dbState.orders,
      couriers: dbState.couriers,
      ordersCount: dbState.orders.length,
      delayedCount: dbState.orders.filter((o) => o.isDelayed).length,
    });
  }

  if (pathname === '/api/locat/sync' && upperMethod === 'POST') {
    const liveOrders = Array.isArray(body?.liveOrders) ? body.liveOrders : [];
    let alertsGenerated = 0;
    liveOrders.forEach((incoming: any) => {
      const orderId = incoming.id || `#LOC-${Math.floor(1000 + Math.random() * 9000)}`;
      const elapsed = Number(incoming.elapsedMinutes) || 0;
      const isDelayed = elapsed >= dbState.settings.delayThresholdMinutes;
      const matched = findCourierForOrder(incoming.locatAccount, incoming.courierName, incoming.courierId, incoming.courierPhone);
      const idx = dbState.orders.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        const existingOrd = dbState.orders[idx];
        const prevCourierId = existingOrd.courierId;
        existingOrd.elapsedMinutes = elapsed;
        existingOrd.isDelayed = isDelayed;
        existingOrd.status = isDelayed ? 'delayed' : existingOrd.status;
        if (matched) {
          existingOrd.courierId = matched.id;
          existingOrd.courierName = matched.name;
          existingOrd.courierPhone = matched.phone;
          if (prevCourierId !== matched.id) {
            existingOrd.assignmentNotifiedToCourier = false;
          }
        }
        if (triggerAssignmentNotificationForOrder(existingOrd)) {
          alertsGenerated++;
        }
        if (isDelayed) {
          triggerAlertsForOrder(existingOrd);
          alertsGenerated++;
        }
      } else {
        const ord: Order = {
          id: orderId,
          locatAccount: incoming.locatAccount || '',
          courierId: matched?.id,
          courierName: matched?.name || incoming.courierName || 'مندوب غير مسجل',
          courierPhone: matched?.phone || incoming.courierPhone || '',
          restaurant: incoming.restaurant || 'متجر لوكيت',
          customerAddress: incoming.customerAddress || 'الوجهة المحددة',
          pickupTime: incoming.pickupTime || getRiyadhTimeString(),
          elapsedMinutes: elapsed,
          status: isDelayed ? 'delayed' : 'in_transit',
          isDelayed,
          alertSentToCourier: false,
          alertSentToAdmin: false,
          assignmentNotifiedToCourier: false,
          activeOrdersHeldByCourier: incoming.activeOrdersHeldByCourier || 1,
          lastUpdated: new Date().toISOString(),
        };
        if (triggerAssignmentNotificationForOrder(ord)) {
          alertsGenerated++;
        }
        if (isDelayed) {
          triggerAlertsForOrder(ord);
          alertsGenerated++;
        }
        dbState.orders.unshift(ord);
      }
    });
    persistToBrowserStorage();
    return jsonResp({ success: true, message: `تمت إضافة ${liveOrders.length} طلب محلياً`, alertsGenerated });
  }

  if (pathname === '/api/whatsapp/status') {
    return jsonResp({
      success: true,
      whatsappState,
      terminalQr: '',
      hasSavedSession: false,
      hasBackupInDb: false,
      sessionBackup: {},
      isStandalone: true,
      cooldownMinutes: dbState.settings.alertCooldownMinutes,
      antiBanMinDelay: dbState.settings.antiBanMinDelaySeconds,
      antiBanMaxDelay: dbState.settings.antiBanMaxDelaySeconds,
    });
  }

  if (pathname === '/api/whatsapp/queue') {
    return jsonResp({
      success: true,
      queue: messageQueue,
      isQueueProcessing,
      stats: queueStats,
      puppeteerStatus,
      cooldownMinutes: dbState.settings.alertCooldownMinutes,
      minDelaySeconds: dbState.settings.antiBanMinDelaySeconds,
      maxDelaySeconds: dbState.settings.antiBanMaxDelaySeconds,
    });
  }

  if (pathname === '/api/whatsapp/queue/clear' && upperMethod === 'POST') {
    messageQueue = [];
    queueStats = { totalProcessed: 0, totalSent: 0, totalSkippedCooldown: 0 };
    return jsonResp({ success: true, message: 'تم مسح طابور الرسائل' });
  }

  if (pathname === '/api/whatsapp/send-test' && upperMethod === 'POST') {
    const phone = String(body?.recipientPhone || '');
    const name = String(body?.recipientName || 'مشرف العمليات');
    const msg = body?.message || `مرحباً ${name}، رسالة فحص مباشر من نظام متابعة لوكيت (${getRiyadhTimeString()}).`;
    const res = await dispatchWhatsAppStandalone(phone, msg);
    const isWebhookSuccess = res.method === 'webhook_gateway' || res.method === 'meta_cloud_api';
    return jsonResp({
      success: res.success,
      message: isWebhookSuccess
        ? 'تم إرسال رسالة الفحص آلياً عبر بوابة الـ Webhook / API بنجاح!'
        : res.method === 'webhook_error'
        ? `فشل الإرسال عبر بوابة الـ Webhook: ${res.error || 'تحقق من صحة الرابط والمفتاح'}`
        : 'تم تجهيز رابط الواتساب المباشر (wa.me) وإشعار المتصفح بنجاح.',
      details: res,
      textSent: msg,
      recipientPhone: formatPhoneForWhatsApp(phone),
      recipientName: name,
    });
  }

  if (pathname === '/api/automation-script') {
    const scriptText = `// ==UserScript==\n// @name         Locate Supplier Live Monitor\n// @match        https://supplier.locate.sa/orders*\n// ==/UserScript==\n// ملاحظة: في الوضع المستقل، التطبيق يتصل مباشرة بـ api.supplier.locate.sa من جهازك بدون الحاجة لسكربت خارجي.`;
    return new Response(scriptText, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  }

  return jsonResp({ success: true, standalone: true });
}
