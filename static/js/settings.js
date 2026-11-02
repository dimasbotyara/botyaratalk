/**
 * Настройки: устройства, громкости, шумоподавление, язык, тема, аккаунт.
 *
 * Всё живёт в localStorage (ключи settings.*) и применяется на лету:
 * - micGain / enhancedNoise → пересборка WebAudio-графа;
 * - micId / cameraId → перезапуск соответствующего трека;
 * - outputVolume / speakerId → объём и setSinkId всех медиа-элементов;
 * - lang → перерисовка data-i18n без перезагрузки;
 * - theme → смена data-theme на <html>.
 */

import {
  $, $$, CONFIG, bus, el, fetchJSON, mediaDevices, storage, stopStream, toast,
} from './utils.js';
import { applyTranslations, getLang, setLang, t } from './i18n.js';
import { rnnoiseInfo } from './noise.js';
import { applyTheme, currentTheme, renderThemeGrid, themeLabel } from './theme.js';

/** Флаг «в голосе» дублируется локально, чтобы не тянуть voice.js в настройки. */
const busState = { voice: false };

const DEFAULTS = {
  micId: '',
  cameraId: '',
  speakerId: '',
  micGain: 100,
  outputVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  noiseMode: 'native',
  selfMonitor: false,
};

const state = {
  settings: { ...DEFAULTS },
  open: false,
  localStream: null,
  graph: { ctx: null, source: null, gain: null, analyser: null, destination: null },
  rafId: 0,
  devices: { inputs: [], outputs: [], cameras: [] },
  activeTab: 'audio',
  micInUse: false,   // микрофон занят живым звонком — монитор не дублируем
  monitorPaused: false,
  monitorSettings: null,
  monitorNode: null,
  monitorCtx: null,
};

const els = {};

// ------------------------------------------------------------------ store
function loadSettings() {
  const loaded = {};
  Object.keys(DEFAULTS).forEach((key) => {
    const value = storage.get(`settings.${key}`, DEFAULTS[key]);
    loaded[key] = value;
  });
  state.settings = { ...DEFAULTS, ...loaded };
  els.selfMonitorChecked = Boolean(state.settings.selfMonitor);
  return state.settings;
}

function saveSetting(key, value) {
  state.settings[key] = value;
  storage.set(`settings.${key}`, value);
}

function resetSettings() {
  Object.keys(DEFAULTS).forEach((key) => {
    storage.set(`settings.${key}`, DEFAULTS[key]);
  });
  loadSettings();
  syncControls();
  bus.emit('settings:changed', { restartMic: true, restartCamera: true });
  toast(t('settings.reset_done'));
}

// --------------------------------------------------------------- контролы
function fillDeviceList(select, items, selected, fallbackLabel) {
  const current = select.value;
  select.innerHTML = '';

  const defaultOption = el('option', { value: '' }, fallbackLabel || t('settings.default_device'));
  select.append(defaultOption);

  items.forEach((device, index) => {
    const label = device.label || `${t('settings.default_device')} ${index + 1}`;
    const option = el('option', { value: device.deviceId }, label);
    select.append(option);
  });

  const next = selected || current || '';
  select.value = next;
}

async function refreshDevices() {
  const devices = mediaDevices();
  if (!devices?.enumerateDevices) return;

  let list = [];
  try {
    list = await devices.enumerateDevices();
  } catch {
    return;
  }

  state.devices.inputs = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  state.devices.outputs = list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
  state.devices.cameras = list.filter((d) => d.kind === 'videoinput' && d.deviceId !== 'default');

  fillDeviceList(els.mic, state.devices.inputs, state.settings.micId);
  fillDeviceList(els.camera, state.devices.cameras, state.settings.cameraId);
  fillDeviceList(els.speaker, state.devices.outputs, state.settings.speakerId);

  // Пока нет разрешения — браузер отдаёт пустые label'ы
  const hasLabels = state.devices.inputs.some((d) => d.label);
  els.devicesHint.hidden = hasLabels || !state.devices.inputs.length ? true : false;

  const micBusy = state.micInUse;
  els.mic.title = micBusy ? t('settings.mic_busy') : '';
  if (typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId !== 'function') {
    els.speaker.disabled = true;
    els.speakerRow.hidden = true;
    els.speakerUnsupported.hidden = false;
  } else if (!state.devices.outputs.length) {
    els.speaker.disabled = true;
  }
}

function syncControls() {
  els.mic.value = state.settings.micId || '';
  els.mic.disabled = state.micInUse;
  els.camera.value = state.settings.cameraId || '';
  els.speaker.value = state.settings.speakerId || '';

  els.rangeMic.value = String(state.settings.micGain);
  els.rangeMicValue.textContent = `${state.settings.micGain}%`;
  els.rangeOutput.value = String(state.settings.outputVolume);
  els.rangeOutputValue.textContent = `${state.settings.outputVolume}%`;

  els.chkNoise.checked = Boolean(state.settings.noiseSuppression);
  els.chkEcho.checked = Boolean(state.settings.echoCancellation);
  els.chkAgc.checked = Boolean(state.settings.autoGainControl);
  els.chkRnnoise.checked = state.settings.noiseMode === 'rnnoise';
  if (els.rnnoiseHint) {
    const info = rnnoiseInfo();
    els.rnnoiseHint.dataset.i18n = info.supported
      ? 'settings.rnnoise_hint'
      : 'settings.rnnoise_unsupported';
    applyTranslations(els.rnnoiseHint);
    els.chkRnnoise.disabled = !info.supported;
  }
  els.chkMonitor.checked = Boolean(state.settings.selfMonitor);

  renderLangSwitch();
  renderThemeSection();
  renderAbout();
}

function renderLangSwitch() {
  const lang = getLang();
  $$('[data-lang-option]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.langOption === lang));
  });
}

function renderThemeSection() {
  if (!els.themeGrid) return;
  renderThemeGrid(els.themeGrid, {
    selected: currentTheme(),
    onSelect: (name) => {
      applyTheme(name);
      renderThemeSection();
      bus.emit('theme:changed', { theme: name });
    },
    grouped: false,
  });
}

function renderAbout() {
  if (els.username) els.username.textContent = CONFIG.username || '—';
  if (els.avatar) els.avatar.textContent = (CONFIG.username || '?').slice(0, 2).toUpperCase();
  if (els.server) els.server.textContent = location.host;
  if (els.connection) {
    els.connection.textContent = navigator.onLine ? 'online' : 'offline';
    els.connection.className = `badge ${navigator.onLine ? 'badge--success' : 'badge--danger'}`;
  }
}

// ------------------------------------------------------- локальный монитор
/**
 * Тест микрофона в настройках.
 *
 * В звонке собственный захват по-прежнему не запускаем (устройство занято),
 * но кнопка больше не «мертвая»: подсказка объясняет, что слушать себя можно
 * кнопкой наушников в голосовой панели.
 */
function monitorUi(active) {
  if (!els.monitorBtn) return;
  els.monitorBtn.setAttribute('aria-pressed', String(Boolean(active)));

  const label = els.monitorBtn.querySelector('[data-monitor-label]');
  if (label) {
    if (state.micInUse) label.dataset.i18n = 'settings.monitor_unavailable';
    else label.dataset.i18n = active ? 'settings.monitor_stop' : 'settings.test_mic';
  }
  els.monitorBtn.disabled = state.micInUse;
  els.monitorBtn.title = state.micInUse ? t('settings.monitor_in_call') : '';
  els.monitorBtn.setAttribute('aria-disabled', String(state.micInUse));
  applyTranslations(els.monitorBtn);

  if (els.chkMonitor) {
    els.chkMonitor.disabled = state.micInUse;
    els.chkMonitor.closest('.switch')?.classList.toggle('switch--disabled', state.micInUse);
    els.chkMonitor.closest('.switch')?.setAttribute('title', state.micInUse ? t('settings.monitor_in_call') : '');
  }
  if (els.hintMonitor) {
    els.hintMonitor.hidden = !state.micInUse;
    els.hintMonitor.classList.toggle('settings-hint--warning', state.micInUse);
  }
}

async function startMonitor() {
  if (state.localStream) return;
  if (state.micInUse) {
    state.monitorPaused = true;
    els.hintMonitor.hidden = false;
    return;
  }
  const devices = mediaDevices();
  if (!devices?.getUserMedia) {
    toast(t('voice.secure_context'), { variant: 'danger' });
    return;
  }

  try {
    const stream = await devices.getUserMedia({
      audio: {
        deviceId: state.settings.micId ? { exact: state.settings.micId } : undefined,
        noiseSuppression: state.settings.noiseSuppression,
        echoCancellation: state.settings.echoCancellation,
        autoGainControl: state.settings.autoGainControl,
      },
      video: false,
    });
    state.localStream = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(2, state.settings.micGain / 100));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;

    source.connect(gain);
    gain.connect(analyser);
    // Только локальный монитор: в звонок этот граф не попадает
    if (state.settings.selfMonitor) gain.connect(ctx.destination);
    else {
      state.monitorNode = gain;
      state.monitorCtx = ctx;
    }

    state.graph = { ctx, source, gain, analyser, destination: ctx.destination };
    state.monitorSettings = { ...state.settings };
    ctx.resume().catch(() => {});
    startMeter();
    els.devicesHint.hidden = true;
    els.hintMonitor.hidden = true;
    if (els.monitorBtn) els.monitorBtn.disabled = false;
    monitorUi(state.settings.selfMonitor);
    await refreshDevices();
  } catch (error) {
    console.warn('[settings] monitor failed', error);
    toast(
      error?.name === 'NotAllowedError' ? t('voice.permission_denied') : t('voice.no_devices'),
      { variant: 'danger' },
    );
    if (els.monitorBtn) els.monitorBtn.disabled = false;
  }
}

function stopMonitor() {
  stopMeter();
  stopStream(state.localStream);
  state.localStream = null;
  try {
    state.graph.ctx?.close();
  } catch {
    /* уже закрыт */
  }
  state.graph = { ctx: null, source: null, gain: null, analyser: null, destination: null };
  state.monitorPaused = false;
  els.hintMonitor && (els.hintMonitor.hidden = true);
  monitorUi(false);
  if (els.monitorBtn) els.monitorBtn.disabled = false;
}

function setMonitorEnabled(enabled) {
  state.settings.selfMonitor = enabled;
  if (!state.graph.ctx) {
    if (enabled) startMonitor();
    return;
  }
  try {
    if (enabled) state.graph.gain.connect(state.graph.ctx.destination);
    else state.graph.gain.disconnect(state.graph.ctx.destination);
  } catch {
    /* повторное подключение/отключение безвредно */
  }
  if (state.graph.ctx.state === 'suspended') state.graph.ctx.resume().catch(() => {});
}

function startMeter() {
  if (state.rafId) return;
  const data = new Uint8Array(state.graph.analyser.fftSize);

  const tick = () => {
    const analyser = state.graph.analyser;
    if (!analyser) {
      state.rafId = 0;
      return;
    }
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
    const percent = Math.round(level * 100);
    els.vuFill.style.width = `${percent}%`;
    els.vu.setAttribute('aria-valuenow', String(percent));
    els.vu.dataset.level = level > 0.25 ? 'hot' : level > 0.08 ? 'mid' : 'low';
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function stopMeter() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  if (els.vuFill) els.vuFill.style.width = '0%';
}

// ------------------------------------------------------------- открытие/UX
export function openSettings(tab = state.activeTab) {
  els.modal.hidden = false;
  state.open = true;
  document.body.classList.add('modal-open');
  selectTab(tab);
  refreshDevices();
  syncControls();
  startMonitor(); // нужен для VU-метра и списка устройств с подписями
  els.modal.querySelector('.modal__dialog').focus?.();
  bus.emit('settings:opened');
}

export function closeSettings() {
  els.modal.hidden = true;
  state.open = false;
  document.body.classList.remove('modal-open');
  stopMonitor();
  bus.emit('settings:closed');
}

export function isSettingsOpen() {
  return state.open;
}

function selectTab(tab) {
  state.activeTab = tab;
  $$('.modal__nav-item').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  });
  $$('[data-panel]', els.content).forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

// ------------------------------------------------------------------- init
function bindControls() {
  els.mic.addEventListener('change', () => {
    saveSetting('micId', els.mic.value);
    bus.emit('settings:changed', { restartMic: true });
    if (state.localStream) {
      stopMonitor();
      startMonitor();
    }
  });

  els.camera.addEventListener('change', () => {
    saveSetting('cameraId', els.camera.value);
    bus.emit('settings:changed', { restartCamera: true });
  });

  els.speaker.addEventListener('change', () => {
    saveSetting('speakerId', els.speaker.value);
    bus.emit('settings:changed', {});
  });

  els.monitorBtn?.addEventListener('click', async () => {
    if (state.localStream) {
      stopMonitor();
      return;
    }
    els.monitorBtn.disabled = true;
    await startMonitor();
  });

  els.rangeMic.addEventListener('input', () => {
    const value = Number(els.rangeMic.value);
    els.rangeMicValue.textContent = `${value}%`;
    saveSetting('micGain', value);
    if (state.graph.gain) state.graph.gain.gain.value = Math.max(0, Math.min(2, value / 100));
    bus.emit('settings:gain-changed', { micGain: value });
  });

  els.rangeOutput.addEventListener('input', () => {
    const value = Number(els.rangeOutput.value);
    els.rangeOutputValue.textContent = `${value}%`;
    saveSetting('outputVolume', value);
    bus.emit('settings:changed', {});
  });

  const toggle = (node, key, extra = {}) => {
    node.addEventListener('change', () => {
      saveSetting(key, node.checked);
      bus.emit('settings:changed', extra);
    });
  };

  toggle(els.chkNoise, 'noiseSuppression', { restartMic: true });
  toggle(els.chkEcho, 'echoCancellation', { restartMic: true });
  toggle(els.chkAgc, 'autoGainControl', { restartMic: true });
  els.chkRnnoise.addEventListener('change', () => {
    saveSetting('noiseMode', els.chkRnnoise.checked ? 'rnnoise' : 'native');
    bus.emit('settings:changed', { restartMic: true });
  });

  els.chkMonitor.addEventListener('change', () => {
    saveSetting('selfMonitor', els.chkMonitor.checked);
    setMonitorEnabled(els.chkMonitor.checked);
  });

  els.reset.addEventListener('click', resetSettings);

  els.nav.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tab]');
    if (btn) selectTab(btn.dataset.tab);
  });

  els.langSwitch.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-lang-option]');
    if (!btn) return;
    await setLang(btn.dataset.langOption);
    applyTranslations(document);
    syncControls();
  });

  els.editThemeHint?.addEventListener('click', () => selectTab('appearance'));

  $$('[data-close-settings]').forEach((node) => node.addEventListener('click', closeSettings));
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeSettings();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) closeSettings();
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshDevices();
      toast(t('settings.devices_changed'));
    });
  }

  window.addEventListener('online', renderAbout);
  window.addEventListener('offline', renderAbout);

  // Микрофон занят звонком — собственный захват отключаем, чтобы не дёргать устройство
  bus.on('voice:joined', () => {
    state.micInUse = true;
    stopMonitor();
    els.mic.disabled = true;
    monitorUi(false);
    syncControls();
  });

  bus.on('voice:left', () => {
    state.micInUse = false;
    els.mic.disabled = false;
    monitorUi(Boolean(state.localStream));
    syncControls();
  });

  // Громкость микрофона меняется на лету в голосовом модуле
  bus.on('settings:gain-changed', ({ micGain }) => {
    if (state.graph.gain) state.graph.gain.gain.value = Math.max(0, Math.min(2, micGain / 100));
  });
}

export async function initSettings({ open = false } = {}) {
  els.modal = $('#settings-modal');
  if (!els.modal) return;

  els.nav = $('#settings-nav');
  els.content = $('#settings-content');
  els.mic = $('#sel-mic');
  els.camera = $('#sel-camera');
  els.speaker = $('#sel-speaker');
  els.speakerRow = $('#row-speaker');
  els.speakerUnsupported = $('#speaker-unsupported');
  els.devicesHint = $('#devices-hint');
  els.rangeMic = $('#range-mic');
  els.rangeMicValue = $('#range-mic-value');
  els.rangeOutput = $('#range-output');
  els.rangeOutputValue = $('#range-output-value');
  els.chkNoise = $('#chk-noise');
  els.chkEcho = $('#chk-echo');
  els.chkAgc = $('#chk-agc');
  els.chkRnnoise = $('#chk-rnnoise');
  els.rnnoiseHint = $('#rnnoise-hint');
  els.chkMonitor = $('#chk-monitor');
  els.monitorBtn = $('#test-mic');
  els.hintMonitor = $('#monitor-hint');
  els.vu = $('#vu-meter');
  els.vuFill = $('#vu-fill');
  els.reset = $('#reset-settings');
  els.langSwitch = $('#lang-switch');
  els.themeGrid = $('#settings-theme-grid');
  els.username = $('#settings-username');
  els.avatar = $('#settings-avatar');
  els.server = $('#settings-server');
  els.connection = $('#settings-connection');

  loadSettings();
  bindControls();
  syncControls();
  refreshDevices();

  bus.on('i18n:changed', () => {
    if (els.chkRnnoise) syncControls();
  });

  // Если звонок уже идёт — микрофон занят
  if (busState.voice) {
    state.micInUse = true;
    els.mic.disabled = true;
  }

  bus.on('settings:open', ({ tab } = {}) => openSettings(tab || 'audio'));

  // Смена локали в настройках — перерисовать подписи
  bus.on('i18n:changed', () => {
    syncControls();
    refreshDevices();
    monitorUi(Boolean(state.localStream));
  });

  // Deep-link: /settings открывает модалку сразу после загрузки
  if (open) {
    const requested = new URLSearchParams(window.location.search).get('tab');
    openSettings(['audio', 'appearance', 'about'].includes(requested) ? requested : 'audio');
  }
}

bus.on('voice:joined', () => {
  busState.voice = true;
});
bus.on('voice:left', () => {
  busState.voice = false;
});

export const __state = state;
