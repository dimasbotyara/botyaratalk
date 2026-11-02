/**
 * Текстовый канал комнаты: история, отправка, рендер сообщений.
 *
 * Скоуп намеренно минимальный: только {author, text, timestamp}, без реакций,
 * ответов, вложений и эмодзи — по требованиям ТЗ.
 */

import { CONFIG, $, avatarStyle, bus, debounce, el, fetchJSON, formatDay, formatTime, initials, mediaDevices, sameDay, throttle } from './utils.js';
import { t } from './i18n.js';
import { emit } from './socket.js';
import { getCurrentRoom } from './rooms.js';

const state = {
  room: null,
  messages: [],
  loading: false,
  typingTimer: 0,
  typingNames: new Set(),
  lastPlainTs: 0,
};

const els = {};

// ------------------------------------------------------------------ рендер
function groupWindowMs() {
  return 5 * 60 * 1000;
}

function buildAvatar(name) {
  const node = el('span', { class: 'avatar avatar--sm' }, initials(name));
  Object.assign(node.style, avatarStyle(name));
  return node;
}

function renderMessage(message, previous) {
  const own = String(message.user_id) === String(CONFIG.userId);
  const isGrouped =
    previous &&
    previous.user_id === message.user_id &&
    sameDay(previous.ts, message.ts) &&
    new Date(message.ts) - new Date(previous.ts) < groupWindowMs();

  const row = el('article', {
    class: `msg${isGrouped ? ' msg--grouped' : ''}${own ? ' msg--own' : ''}`,
    dataset: { messageId: String(message.id), userId: String(message.user_id) },
  });

  const gutter = el('div', { class: 'msg__gutter' });
  if (isGrouped) {
    gutter.append(el('span', { class: 'msg__time-inline' }, formatTime(message.ts)));
  } else {
    gutter.append(buildAvatar(message.username));
  }

  const content = el('div', { class: 'msg__content' });
  if (!isGrouped) {
    const head = el('div', { class: 'msg__head' });
    head.append(
      el('span', { class: 'msg__author' }, own ? `${message.username} (${t('chat.you')})` : message.username),
      el('span', { class: 'msg__time' }, formatTime(message.ts)),
    );
    content.append(head);
  }
  content.append(el('div', { class: 'msg__text' }, message.text));

  row.append(gutter, content);
  return row;
}

function dayDivider(iso) {
  return el(
    'div',
    { class: 'chat__day' },
    formatDay(iso, undefined, t('chat.today'), t('chat.yesterday')),
  );
}

export function renderHistory() {
  const list = els.list;
  list.innerHTML = '';

  if (!state.messages.length) {
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;

  let previous = null;
  state.messages.forEach((message) => {
    if (!previous || !sameDay(previous.ts, message.ts)) {
      list.append(dayDivider(message.ts));
    }
    list.append(renderMessage(message, previous));
    previous = message;
  });

  scrollToBottom();
}

export function appendMessage(message) {
  // Защита от дублей (например, ack + broadcast)
  if (state.messages.some((m) => m.id === message.id)) return;

  const list = els.list;
  const wasNearBottom =
    els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 120;

  const previous = state.messages[state.messages.length - 1] || null;
  if (!previous || !sameDay(previous.ts, message.ts)) {
    list.append(dayDivider(message.ts));
  }
  list.append(renderMessage(message, previous));
  state.messages.push(message);
  els.empty.hidden = true;

  if (wasNearBottom) scrollToBottom();
}

export function scrollToBottom() {
  requestAnimationFrame(() => {
    els.scroll.scrollTop = els.scroll.scrollHeight;
  });
}

// --------------------------------------------------------------- загрузка
export async function loadHistory(slug) {
  state.loading = true;
  state.messages = [];
  els.list.innerHTML = '';
  els.empty.hidden = true;

  const result = await fetchJSON(
    `${CONFIG.urls.rooms}/${encodeURIComponent(slug)}/messages?limit=${CONFIG.historyLimit}`,
  );

  state.loading = false;
  if (!result.ok) return false;

  state.messages = result.messages || [];
  renderHistory();
  return true;
}

// ---------------------------------------------------------------- отправка
function resizeInput() {
  const input = els.input;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function updateCounter() {
  const value = els.input.value;
  const max = els.input.maxLength > 0 ? els.input.maxLength : 2000;
  const remaining = max - value.length;
  const counter = els.counter;
  if (!counter) return;

  if (remaining > max * 0.15) {
    counter.hidden = true;
    return;
  }
  counter.hidden = false;
  counter.textContent = String(remaining);
  counter.dataset.state = remaining < 0 ? 'danger' : remaining < max * 0.05 ? 'warn' : '';
}

const notifyTyping = debounce(() => {
  if (state.room) emit('typing', { room: state.room });
}, 700);

async function sendMessage(event) {
  event?.preventDefault();
  const text = els.input.value.trim();
  if (!text || !state.room) return;

  if (text.length > (els.input.maxLength || 2000)) {
    bus.emit('ui:toast', { message: t('chat.message_too_long'), variant: 'danger' });
    return;
  }

  els.input.value = '';
  resizeInput();
  updateCounter();

  emit('text_message', { room: state.room, text });
}

// ------------------------------------------------------------- «печатает»
function showTyping(name) {
  state.typingNames.add(name);
  renderTypingLine();
}

function renderTypingLine() {
  const node = els.typing;
  if (!node) return;
  const names = [...state.typingNames];
  node.textContent = names.length ? t('chat.typing', { name: names.slice(0, 2).join(', ') }) : '';
}

// ------------------------------------------------------------------- room
export async function openRoom(room) {
  if (!room) return;
  state.room = room.slug;
  els.section.hidden = false;
  els.placeholder.hidden = true;

  // Локализация шапки
  const label = t(room.name_key || `room.${room.slug}`);
  els.title.textContent = label;

  // Плейсхолдер композера с названием комнаты
  els.input.dataset.i18nParams = JSON.stringify({ room: label });
  els.input.setAttribute('placeholder', t('chat.placeholder', { room: label }));

  // Переключаем серверные комнаты: выйти из прошлых, войти в новую
  emit('leave_room', { room: state.room });
  emit('join_room', { room: state.room });

  await loadHistory(room.slug);

  // Фокус в поле ввода — удобно, но не мешает скроллу
  if (window.matchMedia('(min-width: 769px)').matches) {
    els.input.focus({ preventScroll: true });
  }
  // room:selected эмитится только при клике; room:active — всегда, когда
  // комната реально открыта (включая стартовую загрузку).
  bus.emit('room:active', { room });
  bus.emit('chat:opened', { room });
}

export function currentRoomSlug() {
  return state.room;
}

// ------------------------------------------------------------------ init
export function initTextChat() {
  els.section = $('#chat');
  els.scroll = $('#chat-scroll');
  els.list = $('#chat-list');
  els.empty = $('#chat-empty');
  els.form = $('#composer');
  els.input = $('#composer-input');
  els.counter = $('#composer-counter');
  els.title = $('#room-title');
  els.typing = $('#typing-indicator');
  els.placeholder = $('#room-placeholder');

  els.form.addEventListener('submit', sendMessage);

  els.input.addEventListener('input', () => {
    resizeInput();
    updateCounter();
    notifyTyping();
  });

  els.input.addEventListener('keydown', (event) => {
    // Enter — отправить, Shift+Enter — перенос строки
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  bus.on('room:selected', ({ room }) => openRoom(room));

  bus.on('sio:text_message', (payload) => {
    if (!payload || payload.room !== state.room) {
      // сообщение для другой комнаты — бейдж обновит notifications.js
      return;
    }
    appendMessage({
      id: payload.id,
      user_id: payload.user_id,
      username: payload.username,
      text: payload.text,
      ts: payload.ts,
    });
  });

  bus.on('sio:typing', ({ room, username }) => {
    if (room !== state.room) return;
    showTyping(username);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      state.typingNames.clear();
      renderTypingLine();
    }, 3000);
  });

}

export const __state = state;
