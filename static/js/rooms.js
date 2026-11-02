/**
 * Комнаты: список в сайдбаре, переключение, счётчики голоса и непрочитанных.
 *
 * У каждой комнаты ровно два канала — текстовый (#) и голосовой (наушники).
 * Голосовые участники приходят событиями `voice_roster`, текстовые бейджи
 * обновляет notifications.js.
 */

import { CONFIG, $, bus, el, fetchJSON, icon, storage } from './utils.js';
import { t } from './i18n.js';

const state = {
  rooms: [],
  current: null,
  voiceCounts: new Map(),
};

const els = {};

function roomLabel(room) {
  // Имя комнаты локализуется по ключу из БД (room.channel_1 и т.п.)
  return t(room.name_key || `room.${room.slug}`);
}

/** Свёрнутые категории храним в localStorage, чтобы состояние переживало reload. */
function collapsedSet() {
  const raw = storage.get('sidebar.collapsed', []);
  return new Set(Array.isArray(raw) ? raw : []);
}

function isCollapsed(category) {
  return collapsedSet().has(category);
}

function toggleCategory(category) {
  const set = collapsedSet();
  if (set.has(category)) set.delete(category);
  else set.add(category);
  storage.set('sidebar.collapsed', [...set]);
  renderRooms();
}

/**
 * Секция-категория в сайдбаре. Внутри — все комнаты одного типа канала.
 * @param {'text'|'voice'} kind
 */
function buildCategory(kind) {
  const collapsed = isCollapsed(kind);
  const title = t(kind === 'text' ? 'sidebar.category_text' : 'sidebar.category_voice');

  const section = el('section', { class: 'room-category', dataset: { category: kind } });

  const header = el('button', {
    type: 'button',
    class: 'room-category__header',
    'aria-expanded': String(!collapsed),
    'aria-controls': `room-category-${kind}`,
    title: t('sidebar.toggle_category', { name: title }),
  });
  header.append(icon(collapsed ? 'chevron-right' : 'chevron-down', 'room-category__chevron'));
  header.append(el('span', {}, title));
  header.addEventListener('click', () => toggleCategory(kind));

  const list = el('div', {
    class: 'room-category__list',
    id: `room-category-${kind}`,
    hidden: collapsed,
  });

  section.append(header, list);

  state.rooms.forEach((room) => {
    if (kind === 'text') {
      list.append(buildChannelRow(room, 'text'));
    } else {
      list.append(buildChannelRow(room, 'voice'));
    }
  });

  return section;
}

/** Одна строка канала: текстовая (#) или голосовая (наушники). */
function buildChannelRow(room, kind) {
  const isText = kind === 'text';
  const row = el('button', {
    type: 'button',
    class: `room-item room-item--${kind}`,
    dataset: isText ? { room: room.slug, channel: 'text' } : { voiceRoom: room.slug },
    // Подписи берутся из локали: «текст-1» / «voice-1» и т.д.
    'aria-label': `${t(room.name_key)} — ${t(isText ? room.text_key : room.voice_key)}`,
    title: t(room.name_key),
  });

  row.append(icon(isText ? 'hash' : 'headphones', 'room-item__icon'));
  row.append(el('span', { class: 'room-item__label' }, t(isText ? room.text_key : room.voice_key)));

  if (isText) {
    row.append(el('span', {
      class: 'room-item__badge',
      dataset: { roomBadge: room.slug },
      hidden: true,
    }));
  } else {
    row.append(el('span', {
      class: 'room-item__voice-dot',
      dataset: { voiceDot: room.slug },
      hidden: true,
    }));
    row.append(el('span', {
      class: 'badge badge--success',
      dataset: { voiceCount: room.slug },
      hidden: true,
    }));
    row.addEventListener('click', () => bus.emit('room:voice-select', { slug: room.slug }));
  }

  if (isText) {
    row.addEventListener('click', () => selectRoom(room.slug));
  }
  return row;
}

/** Подсвечивает активную комнату в обеих категориях. */
function highlightCurrent() {
  document.querySelectorAll('[data-room]').forEach((node) => {
    const active = node.dataset.room === state.current;
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-voice-room]').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.voiceRoom === state.current));
  });
}

export function renderRooms() {
  const list = els.list;
  if (!list) return;
  list.innerHTML = '';
  list.append(buildCategory('text'));
  list.append(buildCategory('voice'));
  highlightCurrent();
  updateVoiceIndicators();
  // Бейджи могли накопиться до перерисовки
  bus.emit('notifications:refresh-badges');
}

export function getRooms() {
  return state.rooms;
}

export function getCurrentRoom() {
  return state.rooms.find((room) => room.slug === state.current) || null;
}

export function getRoom(slug) {
  return state.rooms.find((room) => room.slug === slug) || null;
}

/** Переключение комнаты: обновляет hash, шапку, просит textchat загрузить историю. */
export function selectRoom(slug, { silent = false } = {}) {
  const room = getRoom(slug);
  if (!room) return null;

  const changed = state.current !== slug;
  state.current = slug;
  storage.set('lastRoom', slug);
  highlightCurrent();

  if (location.hash !== `#/room/${slug}`) {
    history.replaceState(null, '', `#/room/${slug}`);
  }

  if (changed && !silent) {
    bus.emit('room:selected', { room });
  }
  return room;
}

/** Обновляет счётчик голосовых участников в сайдбаре. */
export function setVoiceCount(slug, count) {
  state.voiceCounts.set(slug, count);

  const badge = document.querySelector(`[data-voice-count="${slug}"]`);
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const dot = document.querySelector(`[data-voice-dot="${slug}"]`);
  if (dot) dot.hidden = count === 0;

  updateVoiceIndicators();
}

function updateVoiceIndicators() {
  state.rooms.forEach((room) => {
    const count = state.voiceCounts.get(room.slug) || 0;
    const row = document.querySelector(`[data-voice-room="${room.slug}"]`);
    if (row) row.classList.toggle('room-item--busy', count > 0);
  });
}

/** Сброс индикаторов (выход из аккаунта / смена комнаты). */
export function clearVoiceCounts() {
  state.rooms.forEach((room) => setVoiceCount(room.slug, 0));
}

export async function loadRooms() {
  const result = await fetchJSON(CONFIG.urls.rooms);
  if (!result.ok) return [];
  state.rooms = result.rooms || [];
  renderRooms();
  return state.rooms;
}

/** Инициализация: загрузка комнат, восстановление последней, hash-роутинг. */
export async function initRooms() {
  els.list = $('#room-list');

  await loadRooms();

  // Стартовая комната: hash → последняя сохранённая → первая в списке
  const fromHash = location.hash.match(/^#\/room\/([\w-]+)$/)?.[1];
  const last = storage.get('lastRoom');
  const initial =
    (fromHash && getRoom(fromHash) && fromHash) ||
    (last && getRoom(last) && last) ||
    state.rooms[0]?.slug ||
    null;

  if (initial) {
    // silent: main.js сам решит, что грузить при старте
    selectRoom(initial, { silent: true });
  }

  window.addEventListener('hashchange', () => {
    const slug = location.hash.match(/^#\/room\/([\w-]+)$/)?.[1];
    if (slug && slug !== state.current) selectRoom(slug);
  });

  bus.on('notify:open-room', ({ room }) => selectRoom(room));
  bus.on('voice:roster', ({ room, users }) => setVoiceCount(room, users.length));

  return state.rooms;
}

export const __state = state;
