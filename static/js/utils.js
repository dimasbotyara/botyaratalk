/**
 * Общие хелперы: DOM, события, хранилище, форматирование, тосты.
 * Модуль не зависит ни от чего — его импортируют все остальные.
 */

// --- конфиг из meta-тега, который рендерит base.html ----------------------
const META = document.querySelector('meta[name="botyaratalk-config"]');

export const CONFIG = {
  lang: META?.dataset.lang || 'en',
  theme: META?.dataset.theme || 'catppuccin-mocha',
  themes: (META?.dataset.themes || '').split(',').filter(Boolean),
  username: META?.dataset.user || '',
  userId: Number(META?.dataset.userId || 0),
  onboarded: META?.dataset.onboarded === '1',
  historyLimit: Number(META?.dataset.historyLimit || 100),
  version: META?.dataset.version || '1.0.0',
  urls: {
    i18n: META?.dataset.i18nUrl || '/api/i18n',
    config: META?.dataset.configUrl || '/api/config',
    ice: META?.dataset.iceUrl || '/api/auth/ice',
    login: META?.dataset.loginUrl || '/api/auth/login',
    register: META?.dataset.registerUrl || '/api/auth/register',
    logout: META?.dataset.logoutUrl || '/api/auth/logout',
    me: META?.dataset.meUrl || '/api/auth/me',
    rooms: META?.dataset.roomsUrl || '/api/rooms',
    app: META?.dataset.appUrl || '/app',
    auth: META?.dataset.authUrl || '/auth',
    onboarding: META?.dataset.onboardingUrl || '/onboarding',
    settings: META?.dataset.settingsUrl || '/settings',
  },
};

// --- DOM -----------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Создаёт элемент: el('div', {class: 'x', dataset: {a: 1}}, 'текст'). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** SVG-иконка из спрайта в templates/partials/icons.html. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text ?? '').replace(/[&<>"']/g, (ch) => map[ch]);
}

// --- события -------------------------------------------------------------
/** Единая шина: модули не тянут друг друга напрямую. */
class Bus extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  on(type, handler) {
    const wrapped = (event) => handler(event.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }
}

export const bus = new Bus();

// --- хранилище -----------------------------------------------------------
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`botyaratalk.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`botyaratalk.${key}`, JSON.stringify(value));
    } catch {
      /* приватный режим — молча живём без сохранения */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`botyaratalk.${key}`);
    } catch {
      /* noop */
    }
  },
};

/** Cookie (не httpOnly) — синхронизация языка/темы с серверным рендером. */
export function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

export function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// --- сеть ----------------------------------------------------------------
/** fetch + JSON + внятная ошибка. Всегда возвращает {ok, ...}. */
export async function fetchJSON(url, options = {}) {
  const init = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return { ok: false, error: 'network', status: 0, cause: error };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: data.error || `http_${response.status}`, ...data };
  }
  return { ok: true, status: response.status, ...data };
}

// --- время ---------------------------------------------------------------
const rtfCache = new Map();

function relativeTimeFormat(lang) {
  if (!rtfCache.has(lang)) {
    rtfCache.set(
      lang,
      new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hour12: false }),
    );
  }
  return rtfCache.get(lang);
}

/** Время сообщения: «14:32» или «14:32:07» — минуты достаточно для чата. */
export function formatTime(iso, lang = CONFIG.lang) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return relativeTimeFormat(lang).format(date);
}

export function formatDay(iso, lang = CONFIG.lang, todayLabel = 'Today', yesterdayLabel = 'Yesterday') {
  const date = new Date(iso);
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 864e5);
  if (diffDays === 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

export function sameDay(a, b) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

// --- прочее --------------------------------------------------------------
export function debounce(fn, wait = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let scheduled = 0;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!scheduled) {
      scheduled = setTimeout(() => {
        scheduled = 0;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

export function initials(name = '?') {
  const clean = String(name).trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Стабильный «цветной» оттенок аватара из ника (не влияет на контраст). */
export function hueFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

export function avatarStyle(name) {
  const hue = hueFor(String(name));
  return {
    background: `hsl(${hue} 55% 26% / 0.55)`,
    color: `hsl(${hue} 85% 78%)`,
  };
}

/** Всплывающее уведомление снизу экрана. */
export function toast(message, { variant = '', timeout = 2600 } = {}) {
  const stack = $('#toasts');
  if (!stack) return;
  const node = el('div', { class: `toast ${variant ? `toast--${variant}` : ''}` }, message);
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms ease';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/** Безопасный `navigator.mediaDevices` (в http-контексте его может не быть). */
export function mediaDevices() {
  return navigator.mediaDevices || null;
}

export function isSecureEnoughForMedia() {
  if (window.isSecureContext) return true;
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Мягкое отключение всех треков в потоке. */
export function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* уже остановлен */
    }
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
