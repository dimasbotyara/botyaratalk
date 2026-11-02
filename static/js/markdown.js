/**
 * Мини-markdown для сообщений чата.
 *
 * Задача: не тянуть внешнюю библиотеку (у нас всё локальное) и при этом
 * не пропустить XSS. Поэтому стратегия безопасная: сначала экранируем весь
 * текст, затем расставляем разметку по уже экранированной строке. Пользователь
 * физически не может вставить тег — максимум, что он получит, это свой же
 * текст с `<` вместо `<b>`.
 *
 * Поддерживаем: **жирный**, *курсив*, ~~зачёркнутый~~, `код`, ```блок кода```,
 * > цитату, списки - / 1., ссылки (в т.ч. без схемы — https:// допишется).
 */

import { escapeHtml } from './utils.js';

const LINK_RE = /(?<![\w@.:/-])((?:https?:\/\/|localhost)[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?)/gi;

/** Дописывает https://, если схемы нет. Повторно не добавляет. */
export function normalizeHref(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^(javascript|data|vbscript|mailto|tel):/i.test(value)) return null;
  return `https://${value}`;
}

/** Безопасный рендер ссылки: href только http(s), rel и target — обязательны. */
function link(raw) {
  const href = normalizeHref(raw);
  if (!href) return escapeHtml(raw);
  try {
    const parsed = new URL(href);
    if (!['http:', 'https:'].includes(parsed.protocol)) return escapeHtml(raw);
  } catch {
    return escapeHtml(raw);
  }
  return `<a class="msg__link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(raw)}</a>`;
}

/** Инлайн-разметка одной строки (текст уже экранирован). */
function inline(escaped) {
  let out = escaped;

  // Код — первым, чтобы внутри не срабатывали другие правила. Плейсхолдеры
  // собираем в массив и возвращаем после, иначе звёздочки кода станут курсивом.
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code class="msg__code">${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Ссылки до форматирования: иначе звёздочки в URL попадут в курсив
  out = out.replace(LINK_RE, (match) => link(match));

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
  return out;
}

/**
 * Рендерит текст сообщения в HTML.
 * Возвращает готовую строку для innerHTML — она безопасна по построению.
 */
export function renderMarkdown(text) {
  const source = String(text ?? '');
  if (!source.trim()) return '';

  // Блок кода целиком выносим до построчного разбора
  const blocks = [];

  const lines = escapeHtml(source).split('\n');
  // Каждый элемент: либо блочный (список, цитата, код), либо строчный текст.
  // Переводы строк ставим только между строчными — иначе внутри <ul> появятся
  // лишние <br>, которые ломают отступы и выглядят как пустые строки.
  const html = [];
  let inCode = false;
  let codeBuffer = [];
  let list = null; // 'ul' | 'ol' | null

  const push = (chunk, block = false) => html.push({ chunk, block });
  const closeList = () => {
    if (list) {
      push(`</${list}>`, true);
      list = null;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (inCode) {
        blocks.push(codeBuffer.join('\n'));
        push(`\u0001${blocks.length - 1}\u0001`, true);
        codeBuffer = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      push('');
      continue;
    }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      push(`<span class="msg__quote">${inline(quote[1])}</span>`, true);
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') {
        closeList();
        push('<ul class="msg__list">', true);
        list = 'ul';
      }
      push(`<li>${inline(bullet[1])}</li>`, true);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (list !== 'ol') {
        closeList();
        push('<ol class="msg__list">', true);
        list = 'ol';
      }
      push(`<li>${inline(ordered[1])}</li>`, true);
      continue;
    }

    closeList();
    push(inline(line));
  }

  if (inCode) {
    // Незакрытый блок кода — считаем его обычным кодом, а не теряем
    blocks.push(codeBuffer.join('\n'));
    push(`\u0001${blocks.length - 1}\u0001`, true);
  }
  closeList();

  let result = '';
  html.forEach((item, index) => {
    if (index > 0) {
      const prev = html[index - 1];
      if (!item.block && !prev.block) result += '<br>';
    }
    result += item.chunk;
  });

  result = result.replace(/\u0001(\d+)\u0001/g, (_, index) => {
    const code = blocks[Number(index)];
    return `<pre class="msg__pre"><code>${code}</code></pre>`;
  });

  return result;
}

/**
 * Извлекает ссылки из текста — используется для карточек-превью.
 * Совпадает по смыслу с app/links.py: сервер уже отдаёт готовый список,
 * но при локальной отправке карточку нужно построить до ответа сервера.
 */
export function extractLinks(text) {
  const source = String(text ?? '');
  const found = [];
  const matches = source.matchAll(new RegExp(LINK_RE.source, LINK_RE.flags));
  for (const match of matches) {
    const href = normalizeHref(match[1]);
    if (href && !found.includes(href)) found.push(href);
  }
  return found;
}

/** Текст без разметки — для цитат ответов и уведомлений. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/^&gt;\s?/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .trim();
}

/** Короткая подпись ссылки: домен без www. */
export function linkHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
