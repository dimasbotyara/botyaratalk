/**
 * Точка входа SPA-части: собирает вместе комнаты, чат, голос, настройки,
 * уведомления и i18n. Порядок инициализации важен:
 * i18n/тема → сокет → комнаты → чат → голос → шаринг → настройки.
 */

import { $, CONFIG, bus, fetchJSON, initials, setCookie, toast } from './utils.js';
import { initI18n, t } from './i18n.js';
import { applyTheme, currentTheme } from './theme.js';
import { connect, emit, isConnected } from './socket.js';
import { getCurrentRoom, initRooms, selectRoom } from './rooms.js';
import { initTextChat, openRoom, scrollToBottom } from './textchat.js';
import { initVoice, isInVoice, joinVoice, leaveVoice, setScreenController } from './voice.js';
import { initScreen } from './screen.js';
import { initSettings, openSettings } from './settings.js';
import * as notifications from './notifications.js';

const state = { ready: false };

// --------------------------------------------------------------- аккаунт
async function loadMe() {
  const result = await fetchJSON(CONFIG.urls.me);
  if (!result.ok || !result.user) {
    window.location.assign(CONFIG.urls.auth);
    return null;
  }
  return result.user;
}

function renderUser(user) {
  const avatar = $('#sidebar-avatar');
  const name = $('#sidebar-username');
  if (avatar) avatar.textContent = initials(user.username);
  if (name) name.textContent = user.username;
  document.title = 'botyaratalk';
}

async function logout() {
  if (!window.confirm(t('auth.logout_confirm'))) return;
  if (isInVoice()) await leaveVoice();
  await fetchJSON(CONFIG.urls.logout, { method: 'POST', body: {} });
  notifications.resetUnread();
  setCookie(CONFIG.urls.onboarding ? 'botyaratalk_onboarded' : 'botyaratalk_onboarded', '1');
  window.location.assign(CONFIG.urls.auth);
}

// --------------------------------------------------------------- комната
async function bootRoom() {
  const room = getCurrentRoom();
  if (!room) return;

  notifications.setActiveRoom(room.slug);
  await openRoom(room);
}

// --------------------------------------------------- события уведомлений
function bindNotifications() {
  bus.on('sio:message_notification', (payload) => {
    const room = getCurrentRoom();
    const roomNameKey = payload.room_name_key;

    notifications.handleIncomingMessage({
      room: payload.room,
      username: payload.username,
      text: payload.text,
      roomName: roomNameKey ? t(roomNameKey) : t(`room.${payload.room}`),
    });

    // Если мы в этой комнате и окно активно — сообщение уже отрисовано чатом
    if (room && payload.room === room.slug) {
      notifications.setActiveRoom(room.slug);
    }
  });

  bus.on('room:selected', ({ room }) => {
    notifications.setActiveRoom(room.slug);
  });

  bus.on('notify:open-room', ({ room }) => selectRoom(room));
}

// ------------------------------------------------------------ UI-хелперы
function bindGlobalUI() {
  $('#open-settings')?.addEventListener('click', () => openSettings('audio'));
  $('#logout')?.addEventListener('click', logout);
  $('#settings-logout')?.addEventListener('click', logout);

  // Быстрый доступ к настройкам с клавиатуры
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('#voice-panel')?.setAttribute('data-open', 'false');
    }
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      openSettings('audio');
    }
  });

  bus.on('ui:toast', ({ message, variant }) => toast(message, { variant }));

  bus.on('i18n:changed', () => {
    // Перерисовка шапки комнаты и плейсхолдера после смены языка
    const room = getCurrentRoom();
    if (room) {
      const title = document.querySelector('#room-title');
      if (title) title.textContent = t(room.name_key || `room.${room.slug}`);
      const input = $('#composer-input');
      if (input) {
        input.setAttribute('placeholder', t('chat.placeholder', { room: t(room.name_key) }));
      }
    }
    notifications.refreshTitle();
  });

  // Скролл вниз при возврате на вкладку
  window.addEventListener('focus', () => scrollToBottom());
}

// ------------------------------------------------------------- соединение
function bindSocketLifecycle() {
  bus.on('socket:connected', () => {
    const room = getCurrentRoom();
    if (room) {
      emit('join_room', { room: room.slug });
      if (isInVoice()) {
        // После реконнекта перезаходим в голосовой канал
        joinVoice(room.slug);
      }
    }
    const badge = $('#settings-connection');
    if (badge) badge.textContent = 'online';
  });

  bus.on('socket:disconnected', () => {
    const badge = $('#settings-connection');
    if (badge) badge.textContent = 'offline';
  });
}

// ------------------------------------------------------------------ init
async function init() {
  applyTheme(currentTheme(), { persist: false });
  await initI18n();

  notifications.initNotifications();

  const user = await loadMe();
  if (!user) return;
  renderUser(user);

  initTextChat();
  initVoice();
  setScreenController(initScreen());
  const openSettingsOnBoot = document.querySelector('#app-shell')?.dataset.openSettings === '1';
  await initSettings({ open: openSettingsOnBoot });
  bindGlobalUI();
  bindNotifications();
  bindSocketLifecycle();

  connect();

  await initRooms();
  await bootRoom();

  // /settings открыт напрямую — модалка уже показана в initSettings()

  // Разрешение на уведомления спрашиваем один раз, мягко
  setTimeout(() => notifications.ensurePermission(), 4000);

  state.ready = true;
  document.body.dataset.ready = 'true';
  bus.emit('app:ready');
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('[main] init failed', error);
    toast('botyaratalk: init failed', { variant: 'danger', timeout: 6000 });
  });
});

export { init, logout };
