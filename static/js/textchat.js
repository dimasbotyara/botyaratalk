/**
 * Текстовый канал комнаты: история, отправка, рендер сообщений.
 *
 * Возможности чата: ответы на сообщение, реакции, разделители дней,
 * markdown, карточки ссылок и контекстное меню (ПКМ / долгое нажатие).
 * Всё, что относится к внешнему виду одного сообщения, живёт в message.js.
 */

import { CONFIG, $, bus, debounce, el, fetchJSON, formatDay, sameDay } from './utils.js';
import { t } from './i18n.js';
import { emit } from './socket.js';
import { QUICK_REACTIONS, buildAvatar, jumpToMessage, renderMessage, updateReactions } from './message.js';
import { close as closeMenu, openMenu, openReactionMenu } from './context-menu.js';
import { extractLinks, plainText } from './markdown.js';

const state = {
  room: null,
  roomLabel: '',
  messages: [],
  loading: false,
  typingTimer: 0,
  typingNames: new Set(),
  replyTo: null,      // { id, username, text } — сообщение, на которое отвечаем
  users: new Map(),   // userId → { username, avatar } из истории и сокетов
};

const els = {};

/* ------------------------------------------------------------ отрисовка */
function renderMessageRow(message, previous) {
  const user = state.users.get(String(message.user_id)) || {};
  return renderMessage(
    { ...message, avatar: message.avatar || user.avatar },
    previous,
    { onSelect: handleSelect },
  );
}

function dayDivider(iso) {
  return el(
    'div',
    { class: 'chat__day' },
    el('span', { class: 'chat__day-label' }, formatDay(iso, undefined, t('chat.today'), t('chat.yesterday'))),
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
    list.append(renderMessageRow(message, previous));
    previous = message;
  });

  scrollToBottom();
}

export function appendMessage(message) {
  if (state.messages.some((m) => m.id === message.id)) return;

  const list = els.list;
  const wasNearBottom = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 160;

  const previous = state.messages[state.messages.length - 1] || null;
  if (!previous || !sameDay(previous.ts, message.ts)) {
    list.append(dayDivider(message.ts));
  }
  list.append(renderMessageRow(message, previous));
  state.messages.push(message);
  els.empty.hidden = true;

  if (message.user_id) {
    rememberUser(message);
  }
  if (wasNearBottom || String(message.user_id) === String(CONFIG.userId)) scrollToBottom();
}

export function scrollToBottom() {
  requestAnimationFrame(() => {
    els.scroll.scrollTop = els.scroll.scrollHeight;
  });
}

function rememberUser(message) {
  if (!message.user_id) return;
  const key = String(message.user_id);
  const known = state.users.get(key) || {};
  state.users.set(key, {
    username: message.username || known.username,
    avatar: message.avatar ?? known.avatar,
  });
}

/* --------------------------------------------------------- контекст-меню */
function handleSelect(selection) {
  if (!selection) return;
  const { type, message } = selection;

  if (type === 'reaction') {
    toggleReaction(message, selection.emoji);
    return;
  }
  if (type === 'context') {
    openContextMenu(message, selection.x, selection.y);
    return;
  }
  // обычный клик по «пустому» месту сообщения ничего не делает — выделение
  // текста должно работать как в обычном тексте
}

function openContextMenu(message, x, y) {
  const items = [
    {
      id: 'react',
      label: t('chat.react'),
      icon: '<svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg>',
      onSelect: () => openReactionMenu({ x, y }, QUICK_REACTIONS, (emoji) => toggleReaction(message, emoji)),
    },
    {
      id: 'reply',
      label: t('chat.reply'),
      icon: '<svg class="icon" aria-hidden="true"><use href="#i-send"></use></svg>',
      onSelect: () => startReply(message),
    },
    {
      id: 'copy',
      label: t('chat.copy'),
      icon: '<svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg>',
      onSelect: () => copyMessage(message),
    },
    {
      id: 'jump',
      label: t('chat.copy_link'),
      icon: '<svg class="icon" aria-hidden="true"><use href="#i-hash"></use></svg>',
      disabled: !message.reply_to,
      onSelect: () => jumpToMessage(message.reply_to.id),
    },
  ];
  openMenu({ x, y }, items);
}

async function copyMessage(message) {
  const text = message.text || '';
  try {
    await navigator.clipboard.writeText(text);
    bus.emit('ui:toast', { message: t('chat.copied') });
  } catch {
    // Fallback для http:// (clipboard API требует secure context)
    const area = el('textarea', { class: 'visually-hidden' });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      bus.emit('ui:toast', { message: t('chat.copied') });
    } catch {
      bus.emit('ui:toast', { message: t('chat.copy_failed'), variant: 'danger' });
    }
    area.remove();
  }
}

/* ---------------------------------------------------------------- ответы */
export function startReply(message) {
  state.replyTo = {
    id: message.id,
    username: message.username || '?',
    text: message.text || '',
  };
  renderReplyBar();
  els.input?.focus({ preventScroll: true });
}

export function cancelReply() {
  state.replyTo = null;
  renderReplyBar();
}

function renderReplyBar() {
  const bar = els.replyBar;
  if (!bar) return;

  if (!state.replyTo) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = '';
  bar.hidden = false;
  bar.append(
    el(
      'div',
      { class: 'composer__reply' },
      el('span', { class: 'composer__reply-author' }, state.replyTo.username),
      el('span', { class: 'composer__reply-text' }, plainText(state.replyTo.text)),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--icon btn--ghost btn--sm composer__reply-close',
          'aria-label': t('chat.reply_cancel'),
          title: t('chat.reply_cancel'),
          onclick: cancelReply,
        },
        el('svg', { class: 'icon', html: '<use href="#i-x"></use>' }),
      ),
    ),
  );
}

/* --------------------------------------------------------------- реакции */
function toggleReaction(message, emoji) {
  if (!state.room || !emoji) return;
  emit('reaction', { room: state.room, message_id: message.id, emoji });
}

function applyReactions(messageId, reactions) {
  const message = state.messages.find((m) => m.id === messageId);
  if (message) message.reactions = reactions;
  updateReactions(messageId, reactions);
}

/* --------------------------------------------------------------- загрузка */
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
  // Запоминаем аватарки/ники из истории — сокетные сообщения могут прийти
  // без картинки, если пользователь ни разу не писал в этой сессии
  state.messages.forEach(rememberUser);
  renderHistory();
  return true;
}

/* -------------------------------------------------------------- отправка */
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

  const payload = { room: state.room, text };
  if (state.replyTo) payload.reply_to = state.replyTo.id;

  els.input.value = '';
  resizeInput();
  updateCounter();
  cancelReply();

  // Локальная карточка ссылки появится сразу — без ожидания серверного ответа
  const links = extractLinks(text);
  if (links.length) {
    // nothing to do: сервер пришлёт text_message с links
  }

  emit('text_message', payload);
}

/* ------------------------------------------------------------- «печатает» */
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

/* ------------------------------------------------------------------- room */
export async function openRoom(room) {
  if (!room) return;
  state.room = room.slug;
  els.section.hidden = false;
  els.placeholder.hidden = true;
  cancelReply();

  const label = t(room.name_key || `room.${room.slug}`);
  state.roomLabel = label;
  els.title.textContent = label;

  els.input.dataset.i18nParams = JSON.stringify({ room: label });
  els.input.setAttribute('placeholder', t('chat.placeholder', { room: label }));

  emit('leave_room', { room: state.room });
  emit('join_room', { room: state.room });

  await loadHistory(room.slug);

  if (window.matchMedia('(min-width: 769px)').matches) {
    els.input.focus({ preventScroll: true });
  }
  bus.emit('room:active', { room });
  bus.emit('chat:opened', { room });
}

export function currentRoomSlug() {
  return state.room;
}

/* ------------------------------------------------------------------ init */
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
  els.replyBar = $('#composer-reply');

  els.form.addEventListener('submit', sendMessage);

  els.input.addEventListener('input', () => {
    resizeInput();
    updateCounter();
    notifyTyping();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
    // Esc снимает ответ — как в остальных мессенджерах
    if (event.key === 'Escape' && state.replyTo) {
      cancelReply();
    }
  });

  bus.on('room:selected', ({ room }) => openRoom(room));

  bus.on('sio:text_message', (payload) => {
    if (!payload || payload.room !== state.room) return;
    appendMessage(payload);
  });

  bus.on('sio:message_reactions', (payload) => {
    if (!payload || payload.room !== state.room) return;
    applyReactions(payload.message_id, payload.reactions || []);
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

  // Обновление собственной аватарки — перерисовываем историю
  bus.on('avatar:changed', () => {
    if (!state.messages.length) return;
    renderHistory();
  });

  // Долгое нажатие на мобильных — тот же контекст-меню
  let pressTimer = 0;
  els.list.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    const row = event.target.closest('.msg');
    if (!row) return;
    pressTimer = setTimeout(() => {
      const message = state.messages.find((m) => String(m.id) === row.dataset.messageId);
      if (message) openContextMenu(message, event.clientX, event.clientY);
    }, 500);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((type) => {
    els.list.addEventListener(type, () => clearTimeout(pressTimer));
  });

  window.addEventListener('blur', closeMenu);
}

export { buildAvatar };
export const __state = state;
