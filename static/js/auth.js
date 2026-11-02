/**
 * Экран входа/регистрации: переключение режимов, валидация, запросы к API.
 * После успеха сервер ставит сессионную cookie — просто редиректим в /app.
 */

import { CONFIG, $, $$, fetchJSON, setCookie, storage, toast } from './utils.js';
import { applyTranslations, initI18n, t } from './i18n.js';
import { initTheme } from './theme.js';

const state = { mode: 'login', busy: false };

function errorNode() {
  return $('#auth-error');
}

function setError(message) {
  const node = errorNode();
  node.textContent = message || '';
}

function setBusy(busy) {
  state.busy = busy;
  const submit = $('#auth-submit');
  submit.disabled = busy;
  submit.setAttribute('aria-busy', String(busy));
}

function switchMode(mode) {
  state.mode = mode;
  const form = $('#auth-form');
  form.dataset.mode = mode;

  $$('.auth-tabs__btn').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  });

  const password2 = $('#auth-password2-field');
  password2.hidden = mode !== 'register';

  const submitLabel = $('#auth-submit span');
  submitLabel.dataset.i18n = mode === 'login' ? 'auth.submit_login' : 'auth.submit_register';
  applyTranslations(submitLabel.parentElement);

  const switchLabel = $('.auth-switch span');
  const switchBtn = $('[data-switch-mode]');
  switchLabel.dataset.i18n = mode === 'login' ? 'auth.no_account' : 'auth.have_account';
  switchBtn.dataset.i18n = mode === 'login' ? 'auth.to_register' : 'auth.to_login';
  switchBtn.dataset.switchMode = mode === 'login' ? 'register' : 'login';
  applyTranslations($('.auth-switch'));

  const password = $('#auth-password');
  password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  setError('');
}

function validate(username, password, password2) {
  if (username.length < 3) return t('auth.err_username');
  if (password.length < 6) return t('auth.err_password_short', { min: 6 });
  if (state.mode === 'register' && password !== password2) return t('auth.err_password_mismatch');
  return null;
}

async function submit(event) {
  event.preventDefault();
  if (state.busy) return;

  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const password2 = $('#auth-password2').value;

  const problem = validate(username, password, password2);
  if (problem) {
    setError(problem);
    return;
  }

  setError('');
  setBusy(true);

  const url = state.mode === 'login' ? CONFIG.urls.login : CONFIG.urls.register;
  const payload =
    state.mode === 'login' ? { username, password } : { username, password, password2 };

  const result = await fetchJSON(url, { method: 'POST', body: payload });
  setBusy(false);

  if (!result.ok) {
    setError(result.error && !result.error.startsWith('http_') ? result.error : t('auth.err_network'));
    return;
  }

  if (state.mode === 'register') {
    // Онбординг завершён — ставим клиентский флаг (сервер уже поставил httpOnly)
    setCookie(CONFIG.urls.onboarding ? 'botyaratalk_onboarded' : 'botyaratalk_onboarded', '1');
  }
  window.location.assign(CONFIG.urls.app);
}

async function init() {
  initTheme();
  await initI18n();

  $$('.auth-tabs__btn').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  const switchBtn = $('[data-switch-mode]');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => switchMode(switchBtn.dataset.switchMode));
  }

  $('#auth-form').addEventListener('submit', submit);

  // Если пользователь уже залогинен — сразу в приложение
  const me = await fetchJSON(CONFIG.urls.me);
  if (me.ok && me.user) {
    window.location.assign(CONFIG.urls.app);
    return;
  }
  storage.set('auth.visited', Date.now());
}

document.addEventListener('DOMContentLoaded', init);

export { switchMode, validate, toast };
