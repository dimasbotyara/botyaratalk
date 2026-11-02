/**
 * Темы: список, применение, сохранение, рендер карточек-превью.
 *
 * Тема — это атрибут data-theme на <html>; все цвета живут в CSS-переменных.
 * Карточка превью получает собственный data-theme, поэтому мини-макет
 * рисуется настоящими цветами темы без дублирования значений в JS.
 */

import { CONFIG, $, bus, el, icon, setCookie, storage } from './utils.js';
import { t } from './i18n.js';

export const THEMES = CONFIG.themes.length
  ? CONFIG.themes
  : [
      'catppuccin-latte',
      'catppuccin-frappe',
      'catppuccin-macchiato',
      'catppuccin-mocha',
      'ayu-light',
      'ayu-dark',
      'ayu-mirage',
      'gruvbox-light',
      'gruvbox-dark',
      'gruvbox-material',
    ];

export const DEFAULT_THEME = 'catppuccin-mocha';

/** Сгруппировано по семействам — так карточки не свалены в кучу. */
export const THEME_GROUPS = [
  { key: 'catppuccin', themes: THEMES.filter((x) => x.startsWith('catppuccin')) },
  { key: 'ayu', themes: THEMES.filter((x) => x.startsWith('ayu')) },
  { key: 'gruvbox', themes: THEMES.filter((x) => x.startsWith('gruvbox')) },
].filter((group) => group.themes.length);

const LIGHT_THEMES = new Set(['catppuccin-latte', 'ayu-light', 'gruvbox-light']);

export function isLightTheme(name) {
  return LIGHT_THEMES.has(name);
}

export function themeLabel(name) {
  return t(`theme.${name}`);
}

/** Текущая тема: из localStorage → из data-theme → дефолт. */
export function currentTheme() {
  const stored = storage.get('theme');
  if (stored && THEMES.includes(stored)) return stored;
  const attr = document.documentElement.getAttribute('data-theme');
  return THEMES.includes(attr) ? attr : DEFAULT_THEME;
}

/**
 * Применяет тему визуально.
 * @param {string} name
 * @param {{persist?: boolean}} opts persist — сохранить в localStorage/cookie
 */
export function applyTheme(name, { persist = true } = {}) {
  const theme = THEMES.includes(name) ? name : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.dataset.themeLight = String(isLightTheme(theme));
  document.documentElement.style.colorScheme = isLightTheme(theme) ? 'light' : 'dark';

  if (persist) {
    storage.set('theme', theme);
    setCookie('botyaratalk_theme', theme);
  }
  bus.emit('theme:changed', { theme });
  return theme;
}

/** Мини-макет интерфейса в цветах конкретной темы. */
export function renderThemePreview(themeName) {
  const preview = el('div', {
    class: 'theme-card__preview',
    dataset: { theme: themeName },
    'aria-hidden': 'true',
  });

  const sidebar = el(
    'div',
    { class: 'theme-card__preview-sidebar' },
    el('span', { class: 'preview-dot preview-dot--accent' }),
    el('span', { class: 'preview-dot' }),
    el('span', { class: 'preview-dot' }),
    el('span', { class: 'preview-dot' }),
  );

  const body = el(
    'div',
    { class: 'theme-card__preview-body' },
    el('span', { class: 'preview-line preview-line--short' }),
    el('span', { class: 'preview-line preview-line--bubble' }),
    el('span', { class: 'preview-line' }),
    el('span', { class: 'preview-btn' }),
  );

  preview.append(sidebar, body);
  return preview;
}

/**
 * Карточка темы.
 * @param {string} themeName
 * @param {{selected?: boolean, onSelect?: (name: string) => void}} opts
 */
export function renderThemeCard(themeName, { selected = false, onSelect } = {}) {
  const card = el('button', {
    type: 'button',
    class: 'theme-card',
    dataset: { themeCard: themeName },
    'aria-pressed': String(selected),
    'aria-label': t('a11y.theme_card', { name: themeLabel(themeName) }),
    title: themeLabel(themeName),
  });

  const label = el(
    'span',
    { class: 'theme-card__label' },
    el('span', {}, themeLabel(themeName)),
    el('span', { class: 'theme-card__scheme' }, isLightTheme(themeName) ? 'light' : 'dark'),
  );

  card.append(renderThemePreview(themeName), label);
  if (onSelect) card.addEventListener('click', () => onSelect(themeName));
  return card;
}

/** Отмечает выбранную карточку в контейнере. */
export function markSelectedCard(container, themeName) {
  container.querySelectorAll('[data-theme-card]').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.themeCard === themeName));
  });
}

/**
 * Рендерит сетку тем с группами.
 * @param {HTMLElement} container
 * @param {{selected?: string, onSelect?: (name: string) => void, grouped?: boolean}} opts
 */
export function renderThemeGrid(container, { selected = currentTheme(), onSelect, grouped = true } = {}) {
  container.innerHTML = '';

  if (!grouped) {
    THEMES.forEach((name) => {
      container.append(renderThemeCard(name, { selected: name === selected, onSelect }));
    });
    return;
  }

  THEME_GROUPS.forEach((group) => {
    const section = el('div', { class: 'theme-group' });
    section.append(el('div', { class: 'theme-group__title' }, t(`theme.group.${group.key}`)));
    const grid = el('div', { class: 'theme-grid' });
    group.themes.forEach((name) => {
      grid.append(renderThemeCard(name, { selected: name === selected, onSelect }));
    });
    section.append(grid);
    container.append(section);
  });
}

/**
 * Кнопка-переключатель темы в шапке (светлая/тёмная) — приятный бонус.
 * Возвращает следующую тему из списка.
 */
export function nextTheme(current = currentTheme()) {
  const index = THEMES.indexOf(current);
  return THEMES[(index + 1) % THEMES.length];
}

/** Инициализация на страницах без полного бутстрапа. */
export function initTheme() {
  const theme = applyTheme(currentTheme(), { persist: false });
  bus.emit('theme:ready', { theme });
  return theme;
}

/** Иконка палитры для кнопок настроек темы. */
export function themeIcon() {
  return icon('palette');
}

/** Экспорт для тестов/отладки из консоли. */
export const __debug = { THEMES, DEFAULT_THEME, $ };
