import {
  EngineMode,
  EngineRuntimeConfig,
  ensureLocalEngineInitialized,
  handleLocalApiRequest,
  loadEngineConfig,
  mirrorServerDataToLocal,
  saveEngineConfig,
  startStandaloneBackgroundRunners,
} from './localEngine';

type Listener = (cfg: EngineRuntimeConfig) => void;
const listeners = new Set<Listener>();
const adminUnauthorizedListeners = new Set<() => void>();

let currentConfig: EngineRuntimeConfig = loadEngineConfig();
let bridgeInstalled = false;
let nativeFetchRef: typeof window.fetch | null = null;
let adminAuthToken: string | null = null;
let adminAuthenticated = false;

export function setAdminAuthToken(token: string | null) {
  adminAuthToken = token && token.trim() ? token.trim() : null;
  if (adminAuthToken) {
    adminAuthenticated = true;
  }
}

export function setAdminAuthenticated(authenticated: boolean) {
  adminAuthenticated = authenticated;
  if (!authenticated) {
    adminAuthToken = null;
  }
}

export function getAdminAuthToken(): string | null {
  return adminAuthToken;
}

export function subscribeAdminUnauthorized(cb: () => void): () => void {
  adminUnauthorizedListeners.add(cb);
  return () => adminUnauthorizedListeners.delete(cb);
}

function notifyAdminUnauthorized() {
  adminUnauthorizedListeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

function notifyListeners() {
  listeners.forEach((cb) => {
    try {
      cb({ ...currentConfig });
    } catch {}
  });
}

export function getEngineConfig(): EngineRuntimeConfig {
  return { ...currentConfig };
}

export function subscribeEngineConfig(cb: Listener): () => void {
  listeners.add(cb);
  cb({ ...currentConfig });
  return () => listeners.delete(cb);
}

export function updateEngineMode(mode: EngineMode, localServerUrl?: string): EngineRuntimeConfig {
  const cleanUrl = (localServerUrl ?? currentConfig.localServerUrl).trim().replace(/\/+$/, '') || 'http://localhost:3000';
  currentConfig = saveEngineConfig({
    mode,
    localServerUrl: cleanUrl,
    activeBackend: mode === 'standalone' ? 'standalone' : mode === 'local_server' ? 'local_server' : 'server',
    lastFallbackReason: undefined,
  });
  if (currentConfig.activeBackend === 'standalone') {
    startStandaloneBackgroundRunners();
  }
  notifyListeners();
  return { ...currentConfig };
}

export async function probeBackendHealth(targetBaseUrl = ''): Promise<boolean> {
  const fetchFn = nativeFetchRef || (typeof window !== 'undefined' ? window.fetch.bind(window) : null);
  if (!fetchFn) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetchFn(`${targetBaseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return false;
    const data = await res.json();
    return Boolean(data && data.status === 'ok');
  } catch {
    return false;
  }
}

export function installApiBridge() {
  if (bridgeInstalled || typeof window === 'undefined') return;
  bridgeInstalled = true;
  nativeFetchRef = window.fetch.bind(window);
  const originalFetch = nativeFetchRef;

  ensureLocalEngineInitialized().then(async () => {
    startStandaloneBackgroundRunners();
    const isRemoteWebHost =
      window.location.protocol.startsWith('http') &&
      !['localhost', '127.0.0.1'].includes(window.location.hostname);
    const pointsToLoopback =
      currentConfig.localServerUrl.includes('127.0.0.1') ||
      currentConfig.localServerUrl.includes('localhost');

    // If a web browser was previously pinned to loopback local_server, prefer the live origin server if healthy
    if (currentConfig.mode === 'local_server' && isRemoteWebHost && pointsToLoopback) {
      const originOk = await probeBackendHealth('');
      if (originOk) {
        currentConfig = saveEngineConfig({
          mode: 'auto',
          activeBackend: 'server',
          lastFallbackReason: undefined,
        });
        notifyListeners();
        return;
      }
    }

    // If running inside Capacitor APK or static bundle without embedded backend, auto-probe local Node engine (e.g. Termux on 127.0.0.1:3000)
    if (currentConfig.mode === 'auto') {
      const originOk = await probeBackendHealth('');
      if (originOk) {
        if (currentConfig.activeBackend !== 'server') {
          currentConfig = saveEngineConfig({
            activeBackend: 'server',
            lastFallbackReason: undefined,
          });
          notifyListeners();
        }
      } else {
        const localCandidates = Array.from(new Set([
          currentConfig.localServerUrl && currentConfig.localServerUrl !== 'http://localhost:3000' ? currentConfig.localServerUrl : '',
          'http://127.0.0.1:3000',
        ].filter(Boolean)));
        for (const candidate of localCandidates) {
          const ok = await probeBackendHealth(candidate);
          if (ok) {
            currentConfig = saveEngineConfig({
              mode: 'local_server',
              localServerUrl: candidate,
              activeBackend: 'local_server',
              lastFallbackReason: undefined,
            });
            notifyListeners();
            break;
          }
        }
      }
    }
  });

  const bridgedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    let pathname = '';
    let isRelativeApi = false;
    try {
      if (rawUrl.startsWith('/api/')) {
        pathname = rawUrl.split('?')[0];
        isRelativeApi = true;
      } else if (rawUrl.startsWith(window.location.origin + '/api/')) {
        pathname = rawUrl.slice(window.location.origin.length).split('?')[0];
        isRelativeApi = true;
      }
    } catch {}

    if (!isRelativeApi) {
      return originalFetch(input, init);
    }

    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let parsedBody: any = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {}
    }

    // Attach in-memory Admin Bearer token and CSRF header on API calls
    const isCourierApi = pathname.startsWith('/api/courier-portal');
    const isPublicAuthApi =
      pathname === '/api/health' ||
      pathname === '/api/admin-auth/status' ||
      pathname === '/api/admin-auth/login' ||
      pathname === '/api/admin-auth/setup' ||
      pathname === '/api/admin-auth/logout';

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'LocatMonitor');
    }
    if (!isCourierApi && !isPublicAuthApi && adminAuthToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${adminAuthToken}`);
    }
    const finalInit: RequestInit = {
      ...init,
      headers,
      credentials: init?.credentials || 'include',
    };

    // Mode 1: Pure Standalone Browser Mode (Zero hosting / zero backend server calls)
    if (currentConfig.mode === 'standalone') {
      if (!isCourierApi && !isPublicAuthApi && !adminAuthToken && !adminAuthenticated) {
        return new Response(JSON.stringify({ success: false, code: 'ADMIN_AUTH_REQUIRED', message: 'يرجى تسجيل الدخول للإدارة أولاً' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (currentConfig.activeBackend !== 'standalone') {
        currentConfig = saveEngineConfig({ activeBackend: 'standalone' });
        notifyListeners();
      }
      return handleLocalApiRequest(pathname, method, parsedBody);
    }

    // Mode 2: Explicit Local Server Mode (e.g., PC .exe on LAN, Termux 127.0.0.1:3000, or Render/VPS URL)
    const relativeWithQuery = rawUrl.startsWith('/')
      ? rawUrl
      : rawUrl.startsWith(window.location.origin)
      ? rawUrl.slice(window.location.origin.length)
      : pathname;
    const targetUrl =
      currentConfig.mode === 'local_server'
        ? `${currentConfig.localServerUrl}${relativeWithQuery}`
        : input;

    // Mode 3: Auto mode (try server, mirror to IndexedDB, auto-fallback to standalone if server stops/sleeps)
    const isLongSync =
      pathname.includes('cloud-login') ||
      pathname.includes('cloud-sync-now') ||
      pathname.includes('whatsapp/pairing-code') ||
      pathname.includes('whatsapp/reconnect') ||
      pathname.includes('courier-portal/me');
    const timeoutMs = isLongSync ? 25000 : 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await originalFetch(targetUrl, {
        ...finalInit,
        signal: init?.signal || controller.signal,
      });
      clearTimeout(timeoutId);

      // If hosting proxy returned 502/503/504 or HTML fallback page instead of API JSON
      const contentType = response.headers.get('content-type') || '';
      const isExpectedText = pathname === '/api/automation-script';
      const isBadProxyResponse =
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504 ||
        (!isExpectedText && !contentType.includes('application/json'));

      if (isBadProxyResponse) {
        throw new Error(`Hosting unavailable (${response.status})`);
      }

      if (response.status === 401 && !isCourierApi && !isPublicAuthApi) {
        adminAuthToken = null;
        adminAuthenticated = false;
        notifyAdminUnauthorized();
        return response;
      }

      const expectedBackend = currentConfig.mode === 'local_server' ? 'local_server' : 'server';
      if (currentConfig.activeBackend !== expectedBackend) {
        currentConfig = saveEngineConfig({ activeBackend: expectedBackend, lastFallbackReason: undefined });
        notifyListeners();
      }

      // Mirror GET responses into local IndexedDB silently only when authenticated
      if (method === 'GET' && response.ok && contentType.includes('application/json') && (adminAuthToken || adminAuthenticated || isCourierApi)) {
        response
          .clone()
          .json()
          .then((data) => mirrorServerDataToLocal(pathname, data))
          .catch(() => {});
      }

      return response;
    } catch (err: any) {
      clearTimeout(timeoutId);
      // Never leak admin localEngine fallback to unauthenticated visitors
      if (!isCourierApi && !isPublicAuthApi && !adminAuthToken && !adminAuthenticated) {
        return new Response(JSON.stringify({ success: false, code: 'ADMIN_AUTH_REQUIRED', message: 'تعذر التحقق من جلسة الإدارة' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (currentConfig.activeBackend !== 'standalone') {
        currentConfig = saveEngineConfig({
          activeBackend: 'standalone',
          lastFallbackReason: err?.message || 'توقف الاتصال بالسيرفر',
        });
        startStandaloneBackgroundRunners();
        notifyListeners();
      }
      return handleLocalApiRequest(pathname, method, parsedBody);
    }
  };

  try {
    const desc = Object.getOwnPropertyDescriptor(window, 'fetch');
    if (!desc || desc.configurable) {
      Object.defineProperty(window, 'fetch', {
        value: bridgedFetch,
        writable: true,
        configurable: true,
        enumerable: desc ? desc.enumerable : true,
      });
    } else if (desc.writable) {
      window.fetch = bridgedFetch;
    }
  } catch (err) {
    console.warn('[API Bridge] Could not override window.fetch cleanly:', err);
  }
}
