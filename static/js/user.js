/**
 * Текущий пользователь: единственное место, где обновляются его аватарка и имя
 * во всех уголках интерфейса.
 *
 * Раньше каждый модуль рисовал аватарку по-своему, и после генерации картинки
 * она появлялась только в сайдбаре. Теперь все точки обновления собраны здесь,
 * а модули только сообщают «аватарка поменялась».
 */

import { $, $$, CONFIG, fetchJSON, initials } from './utils.js';
import { buildAvatar } from './message.js';

const state = {
  user: null,
};

/** Данные пользователя из /api/auth/me (или null). */
export async function loadCurrentUser() {
  const result = await fetchJSON(CONFIG.urls.me);
  if (!result.ok || !result.user) return null;
  state.user = result.user;
  return state.user;
}

export function currentUser() {
  return state.user;
}

/** Записывает пользователя, уже полученного другим модулем (main.js). */
export function setCurrentUser(user) {
  state.user = user || null;
  return state.user;
}

/** Перерисовывает аватарку на конкретном элементе, сохраняя id и классы. */
function refreshAvatarNode(node, { size = '' } = {}) {
  if (!node) return null;
  const user = state.user || { username: CONFIG.username };
  const className = size ? `avatar ${size}` : node.className.replace(/\bavatar--image\b/g, '').trim();
  const fresh = buildAvatar(user, className);

  Object.values(node.dataset || {}).forEach((value, index) => {
    const key = Object.keys(node.dataset)[index];
    fresh.dataset[key] = value;
  });
  if (node.id) fresh.id = node.id;
  if (node.getAttribute('aria-hidden')) fresh.setAttribute('aria-hidden', 'true');
  if (user.avatar?.url) fresh.setAttribute('aria-hidden', 'true');
  else fresh.textContent = initials(user.username || '?');

  node.replaceWith(fresh);
  return fresh;
}

/**
 * Обновляет все места, где показывается собственный пользователь:
 * сайдбар, модалка настроек, превью в онбординге и (если идёт звонок)
 * локальную плитку.
 */
export function refreshUserUi({ broadcast = true } = {}) {
  const user = state.user;
  if (!user) return;

  const name = $('#sidebar-username');
  if (name) name.textContent = user.username;

  const settingsName = $('#settings-username');
  if (settingsName) settingsName.textContent = user.username;

  refreshAvatarNode($('#sidebar-avatar'));
  refreshAvatarNode($('#settings-avatar'), { size: 'avatar--lg' });

  // Плитка «я» в звонке: обновляем центральную аватарку, если камера выключена
  $$('.voice-tile[data-local="true"] .voice-tile__fallback .avatar').forEach((node) => {
    refreshAvatarNode(node, { size: 'avatar--lg' });
  });

  if (broadcast) {
    // Другие вкладки и модули (чат, голос) узнают об изменении сами
    window.dispatchEvent(new CustomEvent('botyaratalk:user-updated', { detail: user }));
  }
}

/** Полный цикл: перечитать пользователя с сервера и обновить интерфейс. */
export async function reloadUserUi() {
  const user = await loadCurrentUser();
  if (user) refreshUserUi();
  return user;
}
