/**
 * Аватарки: загрузка с обрезкой в браузере и генератор пиксельного узора.
 *
 * Загрузка: файл читается в canvas, пользователь двигает и масштабирует
 * картинку, результат вырезается квадратом 256×256 и уходит на сервер как PNG.
 * Вся тяжёлая работа — на клиенте, сервер получает уже готовый квадрат
 * (не больше 2 МБ), поэтому не нужен ни Pillow, ни imagemagick.
 *
 * Генератор: те же правила, что и в app/avatar.py — сетка 32×32, процент
 * пикселей, палитра и сид. Здесь он рисуется на canvas, чтобы пользователь
 * видел результат мгновенно; при сохранении сервер пересчитает его из сида
 * и отдаст как SVG.
 */

import { $, bus, el, fetchJSON, toast } from './utils.js';
import { t } from './i18n.js';

const AVATAR_SIZE = 256;   // итоговый квадрат
const MAX_BYTES = 2 * 1024 * 1024;

const state = {
  tab: 'upload',           // 'upload' | 'generate'
  file: null,              // выбранный File
  image: null,             // HTMLImageElement
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragStart: null,
  generated: { seed: '', palette: 'mocha', density: 30 },
  openedFromSettings: false,
  palettes: [],
  saving: false,
};

const els = {};

/* ------------------------------------------------------------ утилиты */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Случайный сид — как на сервере (без похожих символов). */
export function randomSeed(length = 8) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let seed = '';
  for (let i = 0; i < length; i += 1) {
    seed += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return seed;
}

/** Узор рисует сервер (app/avatar.py) — один источник правды для превью
 *  и для сохранённой аватарки. Здесь только обёртка над <img src=...svg>. */
export function generatedUrl({ seed, palette, density }) {
  const params = new URLSearchParams({
    seed,
    palette,
    density: String(density),
  });
  return `/api/avatar/generated.svg?${params}`;
}

/** Перерисовывает превью генератора (картинку считает сервер). */
export function drawGenerated(image, params) {
  if (!image) return;
  image.src = generatedUrl(params);
}

/* --------------------------------------------------------- загрузка файла */
function loadFile(file) {
  if (!file) return Promise.reject(new Error('no_file'));
  if (file.size > MAX_BYTES) {
    toast(t('avatar.too_large'), { variant: 'danger' });
    return Promise.reject(new Error('too_large'));
  }
  if (!file.type.startsWith('image/')) {
    toast(t('avatar.bad_format'), { variant: 'danger' });
    return Promise.reject(new Error('bad_format'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Пересчитывает позицию так, чтобы картинка всегда покрывала круг. */
function clampOffsets() {
  const { image, zoom } = state;
  if (!image || !els.viewport) return;

  const viewport = els.viewport.clientWidth;
  const scale = Math.max(viewport / image.width, viewport / image.height) * zoom;
  const drawnW = image.width * scale;
  const drawnH = image.height * scale;
  const maxX = Math.max(0, (drawnW - viewport) / 2);
  const maxY = Math.max(0, (drawnH - viewport) / 2);

  state.offsetX = clamp(state.offsetX, -maxX, maxX);
  state.offsetY = clamp(state.offsetY, -maxY, maxY);
}

function renderPreview() {
  if (!state.image || !els.canvas) return;
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  const viewport = els.viewport.clientWidth || 260;

  // Что видно в кружке, то и попадёт в аватарку
  const scale = Math.max(viewport / state.image.width, viewport / state.image.height) * state.zoom;
  const drawnW = state.image.width * scale;
  const drawnH = state.image.height * scale;
  const left = viewport / 2 - drawnW / 2 + state.offsetX;
  const top = viewport / 2 - drawnH / 2 + state.offsetY;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, Math.PI * 2);
  ctx.clip();
  // Переводим координаты вьюпорта в координаты итогового квадрата
  const ratio = canvas.width / viewport;
  ctx.drawImage(
    state.image,
    left * ratio,
    top * ratio,
    drawnW * ratio,
    drawnH * ratio,
  );
  ctx.restore();
  clampOffsets();
}

/** Готовит PNG 256×256 из текущего положения картинки. */
function exportPng() {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  const viewport = els.viewport.clientWidth || 260;

  const scale = Math.max(viewport / state.image.width, viewport / state.image.height) * state.zoom;
  const drawnW = state.image.width * scale;
  const drawnH = state.image.height * scale;
  const left = viewport / 2 - drawnW / 2 + state.offsetX;
  const top = viewport / 2 - drawnH / 2 + state.offsetY;
  const ratio = AVATAR_SIZE / viewport;

  ctx.save();
  ctx.beginPath();
  ctx.arc(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(state.image, left * ratio, top * ratio, drawnW * ratio, drawnH * ratio);
  ctx.restore();

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/* ------------------------------------------------------------- вкладки */
function switchTab(tab) {
  state.tab = tab;
  els.tabs.forEach((button) => {
    const active = button.dataset.avatarTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  els.panes.forEach((pane) => {
    pane.hidden = pane.dataset.avatarPane !== tab;
  });
  if (tab === 'generate') drawGeneratedPreview();
}

/* ---------------------------------------------------------- генератор */
function drawGeneratedPreview() {
  drawGenerated(els.generatedImage, state.generated);
  if (els.seedInput) els.seedInput.value = state.generated.seed;
  if (els.densityInput) els.densityInput.value = String(state.generated.density);
  if (els.densityValue) els.densityValue.textContent = `${state.generated.density}%`;
}

function regenerate() {
  state.generated.seed = randomSeed();
  drawGeneratedPreview();
}

/* ------------------------------------------------------------- сохранение */
async function saveUploaded() {
  if (!state.image) {
    toast(t('avatar.pick_file'), { variant: 'danger' });
    return;
  }
  const blob = await exportPng();
  const form = new FormData();
  form.append('avatar', blob, 'avatar.png');

  state.saving = true;
  els.save.disabled = true;
  try {
    const response = await fetch('/api/avatar/upload', { method: 'POST', body: form });
    const result = await response.json();
    if (!result.ok) {
      toast(t(`avatar.error_${result.error}`) || t('avatar.upload_failed'), { variant: 'danger' });
      return;
    }
    bus.emit('avatar:changed', { avatar: result.avatar });
    toast(t('avatar.saved'));
  } catch (error) {
    console.warn('[avatar] upload failed', error);
    toast(t('avatar.upload_failed'), { variant: 'danger' });
  } finally {
    state.saving = false;
    els.save.disabled = false;
  }
}

async function saveGenerated() {
  state.saving = true;
  els.save.disabled = true;
  try {
    const result = await fetchJSON('/api/avatar/generated', {
      method: 'POST',
      body: {
        seed: state.generated.seed,
        palette: state.generated.palette,
        density: state.generated.density,
      },
    });
    if (!result.ok) {
      toast(t('avatar.upload_failed'), { variant: 'danger' });
      return;
    }
    bus.emit('avatar:changed', { avatar: result.avatar });
    toast(t('avatar.saved'));
  } finally {
    state.saving = false;
    els.save.disabled = false;
  }
}

async function save() {
  if (state.tab === 'generate') return saveGenerated();
  return saveUploaded();
}

/* ------------------------------------------------------------------ init */
function bindUpload() {
  els.fileInput?.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    try {
      state.image = await loadFile(file);
      state.file = file;
      state.zoom = 1;
      state.offsetX = 0;
      state.offsetY = 0;
      if (els.zoomInput) els.zoomInput.value = '1';
      if (els.picker) els.picker.hidden = false;
      els.viewport?.classList.add('is-filled');
      renderPreview();
    } catch (error) {
      console.warn('[avatar] load failed', error);
    }
  });

  els.zoomInput?.addEventListener('input', (event) => {
    state.zoom = Number(event.target.value);
    renderPreview();
  });

  // Перетаскивание картинки внутри круга
  els.viewport?.addEventListener('pointerdown', (event) => {
    if (!state.image) return;
    state.dragging = true;
    state.dragStart = { x: event.clientX - state.offsetX, y: event.clientY - state.offsetY };
    els.viewport.setPointerCapture(event.pointerId);
  });

  els.viewport?.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    state.offsetX = event.clientX - state.dragStart.x;
    state.offsetY = event.clientY - state.dragStart.y;
    renderPreview();
  });

  const stopDrag = () => {
    state.dragging = false;
  };
  els.viewport?.addEventListener('pointerup', stopDrag);
  els.viewport?.addEventListener('pointercancel', stopDrag);
}

function bindGenerator() {
  els.paletteList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-palette]');
    if (!button) return;
    state.generated.palette = button.dataset.palette;
    els.paletteList.querySelectorAll('[data-palette]').forEach((node) => {
      node.classList.toggle('is-active', node === button);
    });
    drawGeneratedPreview();
  });

  els.densityInput?.addEventListener('input', (event) => {
    state.generated.density = Number(event.target.value);
    drawGeneratedPreview();
  });

  els.seedInput?.addEventListener('input', (event) => {
    const value = event.target.value.trim();
    state.generated.seed = value || randomSeed();
    drawGenerated(els.generatedImage, state.generated);
  });

  els.regenerate?.addEventListener('click', regenerate);
}

export function initAvatarEditor() {
  els.modal = $('#avatar-modal');
  if (!els.modal) return;

  els.tabs = [...els.modal.querySelectorAll('[data-avatar-tab]')];
  els.panes = [...els.modal.querySelectorAll('[data-avatar-pane]')];
  els.fileInput = $('#avatar-file');
  els.picker = $('#avatar-picker');
  els.viewport = $('#avatar-viewport');
  els.canvas = $('#avatar-canvas');
  els.zoomInput = $('#avatar-zoom');
  els.paletteList = $('#avatar-palettes');
  els.densityInput = $('#avatar-density');
  els.densityValue = $('#avatar-density-value');
  els.seedInput = $('#avatar-seed');
  els.regenerate = $('#avatar-random');
  els.generatedImage = $('#avatar-generated');
  els.save = $('#avatar-save');
  els.reset = $('#avatar-reset');

  els.tabs.forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.avatarTab));
  });

  els.save?.addEventListener('click', save);
  els.reset?.addEventListener('click', async () => {
    const result = await fetchJSON('/api/avatar', { method: 'DELETE' });
    if (result.ok) {
      bus.emit('avatar:changed', { avatar: null });
      toast(t('avatar.reset_done'));
    }
  });

  bindUpload();
  bindGenerator();

  // alt у превью — не только для скринридера: при смене языка он обновляется
  const syncAlt = () => els.generatedImage?.setAttribute('alt', t('avatar.preview'));
  syncAlt();
  bus.on('i18n:changed', syncAlt);

  // Стек модалок: закрытие аватарки должно вернуть настройки, а не пустоту.
  // Флаг выставляет вызывающая сторона ДО вызова open() — здесь его трогать
  // нельзя, иначе настройки уже скрыты и «вернуться» будет некуда.
  const open = () => {
    els.modal.hidden = false;
    document.body.classList.add('is-modal-open');
    els.modal.querySelector('.modal__dialog')?.focus?.({ preventScroll: true });
    bus.emit('avatar:open');
  };
  const close = () => {
    els.modal.hidden = true;
    document.body.classList.remove('is-modal-open');
    if (state.openedFromSettings) {
      const settings = document.querySelector('#settings-modal');
      if (settings) settings.hidden = false;
      state.openedFromSettings = false;
    }
    bus.emit('avatar:close');
  };

  els.open = open;
  els.close = close;

  // Точки входа: кнопка в настройках и событие от других модулей
  document.querySelector('#open-avatar-editor')?.addEventListener('click', () => {
    const settings = document.querySelector('#settings-modal');
    // Прячем настройки за аватаркой, но помним, что вернуться нужно туда
    state.openedFromSettings = Boolean(settings && !settings.hidden);
    if (settings) settings.hidden = true;
    open();
  });
  els.modal.querySelectorAll('[data-close-avatar]').forEach((button) => {
    button.addEventListener('click', close);
  });
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modal.hidden) close();
  });
  bus.on('avatar:open-request', () => {
    const settings = document.querySelector('#settings-modal');
    state.openedFromSettings = Boolean(settings && !settings.hidden);
    if (settings) settings.hidden = true;
    open();
  });

  // Палитры подтягиваем один раз при первом открытии
  bus.on('avatar:open', async () => {
    if (!state.palettes.length) {
      const result = await fetchJSON('/api/avatar/options');
      if (result.ok) {
        state.palettes = result.palettes;
        buildPaletteButtons();
        if (!state.generated.seed) state.generated.seed = result.seed;
      }
    }
    switchTab(state.tab);
    drawGeneratedPreview();
    if (state.image) renderPreview();
  });

  bus.on('i18n:changed', () => drawGeneratedPreview());
}

function buildPaletteButtons() {
  els.paletteList.innerHTML = '';
  state.palettes.forEach((palette) => {
    const button = el('button', {
      type: 'button',
      class: `avatar-palette${palette.id === state.generated.palette ? ' is-active' : ''}`,
      dataset: { palette: palette.id },
      title: palette.id,
      'aria-label': palette.id,
    });
    // Цвета палитры пробрасываем в CSS-переменные прямо на элементе
    button.style.setProperty('--swatch-bg', palette.bg);
    button.style.setProperty('--swatch-fg', palette.fg);
    button.append(el('span', { class: 'avatar-palette__dot' }));
    els.paletteList.append(button);
  });
}

export const __state = state;
