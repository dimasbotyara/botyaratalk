/**
 * Единственное Socket.IO-соединение на вкладку.
 *
 * Модуль-обёртка нужен, чтобы voice.js / textchat.js / rooms.js не создавали
 * собственные соединения и не тянули друг друга: все подписываются на шину
 * `socket` через on()/emit().
 */

import { bus, toast } from './utils.js';
import { t } from './i18n.js';

let socket = null;
const handlers = new Map();
let reconnectAttempt = 0;

/** Подписка на событие сервера с автоматическим снятием при reconnect. */
export function on(event, handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(handler);
  if (socket) socket.on(event, handler);

  return () => {
    handlers.get(event)?.delete(handler);
    socket?.off(event, handler);
  };
}

export function emit(event, payload) {
  if (!socket || !socket.connected) return false;
  socket.emit(event, payload);
  return true;
}

/** Promise-обёртка над emit + ack: удобно ждать ответ сервера. */
export function request(event, payload, timeout = 5000) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ ok: false, error: 'not_connected' });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: 'timeout' });
      }
    }, timeout);

    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response || { ok: true });
    });
  });
}

export function connect() {
  if (socket) return socket;

  // io() приходит из локального static/vendor/socket.io.min.js
  socket = window.io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 8000,
  });

  socket.on('connect', () => {
    reconnectAttempt = 0;
    bus.emit('socket:connected', { id: socket.id });
  });

  socket.on('disconnect', (reason) => {
    bus.emit('socket:disconnected', { reason });
  });

  socket.on('connect_error', (error) => {
    reconnectAttempt += 1;
    bus.emit('socket:error', { error, attempt: reconnectAttempt });
    if (reconnectAttempt === 3) toast(t('voice.reconnecting'), { variant: '' });
  });

  // Подписчики, которые успели вызвать on() до connect() (voice.js, textchat.js),
  // иначе их обработчики остались бы висеть в map без реального слушателя.
  handlers.forEach((set, event) => {
    set.forEach((handler) => socket.on(event, handler));
  });

  // Все «серверные» события пробрасываем в шину — модули не знают про socket.io
  const forwarded = [
    'connected',
    'room_state',
    'voice_user_joined',
    'voice_user_left',
    'voice_roster',
    'voice_media_state',
    'text_message',
    'message_reactions',
    'message_notification',
    'typing',
    'offer',
    'answer',
    'ice_candidate',
    'screen_state',
  ];
  forwarded.forEach((event) => {
    socket.on(event, (payload) => bus.emit(`sio:${event}`, payload || {}));
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function isConnected() {
  return Boolean(socket && socket.connected);
}

// Небольшой публичный фасад для отладки/E2E (не влияет на работу UI)
if (typeof window !== 'undefined') {
  window.botyaratalk = window.botyaratalk || {};
  window.botyaratalk.socket = { emit, request, isConnected, on };
}
