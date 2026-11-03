/**
 * Онбординг: язык → аккаунт (вход ИЛИ регистрация) → тема.
 *
 * Порядок шагов важен: сначала человек выбирает язык (на нём говорит мастер),
 * потом входит в существующий аккаунт или создаёт новый, и только в конце
 * выбирает тему — она применяется ко всему приложению и к самому мастеру.
 *
 * Сервер по факту успешного входа/регистрации ставит httpOnly-cookie сессии
 * и cookie botyaratalk_onboarded — после этого просто уходим в /app.
 */

import { CONFIG, $, $$, fetchJSON, setCookie, storage, toast } from './utils.js';
import { applyTranslations, detectLang, initI18n, setLang, t } from './i18n.js';
import { applyTheme, currentTheme, markSelectedCard, renderThemeGrid } from './theme.js';
import { MIN_PASSWORD_LENGTH, bindPasswordToggles, passwordStrength, updateStrengthMeter } from './password.js';

const STEPS = ['lang', 'account', 'theme'];
const state = {
  step: 'lang',
  lang: null,
  mode: 'login', // 'login' | 'register'
  theme: currentTheme(),
  confirmedTheme: currentTheme(),
  busy: false,
};

// ---------------------------------------------------------------- навигация
function applyStepAttributes(step) {
  $$('[data-step-dot]').forEach((dot) => {
    const index = STEPS.indexOf(dot.dataset.stepDot);
    const currentIndex = STEPS.indexOf(step);
    let stateName = 'upcoming';
    if (index === currentIndex) stateName = 'active';
    else if (index < currentIndex) stateName = 'done';
    dot.dataset.state = stateName;
  });
}

function goTo(step, { focus = true } = {}) {
  if (!STEPS.includes(step)) return;
  state.step = step;
  $('#onboarding').dataset.step = step;
  applyStepAttributes(step);

  $$('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== step;
  });

  if (focus) {
    const firstInput = $(`[data-panel="${step}"] input`);
    if (firstInput) firstInput.focus({ preventScroll: true });
  }
}

// ----------------------------------------------------------------- язык
function selectLang(code) {
  state.lang = code;
  $$('[data-lang-choice]').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.langChoice === code));
  });
}

async function confirmLang() {
  const code = state.lang || detectLang();
  await setLang(code, { persist: true });
  // Перерисовываем карточки тем: их подписи зависят от языка
  renderThemeStep();
}

// ----------------------------------------------------------------- темы
function renderThemeStep() {
  const grid = $('#theme-groups');
  if (!grid) return;
  renderThemeGrid(grid, {
    selected: state.theme,
    onSelect: (name) => {
      state.theme = name;
      applyTheme(name, { persist: false }); // временный предпросмотр всей страницы
      markSelectedCard(grid, name);
      updateApplyButton();
    },
  });
  updateApplyButton();
}

function updateApplyButton() {
  const btn = $('#apply-theme');
  if (!btn) return;
  const dirty = state.theme !== state.confirmedTheme;
  btn.disabled = !dirty;
  btn.setAttribute('aria-disabled', String(!dirty));
}

function confirmTheme() {
  state.confirmedTheme = applyTheme(state.theme, { persist: true });
  state.theme = state.confirmedTheme;
  markSelectedCard($('#theme-groups'), state.confirmedTheme);
  updateApplyButton();
  toast(t('settings.saved'));
}

// ------------------------------------------------------------- аккаунт
/** Переключение «войти / зарегистрироваться» без перезагрузки. */
function switchMode(mode) {
  if (!['login', 'register'].includes(mode)) return;
  state.mode = mode;

  const form = $('#onboarding-form');
  form.dataset.mode = mode;

  $$('[data-account-mode]').forEach((tab) => {
    const active = tab.dataset.accountMode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  const repeat = $('#ob-password2-field');
  if (repeat) repeat.hidden = mode !== 'register';

  // Подсказка о сложности нужна только при создании пароля
  const strength = $('#ob-strength');
  if (strength && mode !== 'register') strength.hidden = true;

  const password = $('#ob-password');
  password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';

  const label = $('#ob-submit-label');
  if (label) {
    label.dataset.i18n = mode === 'login' ? 'auth.submit_login' : 'onboarding.register.action';
    label.textContent = t(label.dataset.i18n);
  }

  const title = $('#ob-account-title');
  if (title) {
    title.dataset.i18n = mode === 'login' ? 'onboarding.login.title' : 'onboarding.register.title';
    title.textContent = t(title.dataset.i18n);
  }

  // При входе повторный пароль не нужен и не должен мешать валидации
  const repeatInput = $('#ob-password2');
  if (repeatInput && mode === 'login') repeatInput.value = '';

  setError('');
}

/** Обновляет индикатор сложности под полем пароля. */
function updateStrength(value) {
  updateStrengthMeter($('#ob-strength'), $('#ob-strength-label'), value, state.mode === 'register');
}

function updatePreview(username) {
  const name = $('#ob-preview-name');
  if (name) name.textContent = username || '—';
  const avatar = $('#ob-preview-avatar');
  if (avatar) avatar.textContent = (username || '?').slice(0, 2).toUpperCase();
}

function setError(message) {
  const node = $('#ob-error');
  if (node) node.textContent = message || '';
}

function setBusy(busy) {
  state.busy = busy;
  const submit = $('#ob-submit');
  if (!submit) return;
  submit.disabled = busy;
  submit.setAttribute('aria-busy', String(busy));
}

async function submitAccount(event) {
  event.preventDefault();
  if (state.busy) return;

  const username = $('#ob-username').value.trim();
  const password = $('#ob-password').value;
  const password2 = $('#ob-password2').value;

  if (username.length < 3) return setError(t('auth.err_username'));
  if (password.length < MIN_PASSWORD_LENGTH) return setError(t('auth.err_password_short', { min: MIN_PASSWORD_LENGTH }));
  if (state.mode === 'register' && password !== password2) {
    return setError(t('auth.err_password_mismatch'));
  }

  setError('');
  setBusy(true);

  const isRegister = state.mode === 'register';
  const result = await fetchJSON(isRegister ? CONFIG.urls.register : CONFIG.urls.login, {
    method: 'POST',
    body: isRegister ? { username, password, password2 } : { username, password },
  });

  setBusy(false);

  if (!result.ok) {
    setError(result.error && !String(result.error).startsWith('http_') ? result.error : t('auth.err_network'));
    return;
  }

  // Успех: сервер уже поставил сессию. Осталось сохранить выбор и перейти к теме.
  setCookie('botyaratalk_onboarded', '1');
  storage.set('lang', state.lang);
  goTo('theme', { focus: false });
  toast(t(isRegister ? 'onboarding.register.done' : 'auth.signed_in'));
}

/** Последний шаг: сохраняем тему и уходим в приложение. */
function finish() {
  confirmTheme();
  storage.set('theme', state.confirmedTheme);
  window.location.assign(CONFIG.urls.app);
}

// ------------------------------------------------------------------ init
async function init() {
  const detected = detectLang();
  await initI18n({ lang: detected });
  selectLang(detected);
  applyTheme(currentTheme(), { persist: false });
  renderThemeStep();
  switchMode('login');
  goTo('lang', { focus: false });

  $$('[data-lang-choice]').forEach((card) => {
    card.addEventListener('click', () => selectLang(card.dataset.langChoice));
  });

  $$('[data-action="next"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.from === 'lang') {
        await confirmLang();
        goTo(btn.dataset.to || 'account', { focus: false });
      }
    });
  });

  $$('[data-action="back"]').forEach((btn) => {
    btn.addEventListener('click', () => goTo(btn.dataset.to));
  });

  const finishBtn = $('[data-action="finish"]');
  if (finishBtn) finishBtn.addEventListener('click', finish);

  // «Применить» — фиксирует тему, не уходя со шага
  const applyBtn = $('#apply-theme');
  if (applyBtn) applyBtn.addEventListener('click', confirmTheme);

  // Вход / регистрация
  $$('[data-account-mode]').forEach((tab) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.accountMode));
  });

  $('#ob-username').addEventListener('input', (event) => updatePreview(event.target.value.trim()));
  $('#ob-password').addEventListener('input', (event) => updateStrength(event.target.value));
  $('#onboarding-form').addEventListener('submit', submitAccount);

  bindPasswordToggles();

  // Показываем актуальные подписи после смены языка
  applyTranslations(document);
  switchMode('login');
}

document.addEventListener('DOMContentLoaded', init);

export { goTo, selectLang, confirmTheme, switchMode, passwordStrength };
