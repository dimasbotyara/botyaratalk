/**
 * Контекстное меню сообщения (правая кнопка мыши и долгое нажатие).
 *
 * Меню одно на всё приложение: создаётся лениво, позиционируется у курсора
 * и закрывается по Esc, клику вне и скроллу. Пункты меню — данные, поэтому
 * добавить новый пункт можно без правки разметки.
 */

import { $, el } from './utils.js';

const state = {
  node: null,
  items: [],
  opener: null,
  onClose: null,
};

function ensureNode() {
  if (state.node) return state.node;

  const node = el('div', { class: 'ctx-menu', role: 'menu', hidden: true });
  node.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const item = state.items.find((entry) => entry.id === button.dataset.action);
    close();
    item?.onSelect?.();
  });
  document.body.append(node);
  state.node = node;

  document.addEventListener('pointerdown', (event) => {
    if (!state.node || state.node.hidden) return;
    if (state.node.contains(event.target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);

  return node;
}

/**
 * Открывает меню.
 * @param {{x:number,y:number}} at — координаты курсора
 * @param {Array<{id:string,label:string,icon?:string,danger?:boolean,disabled?:boolean,onSelect:Function}>} items
 * @param {HTMLElement|null} opener — элемент, к которому вернём фокус
 */
export function openMenu(at, items, opener = null) {
  const node = ensureNode();
  state.items = items;
  state.opener = opener;
  node.innerHTML = '';

  items.forEach((item) => {
    const button = el(
      'button',
      {
        type: 'button',
        class: `ctx-menu__item${item.danger ? ' ctx-menu__item--danger' : ''}`,
        role: 'menuitem',
        dataset: { action: item.id },
        disabled: item.disabled,
      },
      item.icon ? el('span', { class: 'ctx-menu__icon', html: item.icon }) : null,
      el('span', { class: 'ctx-menu__label' }, item.label),
    );
    node.append(button);
  });

  node.hidden = false;
  node.style.visibility = 'hidden';
  node.style.left = '0px';
  node.style.top = '0px';

  // Не даём меню выехать за край экрана
  const rect = node.getBoundingClientRect();
  const margin = 8;
  const x = Math.min(at.x, window.innerWidth - rect.width - margin);
  const y = Math.min(at.y, window.innerHeight - rect.height - margin);
  node.style.left = `${Math.max(margin, x)}px`;
  node.style.top = `${Math.max(margin, y)}px`;
  node.style.visibility = '';

  node.dataset.open = 'true';
  node.querySelector('.ctx-menu__item:not(:disabled)')?.focus({ preventScroll: true });
}

export function close() {
  if (!state.node || state.node.hidden) return;
  state.node.hidden = true;
  delete state.node.dataset.open;
  state.opener?.focus?.({ preventScroll: true });
  const callback = state.onClose;
  state.onClose = null;
  callback?.();
}

export function isOpen() {
  return Boolean(state.node && !state.node.hidden);
}

/** Быстрое меню реакций: те же пункты, но в виде эмодзи-полоски. */
export function openReactionMenu(at, emojis, onPick) {
  const node = ensureNode();
  state.items = [];
  node.innerHTML = '';

  const bar = el('div', { class: 'ctx-menu__emojis' });
  emojis.forEach((emoji) => {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'ctx-menu__emoji',
        title: emoji,
        'aria-label': emoji,
        dataset: { action: `emoji-${emoji}` },
      },
      emoji,
    );
    state.items.push({ id: `emoji-${emoji}`, onSelect: () => onPick(emoji) });
    bar.append(button);
  });
  node.append(bar);

  node.hidden = false;
  const rect = node.getBoundingClientRect();
  node.style.left = `${Math.min(at.x, window.innerWidth - rect.width - 8)}px`;
  node.style.top = `${Math.max(8, at.y - rect.height - 8)}px`;
  node.dataset.open = 'true';
}

export { $ };
