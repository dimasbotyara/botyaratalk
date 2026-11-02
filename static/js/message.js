/**
 * Сообщение в чате: ответ-цитата, реакции, контекстное меню, markdown,
 * карточки ссылок. Разметка собирается здесь, а textchat.js отвечает за
 * историю и отправку — так модуль остаётся небольшим.
 */

import { CONFIG, $, avatarStyle, el, escapeHtml, formatTime, initials } from './utils.js';
import { t } from './i18n.js';
import { linkHost, plainText, renderMarkdown } from './markdown.js';

// Meta-тег читается один раз при импорте — кэшируем, чтобы не зависеть от
// момента, когда модуль успел подключиться к CONFIG.
const SESSION_ID = String(
  document.querySelector('meta[name="botyaratalk-config"]')?.dataset?.userId || '0',
);

/** Быстрые реакции: то, что чаще всего ставят в мессенджерах. */
export const QUICK_REACTIONS = ['👍', '❤️', '🔥', '😂', '😮', '🙏'];

/** Кэш карточек ссылок: домен → {title, description} | null (не грузим дважды). */
const previewCache = new Map();

/** Аватарка пользователя: картинка, если есть, иначе инициалы. */
export function buildAvatar(user, className = 'avatar avatar--sm') {
  const name = user?.username || '?';
  const node = el('span', { class: className });
  const url = user?.avatar?.url;
  if (url) {
    const image = el('img', { class: 'avatar__img', src: url, alt: '', loading: 'lazy' });
    node.append(image);
    node.classList.add('avatar--image');
  } else {
    node.textContent = initials(name);
    Object.assign(node.style, avatarStyle(name));
  }
  return node;
}

/* --------------------------------------------------------------- ссылки */
function buildLinkCard(url) {
  const card = el('a', {
    class: 'link-card',
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer nofollow',
    dataset: { url },
  });
  card.append(
    el('span', { class: 'link-card__host' }, linkHost(url)),
    el('span', { class: 'link-card__title', dataset: { role: 'title' } }, url),
  );

  if (!previewCache.has(url)) {
    previewCache.set(url, null);
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((response) => response.json())
      .then((data) => {
        previewCache.set(url, data?.ok ? data : null);
        if (!data?.ok) return;
        // Все карточки с этим адресом обновляем сразу
        document.querySelectorAll(`.link-card[data-url="${CSS.escape(url)}"]`).forEach((node) => {
          const title = node.querySelector('[data-role="title"]');
          if (title) title.textContent = data.title;
          if (data.description) {
            node.append(el('span', { class: 'link-card__desc' }, data.description));
          }
        });
      })
      .catch(() => previewCache.set(url, null));
  } else {
    const cached = previewCache.get(url);
    if (cached) card.querySelector('[data-role="title"]').textContent = cached.title;
  }

  return card;
}

function buildLinkCards(links) {
  // Некоторые адреса приходят дважды (нормализация сервера + локальная
  // подсказка) — сравнение без завершающего слэша убирает дубли
  const clean = (links || []).map((url) => String(url).replace(/\/+$/, ''));
  const unique = [...new Set(clean)].slice(0, 3);
  if (!unique.length) return null;
  const wrap = el('div', { class: 'msg__links' });
  unique.forEach((url) => wrap.append(buildLinkCard(url)));
  return wrap;
}

/* ------------------------------------------------------------- реакции */
function reactionSummary(reactions, me) {
  const out = (reactions || []).map((item) => ({
    emoji: item.emoji,
    count: item.count,
    mine: (item.users || []).some((id) => String(id) === String(me)),
  }));
  return out;
}

function buildReactions(message) {
  const items = reactionSummary(message.reactions, SESSION_ID);
  if (!items.length) return null;

  const bar = el('div', { class: 'msg__reactions' });
  items.forEach((item) => {
    const button = el(
      'button',
      {
        type: 'button',
        class: `reaction${item.mine ? ' is-mine' : ''}`,
        dataset: { emoji: item.emoji },
        title: t('chat.reaction_toggle'),
        'aria-pressed': String(item.mine),
      },
      el('span', { class: 'reaction__emoji' }, item.emoji),
      el('span', { class: 'reaction__count' }, String(item.count)),
    );
    bar.append(button);
  });
  return bar;
}

/* --------------------------------------------------------------- ответ */
function buildReply(message) {
  const reply = message.reply_to;
  if (!reply) return null;
  const node = el(
    'button',
    {
      type: 'button',
      class: 'msg__reply',
      dataset: { jumpTo: String(reply.id) },
      title: t('chat.reply_jump'),
    },
    el('span', { class: 'msg__reply-author' }, reply.username || '?'),
    el('span', { class: 'msg__reply-text' }, plainText(reply.text || '')),
  );
  return node;
}

/* ------------------------------------------------------------ сообщение */
export function renderMessage(message, previous, { onSelect } = {}) {
  const own = String(message.user_id) === String(SESSION_ID);
  const previousTs = previous ? new Date(previous.ts) : null;
  const currentTs = new Date(message.ts);
  const isGrouped =
    Boolean(previous) &&
    String(previous.user_id) === String(message.user_id) &&
    previousTs.toDateString() === currentTs.toDateString() &&
    currentTs - previousTs < 5 * 60 * 1000 &&
    !message.reply_to;

  const row = el('article', {
    class: `msg${isGrouped ? ' msg--grouped' : ''}${own ? ' msg--own' : ''}`,
    dataset: {
      messageId: String(message.id),
      userId: String(message.user_id),
      ts: message.ts,
    },
  });

  const gutter = el('div', { class: 'msg__gutter' });
  if (isGrouped) {
    gutter.append(el('span', { class: 'msg__time-inline' }, formatTime(message.ts)));
  } else {
    gutter.append(buildAvatar({ username: message.username, avatar: message.avatar }));
  }

  const content = el('div', { class: 'msg__content' });
  if (!isGrouped) {
    const head = el('div', { class: 'msg__head' });
    // Никаких «(Вы)» — свой стиль и так виден по цвету и выравниванию
    head.append(
      el('span', { class: 'msg__author' }, message.username || '?'),
      el('span', { class: 'msg__time' }, formatTime(message.ts)),
    );
    content.append(head);
  }

  const reply = buildReply(message);
  if (reply) content.append(reply);

  const text = el('div', { class: 'msg__text' });
  text.innerHTML = renderMarkdown(message.text);
  content.append(text);

  const cards = buildLinkCards(message.links);
  if (cards) content.append(cards);

  const reactions = buildReactions(message);
  if (reactions) content.append(reactions);

  row.append(gutter, content);

  // Клики: реакция, переход к цитируемому сообщению, выделение
  row.addEventListener('click', (event) => {
    const reaction = event.target.closest('.reaction');
    if (reaction) {
      event.stopPropagation();
      onSelect?.({ type: 'reaction', message, emoji: reaction.dataset.emoji });
      return;
    }
    const jump = event.target.closest('[data-jump-to]');
    if (jump) {
      event.stopPropagation();
      jumpToMessage(jump.dataset.jumpTo);
      return;
    }
    onSelect?.({ type: 'message', message });
  });

  // Правая кнопка мыши — контекстное меню
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    onSelect?.({ type: 'context', message, x: event.clientX, y: event.clientY });
  });

  return row;
}

/** Прокрутка к сообщению и подсветка — для переходов по ответам. */
export function jumpToMessage(id) {
  const target = document.querySelector(`.msg[data-message-id="${CSS.escape(String(id))}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('msg--highlight');
  // reflow, чтобы анимация запустилась повторно
  void target.offsetWidth;
  target.classList.add('msg--highlight');
  setTimeout(() => target.classList.remove('msg--highlight'), 1600);
}

/** Обновляет панель реакций у сообщения без полной перерисовки. */
export function updateReactions(messageId, reactions) {
  const row = document.querySelector(`.msg[data-message-id="${CSS.escape(String(messageId))}"]`);
  if (!row) return;
  const content = row.querySelector('.msg__content');
  const existing = content.querySelector('.msg__reactions');
  const fresh = buildReactions({ reactions });

  if (existing) {
    if (fresh) {
      existing.replaceWith(fresh);
    } else {
      existing.remove();
    }
    return;
  }
  if (fresh) content.append(fresh);
}

export { escapeHtml };
