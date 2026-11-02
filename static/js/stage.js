/**
 * Раскладка голосовой зоны: обычная панель справа, «во весь экран» и
 * «закреплённая» (чат остаётся видимым, но уступает место видео).
 *
 * Три режима:
 *   normal — панель 340 px справа, чат занимает остальное;
 *   pinned — панель закреплена на всю площадь чата, чат прячется;
 *   stage  — панель разворачивается на весь экран поверх каркаса.
 *
 * Режим запоминается в localStorage, чтобы переживать перезагрузку.
 * Клик по плитке (камера / участник / стрим) в закреплённом или полноэкранном
 * режиме делает её главной: она занимает большую часть площади, остальные
 * участники уезжают вниз в узкую полосу.
 */

import { $, bus, el, icon, storage } from './utils.js';
import { t } from './i18n.js';

const MODES = ['normal', 'pinned', 'stage'];

const state = {
  mode: 'normal',
  spotlight: null, // 'local' | userId | null
  picture: false,  // включён ли режим «картинка в картинке» на большой плитке
};

const els = {};

function applyMode(mode, { persist = true } = {}) {
  const next = MODES.includes(mode) ? mode : 'normal';
  state.mode = next;
  if (persist) storage.set('voice.layout', next);

  const shell = els.shell;
  if (!shell) return;
  shell.dataset.voiceLayout = next;
  if (next === 'normal') clearSpotlight();

  syncButtons();
  bus.emit('voice:layout-changed', { mode: next });
}

function syncButtons() {
  const pinned = state.mode !== 'normal';
  els.pin?.setAttribute('aria-pressed', String(pinned));
  if (els.pin) {
    const key = pinned ? 'voice.unpin' : 'voice.pin';
    els.pin.setAttribute('title', t(key));
    els.pin.setAttribute('aria-label', t(key));
  }
  els.full?.setAttribute('aria-pressed', String(state.mode === 'stage'));
  if (els.full) {
    const key = state.mode === 'stage' ? 'voice.exit_fullscreen' : 'voice.fullscreen';
    els.full.setAttribute('title', t(key));
    els.full.setAttribute('aria-label', t(key));
  }
}

/** Главная плитка: одна занимает верх, остальные уезжают в полосу снизу. */
export function setSpotlight(userId) {
  if (state.mode === 'normal') return;
  const next = String(userId) === String(state.spotlight) ? null : String(userId);
  state.spotlight = next;
  const grid = els.grid;
  if (!grid) return;

  grid.querySelectorAll('.voice-tile').forEach((tile) => {
    const active = next !== null && tile.dataset.tile === next;
    tile.classList.toggle('voice-tile--spotlight', active);
    tile.setAttribute('aria-pressed', String(active));
  });
  grid.dataset.spotlight = next === null ? '0' : '1';
  bus.emit('voice:spotlight-changed', { spotlight: next });
}

export function getSpotlight() {
  return state.spotlight;
}

export function clearSpotlight() {
  state.spotlight = null;
  const grid = els.grid;
  if (!grid) return;
  grid.dataset.spotlight = '0';
  grid.querySelectorAll('.voice-tile--spotlight').forEach((tile) => {
    tile.classList.remove('voice-tile--spotlight');
    tile.setAttribute('aria-pressed', 'false');
  });
  bus.emit('voice:spotlight-changed', { spotlight: null });
}

export function getMode() {
  return state.mode;
}

/* --------------------------------------------------- картинка в картинке */
export function isPictureSupported() {
  return typeof HTMLVideoElement !== 'undefined'
    && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'
    && !window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Включает PiP для плитки. Работает там, где API есть (Firefox — всегда,
 * Chromium — для видео с камеры/экрана). Если браузер отказал, возвращаем
 * false и показываем подсказку — приложение продолжает работать.
 */
export async function enterPictureInPicture(video) {
  if (!video || !isPictureSupported()) return false;
  try {
    if (document.pictureInPictureElement === video) return true;
    await video.requestPictureInPicture();
    state.picture = true;
    bus.emit('voice:pip-changed', { active: true });
    return true;
  } catch (error) {
    console.info('[stage] picture-in-picture недоступна', error?.name || error);
    bus.emit('voice:pip-changed', { active: false, failed: true });
    return false;
  }
}

export async function exitPictureInPicture() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
  } catch {
    /* уже вышли */
  }
  state.picture = false;
}

export function togglePictureInPicture(video) {
  if (document.pictureInPictureElement) return exitPictureInPicture();
  return enterPictureInPicture(video);
}

/* ------------------------------------------------------------------- init */
function bindButtons() {
  els.pin?.addEventListener('click', () => {
    applyMode(state.mode === 'normal' ? 'pinned' : 'normal');
  });

  els.full?.addEventListener('click', () => {
    // Полный экран — это отдельный режим (stage), а не только Fullscreen API:
    // так он одинаково работает в браузерах без разрешения на fullscreen.
    applyMode(state.mode === 'stage' ? 'normal' : 'stage');
  });

  els.exit?.addEventListener('click', () => applyMode('normal'));

  // Esc — выходим из полноэкранного режима
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.mode === 'stage') applyMode('pinned');
  });

  // Двойной клик по заголовку панели тоже разворачивает
  els.panel?.querySelector('.voice-panel__header')?.addEventListener('dblclick', () => {
    applyMode(state.mode === 'stage' ? 'normal' : 'stage');
  });
}

export function initStage() {
  els.shell = $('#app-shell');
  els.panel = $('#voice-panel');
  els.grid = $('#voice-grid');
  els.pin = $('#voice-pin');
  els.full = $('#voice-fullscreen');
  els.exit = $('#voice-exit-fullscreen');

  const saved = storage.get('voice.layout', 'normal');
  applyMode(MODES.includes(saved) ? saved : 'normal', { persist: false });

  bindButtons();

  bus.on('i18n:changed', syncButtons);

  // Просьбы из voice.js / других модулей
  bus.on('voice:open-request', () => {
    if (state.mode === 'normal') applyMode('pinned');
    els.panel?.setAttribute('data-open', 'true');
  });

  bus.on('voice:close-request', () => {
    // Возврат к текстовому чату: из любого режима — в обычную панель
    applyMode('normal');
    if (window.matchMedia('(max-width: 900px)').matches) {
      els.panel?.setAttribute('data-open', 'false');
    }
  });

  bus.on('voice:left', () => {
    clearSpotlight();
    applyMode('normal');
  });

  // PiP по двойному клику на видео
  els.grid?.addEventListener('dblclick', (event) => {
    const video = event.target.closest('.voice-tile')?.querySelector('video');
    if (!video || video.hidden) return;
    event.stopPropagation();
    togglePictureInPicture(video);
  });

  return {
    mode: () => state.mode,
    setMode: applyMode,
    spotlight: getSpotlight,
    pin: () => applyMode('pinned'),
    fullscreen: () => applyMode('stage'),
  };
}

export const __state = state;

/** Добавляет кнопку «картинка в картинке» на плитку с видео (если браузер умеет). */
export function attachPictureInPictureButton(tileNode) {
  if (!isPictureSupported() || !tileNode) return;
  if (tileNode.pipButton) return;

  const button = el('button', {
    type: 'button',
    class: 'voice-tile__pip',
    title: t('voice.pip'),
    'aria-label': t('voice.pip'),
  });
  button.append(icon('pip'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePictureInPicture(tileNode.video);
  });

  tileNode.tile.append(button);
  tileNode.pipButton = button;
}
