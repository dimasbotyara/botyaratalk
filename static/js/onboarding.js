/**
 * Онбординг: язык → тема (с живым предпросмотром) → регистрация.
 *
 * Тема применяется «вживую» при клике по карточке (без сохранения), кнопка
 * «Применить» фиксирует выбор в localStorage/cookie, а сервер по факту
 * регистрации ставит httpOnly-cookie botyaratalk_onboarded.
 */

import { CONFIG, $, $$, fetchJSON, setCookie, storage, toast } from './utils.js';
import { applyTranslations, detectLang, initI18n, setLang, t } from './i18n.js';
import { applyTheme, currentTheme, markSelectedCard, renderThemeGrid } from './theme.js';

const STEPS = ['lang', 'theme', 'register'];
const state = {
  step: 'lang',
  lang: null,
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

// ------------------------------------------------------------ регистрация
function passwordStrength(value) {
  let score = 0;
  if (value.length >= 6) score += 1;
  if (value.length >= 10) score += 1;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;
  return Math.min(3, Math.max(value ? 1 : 0, score - 1));
}

function updatePasswordMeter(value) {
  const strength = passwordStrength(value);
  $$('.password-meter__bar').forEach((bar, index) => {
    bar.dataset.filled = String(strength >= index + 1 ? Math.min(strength, 3) : 0);
  });
}

function updatePreview(username) {
  $('#ob-preview-name').textContent = username || '—';
  const avatar = $('#ob-preview-avatar');
  avatar.textContent = (username || '?').slice(0, 2).toUpperCase();
}

function setError(message) {
  $('#ob-error').textContent = message || '';
}

async function register(event) {
  event.preventDefault();
  if (state.busy) return;

  const username = $('#ob-username').value.trim();
  const password = $('#ob-password').value;
  const password2 = $('#ob-password2').value;

  if (username.length < 3) return setError(t('auth.err_username'));
  if (password.length < 6) return setError(t('auth.err_password_short', { min: 6 }));
  if (password !== password2) return setError(t('auth.err_password_mismatch'));

  setError('');
  state.busy = true;
  const submit = $('#ob-submit');
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');

  const result = await fetchJSON(CONFIG.urls.register, {
    method: 'POST',
    body: { username, password, password2 },
  });

  state.busy = false;
  submit.disabled = false;
  submit.removeAttribute('aria-busy');

  if (!result.ok) {
    setError(result.error && !String(result.error).startsWith('http_') ? result.error : t('auth.err_network'));
    return;
  }

  // Страховка: если сервер не поставил httpOnly-cookie (например, старый
  // билд), ставим клиентскую — навигация всё равно продолжится.
  setCookie('botyaratalk_onboarded', '1');
  storage.set('lang', state.lang);
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
  goTo('lang', { focus: false });

  $$('[data-lang-choice]').forEach((card) => {
    card.addEventListener('click', () => selectLang(card.dataset.langChoice));
  });

  $$('[data-action="next"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.from === 'lang') {
        await confirmLang();
        goTo('theme', { focus: false });
      } else if (btn.dataset.from === 'theme') {
        confirmTheme();
        goTo('register');
      }
    });
  });

  $$('[data-action="back"]').forEach((btn) => {
    btn.addEventListener('click', () => goTo(btn.dataset.to));
  });

  // «Применить» — фиксирует тему, не уходя со шага
  const applyBtn = $('#apply-theme');
  if (applyBtn) applyBtn.addEventListener('click', confirmTheme);

  $('#ob-username').addEventListener('input', (event) => updatePreview(event.target.value.trim()));
  $('#ob-password').addEventListener('input', (event) => updatePasswordMeter(event.target.value));
  $('#onboarding-form').addEventListener('submit', register);

  // Escape из последнего шага никуда не ведёт — визард обязателен
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA') return;
    if (state.step !== 'register' && event.target.tagName !== 'BUTTON') return;
  });

  // Показываем актуальные подписи после смены языка
  applyTranslations(document);
}

document.addEventListener('DOMContentLoaded', init);

export { goTo, selectLang, confirmTheme, passwordStrength };
