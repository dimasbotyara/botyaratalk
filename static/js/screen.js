/**
 * Демонстрация экрана (со звуком, если браузер даёт).
 *
 * Тактика:
 *  1. getDisplayMedia обязательно просим с audio: true, но не падаем, если
 *     браузер вернул только видео.
 *  2. Треки отдаём в voice.js — там они уходят в заранее созданные
 *     RTCRtpSender'ы через replaceTrack(), без пересогласования соединений.
 *  3. Кнопка «Стоп» в браузерной плашке (track.onended) возвращает всё назад.
 */

import { bus, isSecureEnoughForMedia, mediaDevices, stopStream } from './utils.js';
import { t } from './i18n.js';
import { isInVoice, setScreenState } from './voice.js';

const state = {
  stream: null,
  active: false,
  starting: false,
};

/** Параметры запроса: видео 1080p30 + системный звук (если поддерживается). */
function displayConstraints() {
  return {
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: {
      // Chrome: звук вкладки/системы. Firefox/Safari могут вернуть только видео.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    // Современные браузеры требуют явно указать, что пользователь может
    // выбрать вкладку (также это включает опцию «поделиться звуком»)
    systemAudio: 'include',
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  };
}

async function start() {
  if (state.starting || state.active) return state.active;
  if (!isInVoice()) {
    bus.emit('ui:toast', { message: t('voice.join'), variant: 'danger' });
    return false;
  }

  const devices = mediaDevices();
  if (!devices?.getDisplayMedia) {
    bus.emit('ui:toast', { message: t('voice.share_failed'), variant: 'danger' });
    return false;
  }

  state.starting = true;
  try {
    let stream;
    try {
      stream = await devices.getDisplayMedia(displayConstraints());
    } catch (error) {
      // Если браузер не понимает расширенные опции — пробуем минимальный набор
      if (error?.name === 'TypeError') {
        stream = await devices.getDisplayMedia({ video: true, audio: true });
      } else {
        throw error;
      }
    }

    state.stream = stream;
    state.active = true;

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      // Пользователь нажал «Остановить» в браузерной плашке
      videoTrack.addEventListener('ended', () => stop({ silent: false }));
    }

    if (!stream.getAudioTracks().length) {
      // Не блокируемся: многие системы не отдают системный звук
      console.info('[screen] browser did not provide an audio track');
    }

    await setScreenState(true, stream);
    bus.emit('voice:screen-changed', { active: true, hasAudio: stream.getAudioTracks().length > 0 });
    return true;
  } catch (error) {
    console.warn('[screen] start failed', error);
    const denied = error?.name === 'NotAllowedError';
    bus.emit('ui:toast', {
      message: denied ? t('voice.permission_denied') : t('voice.share_failed'),
      variant: 'danger',
    });
    return false;
  } finally {
    state.starting = false;
  }
}

async function stop({ silent = true } = {}) {
  if (!state.active && !state.stream) return false;

  const stream = state.stream;
  state.stream = null;
  state.active = false;

  await setScreenState(false, null);
  stopStream(stream);

  if (!silent) bus.emit('voice:screen-changed', { active: false });
  return true;
}

async function toggle() {
  if (state.active) return stop();
  return start();
}

export function isScreenActive() {
  return state.active;
}

export function getScreenStream() {
  return state.stream;
}

/** Есть ли в текущем шаринге аудио-трек (для бейджа «со звуком»). */
export function hasScreenAudio() {
  return Boolean(state.stream && state.stream.getAudioTracks().length);
}

export function initScreen() {
  // Ничего не подписываем: управление идёт из voice.js через контроллер.
  return { start, stop, toggle };
}

export { start, stop, toggle };
