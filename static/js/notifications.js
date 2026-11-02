/**
 * Уведомления: браузерные Notification + бейджи непрочитанных + title.
 *
 * Правило: показываем уведомление, если сообщение пришло не в активную
 * комнату ИЛИ окно не в фокусе. Бейдж считается по комнатам и сбрасывается
 * при переключении.
 */

import { $, bus, el, storage } from './utils.js';
import { t } from './i18n.js';

const unread = new Map(); // slug -> count
let permissionAsked = false;
let activeRoom = null;
let baseTitle = document.title;

/** Никогда не спрашиваем разрешение самовольно при загрузке — только по событию. */
export async function ensurePermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  if (permissionAsked) return Notification.permission;
  permissionAsked = true;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function setActiveRoom(slug) {
  activeRoom = slug;
  if (slug) {
    unread.delete(slug);
    renderBadges();
    updateTitle();
  }
}

export function unreadCount(slug) {
  return unread.get(slug) || 0;
}

export function totalUnread() {
  return [...unread.values()].reduce((sum, value) => sum + value, 0);
}

export function renderBadges() {
  document.querySelectorAll('[data-room-badge]').forEach((node) => {
    const slug = node.dataset.roomBadge;
    const count = unread.get(slug) || 0;
    node.textContent = count > 99 ? '99+' : String(count);
    node.hidden = count === 0;
    node.setAttribute('aria-label', t('a11y.unread', { count }));
  });
}

function updateTitle() {
  const total = totalUnread();
  document.title = total > 0 ? `(${total}) ${baseTitle}` : baseTitle;
}

function bump(slug) {
  unread.set(slug, (unread.get(slug) || 0) + 1);
  renderBadges();
  updateTitle();
}

/** Новое сообщение: решаем, уведомлять ли, и обновляем бейдж. */
export function handleIncomingMessage({ room, username, text, roomName }) {
  const isVisible = !document.hidden;
  const inRoom = room === activeRoom && isVisible;

  if (inRoom) return false;

  bump(room);
  showNotification({ room, username, text, roomName });
  return true;
}

export function showNotification({ room, username, text, roomName }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && room === activeRoom) return;

  try {
    const roomLabel = roomName || t(`room.${room}`);
    const notification = new Notification(t('notif.new_message', {
      username,
      room: roomLabel,
      text,
    }), {
      icon: '/static/img/favicon.svg',
      badge: '/static/img/favicon.svg',
      tag: `botyaratalk-${room}`,
      renotify: true,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      bus.emit('notify:open-room', { room });
      notification.close();
    };
  } catch {
    /* некоторые браузеры кидают при отсутствии service worker */
  }
}

/** Счётчик в заголовке окна (мог перетереться другим модулем). */
export function refreshTitle() {
  baseTitle = 'botyaratalk';
  updateTitle();
}

/** Сбросить всё (например, при выходе). */
export function resetUnread() {
  unread.clear();
  renderBadges();
  updateTitle();
}

/** Сохранение счётчиков между перезагрузками не нужно — считаем заново. */
export function initNotifications() {
  baseTitle = document.title || 'botyaratalk';
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshTitle();
    } else {
      // окно ушло в фон — дальше уведомления будут нужны
      ensurePermission();
    }
  });
  // Клик по вкладке сбрасывает счётчик активной комнаты
  window.addEventListener('focus', () => {
    if (activeRoom) {
      unread.delete(activeRoom);
      renderBadges();
      updateTitle();
    }
  });
  storage.set('notifications.enabled', 'Notification' in window);
  // Сайдбар перерисовался (смена языка/категории) — вернуть актуальные счётчики
  bus.on('notifications:refresh-badges', () => renderBadges());
}


