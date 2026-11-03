/**
 * Пароль: оценка сложности и кнопка «показать/скрыть».
 *
 * Минимальная длина — 6 символов (как и на сервере), но «сложность» считается
 * по набору признаков: длина, регистр, цифры, символы и разнообразие символов.
 * Модуль общий для экрана входа и мастера онбординга, чтобы правила не
 * разъезжались между двумя формами.
 */

import { $$ } from './utils.js';
import { t } from './i18n.js';

export const MIN_PASSWORD_LENGTH = 6;

/**
 * Оценка сложности пароля: 0–4.
 *
 * 0 — пусто/совсем плохо, 1 — слабый, 2 — средний, 3 — хороший, 4 — сильный.
 * Однообразные строки («aaaaaa», «123456») штрафуются: длина без разнообразия
 * не делает пароль лучше.
 */
export function passwordStrength(value) {
  const password = String(value || '');
  if (!password) return 0;

  let score = 0;
  if (password.length >= 6) score += 1;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;

  const hasLower = /[a-zа-яё]/.test(password);
  const hasUpper = /[A-ZА-ЯЁ]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^\w\s]/.test(password);
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  if (classes >= 4) score += 1;

  const unique = new Set(password).size;
  if (unique <= 3) score -= 2;
  else if (unique <= 5) score -= 1;

  return Math.max(0, Math.min(4, score));
}

/** Человеческая подпись для балла. */
export function strengthLabel(score) {
  if (score <= 1) return t('auth.strength_weak');
  if (score === 2) return t('auth.strength_fair');
  if (score === 3) return t('auth.strength_good');
  return t('auth.strength_strong');
}

/**
 * Обновляет индикатор сложности.
 *
 * @param {HTMLElement|null} wrap — контейнер с data-score
 * @param {HTMLElement|null} label — подпись
 * @param {string} value — текущий пароль
 * @param {boolean} active — показывать ли вообще (только в режиме регистрации)
 */
export function updateStrengthMeter(wrap, label, value, active) {
  if (!wrap || !label) return;

  if (!active || !value) {
    wrap.hidden = true;
    wrap.dataset.score = '0';
    return;
  }

  const score = passwordStrength(value);
  wrap.hidden = false;
  wrap.dataset.score = String(score);
  label.textContent = strengthLabel(score);
}

/**
 * Кнопки-«глаза»: каждая переключает type у своего поля по data-password-toggle.
 * Иконка меняется на перечёркнутый глаз, когда пароль виден.
 */
export function bindPasswordToggles(root = document) {
  $$('[data-password-toggle]', root).forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;

      const revealed = input.type === 'text';
      input.type = revealed ? 'password' : 'text';
      button.setAttribute('aria-pressed', String(!revealed));

      const key = revealed ? 'auth.show_password' : 'auth.hide_password';
      button.setAttribute('title', t(key));
      button.setAttribute('aria-label', t(key));

      const use = button.querySelector('use');
      if (use) use.setAttribute('href', revealed ? '#i-eye' : '#i-eye-off');
    });
  });
}
