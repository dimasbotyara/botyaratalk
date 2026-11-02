/**
 * i18n: загрузка переводов, t(key, params) и перерисовка DOM-атрибутов.
 *
 * Строки никогда не хардкодятся в HTML — только data-i18n* атрибуты.
 * Смена языка перерисовывает все существующие атрибуты без перезагрузки.
 */

import { CONFIG, bus, fetchJSON, setCookie, storage } from './utils.js';

const CACHE_KEY = 'i18n.cache';
let translations = {};
let currentLang = CONFIG.lang || 'en';

/** Приводит тег языка к поддерживаемому: ru-RU → ru, иначе en. */
export function normalizeLang(value) {
  const short = String(value || '').toLowerCase().split(/[-_]/)[0];
  return short === 'ru' ? 'ru' : 'en';
}

/** Язык по умолчанию: сохранённый → navigator.language → en. */
export function detectLang() {
  const saved = storage.get('lang');
  if (saved === 'ru' || saved === 'en') return saved;
  return normalizeLang(navigator.language || 'en');
}

export function getLang() {
  return currentLang;
}

/** Синхронный доступ к переводу. Отсутствующий ключ возвращается как есть. */
export function t(key, params = {}) {
  let value = translations[key];
  if (value === undefined) value = key;
  if (typeof value !== 'string') return String(value);
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] !== undefined && params[name] !== null ? String(params[name]) : match,
  );
}

/** Загружает переводы и кеширует их в localStorage (на случай оффлайна). */
export async function loadTranslations(lang) {
  const normalized = normalizeLang(lang);
  const cached = storage.get(CACHE_KEY);
  if (cached && cached[normalized]) {
    translations = cached[normalized];
  }

  const result = await fetchJSON(`${CONFIG.urls.i18n}?lang=${normalized}`);
  if (result.ok && result.translations) {
    translations = result.translations;
    const all = cached && typeof cached === 'object' ? cached : {};
    all[normalized] = translations;
    storage.set(CACHE_KEY, all);
  }
  currentLang = normalized;
  document.documentElement.lang = normalized;
  return translations;
}

/** Ставит язык: cookie для сервера, localStorage для клиента, перерисовка. */
export async function setLang(lang, { persist = true } = {}) {
  const normalized = normalizeLang(lang);
  await loadTranslations(normalized);
  if (persist) {
    storage.set('lang', normalized);
    setCookie('botyaratalk_lang', normalized);
  }
  applyTranslations(document);
  bus.emit('i18n:changed', { lang: normalized });
  return normalized;
}

/** Подставляет перевод в data-i18n* атрибуты внутри root. */
export function applyTranslations(root = document) {
  const scope = root.nodeType === 1 ? root : document;

  scope.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (!key) return;
    const params = parseParams(node.dataset.i18nParams);
    node.textContent = t(key, params);
  });

  scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  });

  scope.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  });

  scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.setAttribute('title', t(node.dataset.i18nTitle));
  });

  // Плейсхолдеры, которые собираются из строки с параметром
  document.querySelectorAll('[data-i18n-params]:not([data-i18n])').forEach((node) => {
    const params = parseParams(node.dataset.i18nParams);
    if (params && params.room !== undefined && node.dataset.i18nPlaceholder) {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder, params));
    }
  });
}

function parseParams(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Инициализация на страницах, где не нужен полный бутстрап (auth, onboarding).
 * @returns {Promise<void>}
 */
export async function initI18n({ lang } = {}) {
  const target = lang || detectLang();
  await loadTranslations(target);
  applyTranslations(document);
  bus.emit('i18n:changed', { lang: currentLang });
}
