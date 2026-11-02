/**
 * Голосовой канал: mesh-топология WebRTC, аудио-тракт с усилением,
 * видео, индикаторы речи и управление плитками участников.
 *
 * Ключевые решения (см. DECISIONS.md):
 *  - у каждого peer connection фиксированный набор из 4 трансиверов
 *    (mic, camera, screen-video, screen-audio) — это даёт возможность менять
 *    треки через replaceTrack() без пересогласования SDP;
 *  - входящие треки раздаются по порядку ontrack, который совпадает с
 *    порядком m-line'ов, а значит предсказуем для обеих сторон;
 *  - локальный микрофон проходит через WebAudio-граф (gain + фильтр),
 *    оттуда же берётся VU-метр и self-monitor.
 */

import {
  $, $$, CONFIG, avatarStyle, bus, el, fetchJSON, icon, initials,
  isSecureEnoughForMedia, mediaDevices, storage, stopStream, throttle,
} from './utils.js';
import { t } from './i18n.js';
import { emit, on, request } from './socket.js';
import { createRnnoiseNode, destroyRnnoiseNode, rnnoiseInfo } from './noise.js';
import { getRoom, setVoiceCount, setVoiceCurrent } from './rooms.js';
import {
  attachPictureInPictureButton, clearSpotlight, getMode, getSpotlight, setSpotlight,
} from './stage.js';

const MAX_PARTICIPANTS = 8;

const state = {
  room: null,
  joined: false,
  connecting: false,
  muted: false,
  cameraOn: false,
  screenOn: false,
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  peers: new Map(), // userId -> peer entry
  localStream: null, // сырой микрофон
  sendStream: null, // обработанный (gain) — уходит в звонок
  cameraStream: null,
  screenStream: null,
  screen: null, // контроллер шаринга, внедряется из main.js
  settings: {},
  audioGraph: null,
  meter: { ctx: null, analyser: null, source: null, data: null },
  rafId: 0,
  levels: new Map(), // userId -> уровень 0..1
  localTile: null,
  localScreenTile: null, // отдельная плитка собственной демонстрации
  monitorOn: false,      // «слышать себя» прямо в звонке
  monitorBeforeMute: false,
};

const els = {};

// ======================================================================
//  Настройки (приходят из settings.js)
// ======================================================================
function readSettings() {
  return {
    micId: storage.get('settings.micId', ''),
    cameraId: storage.get('settings.cameraId', ''),
    speakerId: storage.get('settings.speakerId', ''),
    micGain: Number(storage.get('settings.micGain', 100)),
    outputVolume: Number(storage.get('settings.outputVolume', 100)),
    noiseSuppression: storage.get('settings.noiseSuppression', true),
    echoCancellation: storage.get('settings.echoCancellation', true),
    autoGainControl: storage.get('settings.autoGainControl', true),
    // 'native' — только констрейнты браузера; 'rnnoise' — + RNNoise в AudioWorklet
    noiseMode: storage.get('settings.noiseMode', 'native'),
  };
}

function audioConstraints() {
  const settings = state.settings;
  return {
    deviceId: settings.micId ? { exact: settings.micId } : undefined,
    // Нативные флаги — главный инструмент шумоподавления (см. DECISIONS.md)
    noiseSuppression: settings.noiseSuppression !== false,
    echoCancellation: settings.echoCancellation !== false,
    autoGainControl: settings.autoGainControl !== false,
    channelCount: 1,
  };
}

function videoConstraints() {
  const settings = state.settings;
  return {
    deviceId: settings.cameraId ? { exact: settings.cameraId } : undefined,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

/**
 * Строит WebAudio-граф: микрофон → gain → [ФВЧ] → [RNNoise] → destination.
 *
 * RNNoise включается только если в настройках выбран режим 'rnnoise' и
 * AudioWorklet с WASM реально загрузился. Аппаратная частота контекста
 * переводится в 48 кГц — RNNoise обучен именно на ней, иначе качество падает.
 */
async function buildAudioGraph(rawStream) {
  destroyAudioGraph();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return rawStream;

  const ctx = new AudioCtx({ sampleRate: 48000 });
  const source = ctx.createMediaStreamSource(rawStream);
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(2, state.settings.micGain / 100));

  const destination = ctx.createMediaStreamDestination();
  const chain = [source, gain];

  // Ручной ФВЧ оставляем как лёгкую «подложку»: он дёшев и убирает низ даже
  // в нативном режиме, там где браузерный шумодав не справляется.
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = state.settings.noiseMode === 'rnnoise' ? 70 : 110;
  highpass.Q.value = 0.7;

  let rnnoiseNode = null;
  if (state.settings.noiseMode === 'rnnoise') {
    rnnoiseNode = await createRnnoiseNode(ctx);
  }

  if (rnnoiseNode) {
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 1.0;
    presence.gain.value = 2.5;
    chain.push(highpass, rnnoiseNode, presence);
  } else if (state.settings.noiseMode === 'rnnoise') {
    // Пользователь просил RNNoise, но браузер не дал — работаем с фильтром
    chain.push(highpass);
    bus.emit('voice:rnnoise-failed', {});
  } else {
    chain.push(highpass);
  }

  chain
    .reduce((prev, node) => {
      prev.connect(node);
      return node;
    })
    .connect(destination);

  // Self-monitor: отдельный узел, чтобы его можно было включать отдельно
  const monitor = ctx.createGain();
  monitor.gain.value = 0;
  chain[chain.length - 1].connect(monitor).connect(ctx.destination);

  // Анализатор для VU-метра и индикатора «говорит»
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.75;
  chain[chain.length - 1].connect(analyser);

  state.audioGraph = { ctx, source, gain, destination, monitor, analyser, chain, rnnoiseNode };

  ctx.resume().catch(() => {});
  return destination.stream;
}

function destroyAudioGraph() {
  if (!state.audioGraph) return;
  destroyRnnoiseNode(state.audioGraph.rnnoiseNode);
  try {
    state.audioGraph.ctx.close();
  } catch {
    /* уже закрыт */
  }
  state.audioGraph = null;
}

/** Трек, который реально отправляется в звонок (после обработки). */
function outboundAudioTrack() {
  return state.sendStream?.getAudioTracks()[0] || null;
}

// ======================================================================
//  Плитки участников
// ======================================================================
function tileAvatar(name) {
  const node = el('span', { class: 'avatar avatar--lg' }, initials(name));
  Object.assign(node.style, avatarStyle(name));
  return node;
}

/**
 * Плитка участника.
 *
 * @param {'camera'|'screen'} kind — обычная плитка (микрофон/камера) или
 *   отдельная плитка демонстрации экрана. Демонстрация всегда рисуется
 *   отдельной плиткой, поэтому камера и экран видны одновременно.
 */
function createTile({ userId, username, isLocal = false, kind = 'camera' }) {
  const tileId = kind === 'screen' ? `${userId}-screen` : String(userId);
  const tile = el('div', {
    class: `voice-tile voice-tile--${kind}`,
    dataset: { tile: tileId, local: String(isLocal), kind },
    tabindex: '0',
    role: 'button',
  });

  const video = el('video', {
    class: 'voice-tile__media',
    autoplay: true,
    playsinline: true,
    muted: isLocal ? '' : null,
  });
  video.muted = isLocal;
  video.hidden = true;

  const fallback = el('div', { class: 'voice-tile__fallback' }, tileAvatar(username));

  // «это вы» / «только звук» убраны: имя на плитке говорит само за себя,
  // а демонстрация подписана отдельно
  const label = kind === 'screen' ? `${username} · ${t('screen_sharing')}` : username;

  const nameRow = el(
    'div',
    { class: 'voice-tile__name' },
    el('span', { class: 'voice-level', hidden: true }),
    el('span', {}, label),
  );

  const badges = el('div', { class: 'voice-tile__badges' });

  tile.append(video, fallback, badges, nameRow);

  // Разворот плитки на большую площадь (только в закреплённом/полноэкранном режиме)
  tile.addEventListener('click', () => {
    if (!video.hidden) video.play().catch(() => {});
    setSpotlight(tileId);
  });
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSpotlight(tileId);
    }
  });

  return { tile, video, fallback, nameRow, badges, kind, tileId };
}

/** Бейдж на плитке демонстрации: только отметка «со звуком / без звука». */
function paintScreenBadge(entry, node) {
  const badges = node.badges;
  badges.innerHTML = '';
  const withAudio = Boolean(entry.screenAudioOn);
  const badge = el('span', {
    class: `voice-tile__badge voice-tile__badge--sharing${withAudio ? ' voice-tile__badge--audio' : ''}`,
    title: withAudio ? t('voice.screen_audio') : t('voice.screen_silent'),
    dataset: { screenBadge: '1', screenAudio: withAudio ? '1' : '0' },
  });
  badge.append(icon('screen'));
  if (withAudio) badge.append(icon('volume', 'voice-tile__badge-audio-icon'));
  badges.append(badge);
}

function updateTileBadges(entry) {
  if (entry.tileNode && entry.tileNode.kind === 'screen') paintScreenBadge(entry, entry.tileNode);
  if (entry.screenTile) paintScreenBadge(entry, entry.screenTile);
  if (!entry.tileNode || entry.tileNode.kind === 'screen') return;

  const badges = entry.tileNode.badges;
  badges.innerHTML = '';

  if (entry.muted) {
    const badge = el('span', { class: 'voice-tile__badge voice-tile__badge--muted', title: t('voice.muted_badge') });
    badge.append(icon('mic-off'));
    badges.append(badge);
  }
  // Демонстрация рисуется отдельной плиткой, поэтому на плитке камеры
  // бейджа «демонстрация» больше нет — он только дублировал информацию.
}

/**
 * Ставит плитку в сетку. Порядок: сначала участники, потом их демонстрации —
 * так экран всегда оказывается ниже камеры и не «перепрыгивает» при обновлении.
 */
/** Ставит конкретную плитку в сетку с учётом порядка «камеры выше экранов». */
function mountNode(node) {
  if (!node?.tile) return;
  const grid = els.grid;
  if (!grid.contains(node.tile)) {
    if (node.kind === 'screen') {
      grid.append(node.tile);
    } else {
      const firstScreen = grid.querySelector('.voice-tile--screen');
      if (firstScreen) grid.insertBefore(node.tile, firstScreen);
      else grid.append(node.tile);
    }
  }
  updateGridCount();
}

function mountTile(entry) {
  mountNode(entry?.tileNode);
}

function tileCount() {
  return els.grid.querySelectorAll('.voice-tile').length;
}

function updateGridCount() {
  const count = tileCount();
  els.grid.dataset.count = String(Math.max(1, Math.min(4, count)));
}

/** Есть ли в сетке хотя бы одно живое видео — от этого зависит раскладка. */
function hasAnyVideo() {
  return Boolean(els.grid.querySelector('.voice-tile:not(.voice-tile--empty-video) video:not([hidden])'));
}

const isUsableTrack = (track) => Boolean(track && track.readyState === 'live' && !track.muted);

/** Общая отрисовка трека в плитке: включить видео или показать аватар. */
function paintTile(node, stream) {
  const { video, fallback } = node;
  const hasVideo = Boolean(stream);
  video.hidden = !hasVideo;
  fallback.hidden = hasVideo;
  if (hasVideo) {
    video.srcObject = stream;
    video.play().catch(() => {});
    // Кнопка «картинка в картинке»: есть только там, где браузер её умеет
    attachPictureInPictureButton(node);
  } else {
    video.srcObject = null;
  }
  node.tile.classList.toggle('voice-tile--empty-video', !hasVideo);
}

/**
 * Плитка камеры удалённого участника. Экран сюда больше не попадает:
 * демонстрация живёт в собственной плитке (см. refreshRemoteScreen).
 */
function refreshRemoteVideo(entry) {
  if (!entry?.tileNode) return;
  const stream = isUsableTrack(entry.cameraTrack) ? new MediaStream([entry.cameraTrack]) : null;
  paintTile(entry.tileNode, stream);
}

/**
 * Отдельная плитка демонстрации экрана собеседника.
 *
 * Плитка создаётся здесь же: события приходят в разном порядке — флаг
 * `screen_state` может обогнать сам видеотрек, поэтому «создать при первом
 * живом треке» надёжнее, чем создавать заранее по одному флагу.
 */
function refreshRemoteScreen(entry) {
  if (!entry) return;

  const usable = entry.sharing && isUsableTrack(entry.screenVideoTrack);
  if (!usable) {
    if (entry.screenTile) {
      entry.screenTile.tile.remove();
      entry.screenTile = null;
      updateGridCount();
    }
    return;
  }

  if (!entry.screenTile) {
    entry.screenTile = createTile({ userId: entry.userId, username: entry.username, kind: 'screen' });
    mountNode(entry.screenTile);
  }
  const current = entry.screenTile.video.srcObject?.getVideoTracks?.()[0];
  if (current !== entry.screenVideoTrack) {
    paintTile(entry.screenTile, new MediaStream([entry.screenVideoTrack]));
  }
}

function refreshLocalVideo() {
  const entry = state.localTileEntry;
  if (!entry?.tileNode) return;
  const stream = state.cameraOn && state.cameraStream
    ? new MediaStream(state.cameraStream.getVideoTracks())
    : null;
  paintTile(entry.tileNode, stream);
}

/** Отдельная плитка собственной демонстрации экрана. */
function refreshLocalScreen() {
  const show = Boolean(state.screenOn && state.screenStream?.getVideoTracks().length);
  if (state.localTileEntry) {
    state.localTileEntry.sharing = show;
    state.localTileEntry.screenAudioOn = Boolean(state.screenStream?.getAudioTracks().length);
    updateTileBadges(state.localTileEntry);
  }

  if (!show) {
    state.localScreenTile?.tile.remove();
    state.localScreenTile = null;
    updateGridCount();
    return;
  }

  if (!state.localScreenTile) {
    state.localScreenTile = createTile({
      userId: 'local', username: CONFIG.username, isLocal: true, kind: 'screen',
    });
    mountNode(state.localScreenTile);
  }
  paintTile(state.localScreenTile, new MediaStream(state.screenStream.getVideoTracks()));
}

// ======================================================================
//  Peer connections
// ======================================================================
function isPeerReady(pc) {
  return pc.signalingState !== 'closed' && pc.remoteDescription;
}

async function createPeer(userId, username, { initiator }) {
  if (state.peers.has(userId)) return state.peers.get(userId);

  const pc = new RTCPeerConnection({
    iceServers: state.iceServers,
    sdpSemantics: 'unified-plan',
  });

  const entry = {
    userId,
    username,
    pc,
    initiator,
    micSender: null,
    cameraSender: null,
    screenVideoSender: null,
    screenAudioSender: null,
    audioEl: null,
    pendingCandidates: [],
    incoming: [],
    cameraTrack: null,
    screenVideoTrack: null,
    screenAudioTrack: null,
    sharing: false,
    muted: false,
    tileNode: null,
    connected: false,
  };
  state.peers.set(userId, entry);

  // Трансиверы создаёт только инициатор: у отвечающей стороны они появятся
  // из полученного offer'а, иначе Chrome не свяжет их с m-line'ами и
  // исходящие треки уйдут «в никуда». Порядок m-line'ов фиксирован:
  // 0 — микрофон, 1 — камера, 2 — экран (видео), 3 — экран (звук).
  if (initiator) {
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    bindSendersFromTransceivers(entry);
    await attachLocalTracks(entry);
  }

  // --- ICE ---------------------------------------------------------------
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      emit('ice_candidate', { target: userId, candidate: event.candidate, room: state.room });
    }
  };

  pc.onconnectionstatechange = () => {
    entry.connected = pc.connectionState === 'connected';
    updateVoiceStatus();
    if (['failed', 'closed'].includes(pc.connectionState)) {
      removePeer(userId);
    }
  };

  // --- входящие треки ----------------------------------------------------
  pc.ontrack = (event) => {
    const index = entry.incoming.length;
    entry.incoming.push(event.track);
    const [track] = [event.track];

    // Порядок m-line'ов: 0 — микрофон, 1 — камера, 2 — экран (видео), 3 — экран (звук)
    if (index === 0) {
      entry.micTrack = track;
      const audioEl = el('audio', { class: 'voice-tile__audio', autoplay: true });
      audioEl.srcObject = new MediaStream([track]);
      audioEl.volume = outputVolume();
      document.body.append(audioEl);
      entry.audioEl = audioEl;
      applySinkId(audioEl);
      audioEl.play().catch(() => {});
      attachRemoteAnalyser(entry, track);
    } else if (index === 1) {
      entry.cameraTrack = track;
      track.onunmute = () => refreshRemoteVideo(entry);
      track.onmute = () => refreshRemoteVideo(entry);
      refreshRemoteVideo(entry);
    } else if (index === 2) {
      entry.screenVideoTrack = track;
      track.onunmute = () => {
        entry.screenAudioOn = true;
        refreshRemoteScreen(entry);
        updateTileBadges(entry);
      };
      track.onmute = () => {
        entry.screenAudioOn = false;
        refreshRemoteScreen(entry);
        updateTileBadges(entry);
      };
      refreshRemoteScreen(entry);
    } else if (index === 3) {
      entry.screenAudioTrack = track;
      entry.screenAudioOn = true;
      updateTileBadges(entry);
      // Звук шаринга — отдельный элемент, не микшируем с микрофоном
      const audioEl = el('audio', { class: 'voice-tile__audio voice-tile__audio--screen', autoplay: true });
      audioEl.srcObject = new MediaStream([track]);
      audioEl.volume = outputVolume();
      audioEl.dataset.screenAudio = '1';
      document.body.append(audioEl);
      entry.screenAudioEl = audioEl;
      applySinkId(audioEl);
      audioEl.play().catch(() => {});
      track.onmute = () => {
        entry.screenAudioOn = Boolean(track.readyState === 'live' && !track.muted);
        updateTileBadges(entry);
      };
      track.onunmute = () => {
        entry.screenAudioOn = true;
        updateTileBadges(entry);
      };
    }
  };

  // --- плитка ------------------------------------------------------------
  entry.tileNode = createTile({ userId, username });
  mountTile(entry);
  updateTileBadges(entry);

  if (initiator) {
    await negotiate(entry);
  }
  return entry;
}

/**
 * Сопоставляет sender'ы трансиверов по порядку m-line'ов.
 * Вызывается и для инициатора (после addTransceiver), и для отвечающей
 * стороны (после setRemoteDescription с offer'ом).
 */
function bindSendersFromTransceivers(entry) {
  const transceivers = entry.pc.getTransceivers();
  if (!transceivers.length) return;

  const byKind = transceivers.map((t) => t.receiver?.track?.kind || t.sender?.track?.kind || 'audio');
  // Аудио-трансиверы идут парами: 0 — микрофон, 3 — звук экрана;
  // видео: 1 — камера, 2 — экран.
  const audio = transceivers.filter((_, index) => byKind[index] === 'audio');
  const video = transceivers.filter((_, index) => byKind[index] === 'video');

  entry.micSender = audio[0]?.sender || entry.micSender;
  entry.screenAudioSender = audio[1]?.sender || entry.screenAudioSender;
  entry.cameraSender = video[0]?.sender || entry.cameraSender;
  entry.screenVideoSender = video[1]?.sender || entry.screenVideoSender;
}

/** Прикрепляет локальные треки к заранее согласованным sender'ам. */
async function attachLocalTracks(entry) {
  const micTrack = outboundAudioTrack();
  if (micTrack) await entry.micSender?.replaceTrack(micTrack).catch(() => {});
  if (state.cameraOn && state.cameraStream) {
    await entry.cameraSender
      ?.replaceTrack(state.cameraStream.getVideoTracks()[0] || null)
      .catch(() => {});
  }
  if (state.screenOn && state.screenStream) {
    await entry.screenVideoSender
      ?.replaceTrack(state.screenStream.getVideoTracks()[0] || null)
      .catch(() => {});
    const screenAudio = state.screenStream.getAudioTracks()[0];
    if (screenAudio) await entry.screenAudioSender?.replaceTrack(screenAudio).catch(() => {});
  }
}

async function negotiate(entry) {
  try {
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    emit('offer', { target: entry.userId, sdp: entry.pc.localDescription, room: state.room });
  } catch (error) {
    console.warn('negotiate failed', error);
  }
}

async function applyOffer(payload) {
  const from = Number(payload.from);
  if (!from || from === CONFIG.userId) return;

  const username = payload.from_username || `#${from}`;
  let entry = state.peers.get(from);
  if (!entry) {
    entry = await createPeer(from, username, { initiator: false });
  }

  try {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    // После SRD у нас есть трансиверы на каждый m-line из offer'а.
    bindSendersFromTransceivers(entry);
    // По умолчанию отвечающая сторона получает direction=recvonly (так работает
    // алгоритм применения remote offer). Нам нужно отправлять свой микрофон и
    // камеру, поэтому явно переводим все трансиверы в sendrecv — это попадёт
    // в answer, дополнительное пересогласование не требуется.
    entry.pc.getTransceivers().forEach((transceiver) => {
      if (transceiver.direction !== 'stopped') transceiver.direction = 'sendrecv';
    });
    await attachLocalTracks(entry);
    await flushCandidates(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    emit('answer', { target: from, sdp: entry.pc.localDescription, room: state.room });
  } catch (error) {
    console.warn('applyOffer failed', error);
  }
}

async function applyAnswer(payload) {
  const from = Number(payload.from);
  const entry = state.peers.get(from);
  if (!entry) return;
  try {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    await flushCandidates(entry);
  } catch (error) {
    console.warn('applyAnswer failed', error);
  }
}

async function applyCandidate(payload) {
  const from = Number(payload.from);
  const entry = state.peers.get(from);
  if (!entry || !payload.candidate) return;
  if (!isPeerReady(entry.pc)) {
    entry.pendingCandidates.push(payload.candidate);
    return;
  }
  try {
    await entry.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch (error) {
    console.warn('addIceCandidate failed', error);
  }
}

async function flushCandidates(entry) {
  const queue = entry.pendingCandidates.splice(0);
  for (const candidate of queue) {
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.warn('queued candidate failed', error);
    }
  }
}

function removePeer(userId) {
  const entry = state.peers.get(userId);
  if (!entry) return;
  try {
    entry.pc.close();
  } catch {
    /* уже закрыт */
  }
  entry.audioEl?.remove();
  entry.screenAudioEl?.remove();
  entry.tileNode?.tile.remove();
  entry.screenTile?.tile.remove();
  entry.screenTile = null;
  detachRemoteAnalyser(entry);
  state.peers.delete(userId);
  state.levels.delete(userId);
  updateGridCount();
  updateVoiceStatus();
}

function closeAllPeers() {
  [...state.peers.keys()].forEach(removePeer);
}

// ======================================================================
//  Анализ уровня звука (индикатор «говорит», VU-метр)
// ======================================================================
const analyserRegistry = new Map(); // userId -> {analyser, data}

function sharedContext() {
  if (!state.meter.ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.meter.ctx = new AudioCtx();
  }
  if (state.meter.ctx.state === 'suspended') state.meter.ctx.resume().catch(() => {});
  return state.meter.ctx;
}

function attachRemoteAnalyser(entry, track) {
  try {
    const ctx = sharedContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyserRegistry.set(entry.userId, { analyser, data: new Uint8Array(analyser.fftSize), source });
  } catch (error) {
    console.warn('analyser for remote failed', error);
  }
}

function detachRemoteAnalyser(entry) {
  const record = analyserRegistry.get(entry.userId);
  if (!record) return;
  try {
    record.source.disconnect();
  } catch {
    /* noop */
  }
  analyserRegistry.delete(entry.userId);
}

function rms(analyser, data) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / data.length);
}

const SPEAKING_THRESHOLD = 0.02;
// Сглаживание по времени, а не по кадрам: индикатор «говорит» держится
// ~0.4 с после последнего всплеска и не мигает на паузах между слогами.
const LEVEL_HOLD_MS = 400;

/** Пик уровня за короткое окно — так «говорит» не мигает на каждом кадре. */
function peakLevel(record) {
  let peak = 0;
  for (let i = 0; i < 6; i += 1) {
    peak = Math.max(peak, rms(record.analyser, record.data));
  }
  return Math.min(1, peak * 4);
}

/** Держит уровень не ниже последнего пика в течение LEVEL_HOLD_MS. */
const levelPeaks = new Map(); // key -> {value, until}
function applyHold(key, value) {
  const now = performance.now();
  const record = levelPeaks.get(key);
  if (record && record.until > now && record.value > value) return record.value;
  if (value > 0) levelPeaks.set(key, { value, until: now + LEVEL_HOLD_MS });
  return value;
}

function levelLoop() {
  const localAnalyser = state.audioGraph?.analyser;
  if (localAnalyser) {
    const buf = new Uint8Array(localAnalyser.fftSize);
    const raw = Math.min(1, rms(localAnalyser, buf) * 4);
    const value = applyHold('local', raw);
    state.levels.set('local', value);
    updateSpeaking(state.localTileEntry, value, state.muted);
    bus.emit('voice:local-level', { level: value });
  }

  analyserRegistry.forEach((record, userId) => {
    const value = applyHold(userId, peakLevel(record));
    state.levels.set(userId, value);
    updateSpeaking(state.peers.get(userId), value, false);
  });

  state.rafId = requestAnimationFrame(levelLoop);
}

function updateSpeaking(entry, value, muted) {
  if (!entry?.tileNode) return;
  const speaking = !muted && value > SPEAKING_THRESHOLD;
  entry.tileNode.tile.classList.toggle('voice-tile--speaking', speaking);
  const dot = entry.tileNode.nameRow.querySelector('.voice-level');
  if (dot) dot.hidden = !speaking;
}

// ======================================================================
//  Локальные медиа
// ======================================================================
async function acquireMicrophone() {
  const devices = mediaDevices();
  if (!devices?.getUserMedia) throw new Error('no_getusermedia');

  const raw = await devices.getUserMedia({ audio: audioConstraints(), video: false });
  state.localStream = raw;
  state.sendStream = await buildAudioGraph(raw);

  // Если стрим оборвался (выдернули гарнитуру) — перезапрашиваем
  raw.getAudioTracks().forEach((track) => {
    track.onended = () => bus.emit('voice:device-lost', { kind: 'audio' });
  });

  return raw;
}

async function acquireCamera() {
  const devices = mediaDevices();
  if (!devices?.getUserMedia) throw new Error('no_getusermedia');
  const stream = await devices.getUserMedia({ video: videoConstraints(), audio: false });
  state.cameraStream = stream;
  return stream;
}

function releaseCamera() {
  stopStream(state.cameraStream);
  state.cameraStream = null;
}

function outputVolume() {
  const value = Number(state.settings.outputVolume ?? 100);
  return Math.max(0, Math.min(1, value / 100));
}

/** Громкость чужих голосов: 0, пока включён режим «слышать себя». */
function applyPeerVolume() {
  const volume = state.monitorOn ? 0 : outputVolume();
  state.peers.forEach((entry) => {
    if (entry.audioEl) entry.audioEl.volume = volume;
    if (entry.screenAudioEl) entry.screenAudioEl.volume = volume;
  });
  $$('audio[data-screen-audio]').forEach((node) => {
    node.volume = volume;
  });
}

function applyOutputVolume() {
  applyPeerVolume();
  // Громкость собственного монитора следует за ползунком вывода
  if (state.monitorOn) applyMonitorGain(!state.muted);
}

async function applySinkId(element) {
  if (!element || typeof element.setSinkId !== 'function') return;
  const sinkId = state.settings.speakerId;
  if (!sinkId) return;
  try {
    await element.setSinkId(sinkId);
  } catch {
    /* устройство пропало — игнорируем */
  }
}

/** Перенаправляет все исходящие аудио-треки на новый обработанный поток. */
async function pushLocalAudioToPeers() {
  const track = outboundAudioTrack();
  await Promise.all(
    [...state.peers.values()].map((entry) =>
      entry.micSender?.replaceTrack(track).catch(() => {}),
    ),
  );
}

async function pushCameraToPeers() {
  const track = state.cameraStream?.getVideoTracks()[0] || null;
  await Promise.all(
    [...state.peers.values()].map((entry) =>
      entry.cameraSender?.replaceTrack(state.cameraOn ? track : null).catch(() => {}),
    ),
  );
}

// ======================================================================
//  Публичное API
// ======================================================================
export function getVoiceRoom() {
  return state.room;
}

export function isInVoice() {
  return state.joined;
}

export function getPeers() {
  return state.peers;
}

export function getLocalStream() {
  return state.sendStream;
}

export function getSettings() {
  return { ...state.settings };
}

/** Максимальное время ожидания соединения перед попыткой voice_join. */
const SOCKET_WAIT_MS = 4000;

/** Проверка соединения без жёсткой зависимости от socket.js. */
function isSocketConnected() {
  return Boolean(window.botyaratalk?.socket?.isConnected?.());
}

/**
 * Ждёт установления Socket.IO-соединения и только потом выполняет запрос.
 * Без этого вход в голос отваливался, если пользователь успел нажать кнопку
 * в первые миллисекунды после загрузки страницы.
 */
async function whenConnected(timeoutMs = SOCKET_WAIT_MS) {
  if (isSocketConnected()) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offConnected();
      offError();
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    const offConnected = on('connected', () => finish(true));
    const offError = on('socket_error', () => finish(false));
  });
}

/** Внедрение контроллера шаринга (screen.js) — избегаем циклического импорта. */
export function setScreenController(controller) {
  state.screen = controller;
}

/** Перечитывает настройки и применяет их к живому звонку. */
export async function applySettings({ restartMic = false, restartCamera = false } = {}) {
  const previousMode = state.settings.noiseMode;
  state.settings = readSettings();
  // Смена режима шумодава = пересборка графа на лету (без пересоздания PC):
  // трек заменяется через replaceTrack у всех sender'ов.
  if (state.settings.noiseMode !== previousMode) {
    restartMic = true;
  }

  if (state.audioGraph) {
    state.audioGraph.gain.gain.value = Math.max(0, Math.min(2, state.settings.micGain / 100));
  }
  applyOutputVolume();

  if (restartMic && state.joined) {
    try {
      const previous = state.localStream;
      await acquireMicrophone();
      stopStream(previous);
      await pushLocalAudioToPeers();
      if (!state.muted) {
        const track = outboundAudioTrack();
        if (track) track.enabled = true;
      }
    } catch (error) {
      console.warn('mic restart failed', error);
    }
  }

  if (restartCamera && state.cameraOn) {
    try {
      releaseCamera();
      await acquireCamera();
      await pushCameraToPeers();
      refreshLocalVideo();
    } catch (error) {
      console.warn('camera restart failed', error);
    }
  }
}

export async function joinVoice(slug = state.room) {
  if (!slug) return false;
  if (state.joined) return true;
  if (state.connecting) return false;

  const devices = mediaDevices();
  if (!devices?.getUserMedia) {
    bus.emit('ui:toast', { message: t('voice.secure_context'), variant: 'danger' });
    return false;
  }

  state.connecting = true;
  state.room = slug;
  state.settings = readSettings();
  updateVoiceStatus();

  try {
    await acquireMicrophone();
  } catch (error) {
    state.connecting = false;
    const denied = error?.name === 'NotAllowedError' || error?.name === 'NotFoundError';
    bus.emit('ui:toast', {
      message: denied ? t('voice.permission_denied') : t('voice.connection_failed'),
      variant: 'danger',
    });
    updateVoiceStatus();
    return false;
  }

  const connected = await whenConnected();
  if (!connected) {
    state.connecting = false;
    stopStream(state.localStream);
    stopStream(state.sendStream);
    state.localStream = null;
    state.sendStream = null;
    destroyAudioGraph();
    bus.emit('ui:toast', { message: t('voice.reconnecting'), variant: 'danger' });
    updateVoiceStatus();
    return false;
  }

  const response = await request('voice_join', { room: slug });
  if (!response?.ok) {
    state.connecting = false;
    stopStream(state.localStream);
    stopStream(state.sendStream);
    state.localStream = null;
    state.sendStream = null;
    destroyAudioGraph();
    bus.emit('ui:toast', {
      message: response?.error === 'voice_full' ? t('voice.full') : t('voice.connection_failed'),
      variant: 'danger',
    });
    updateVoiceStatus();
    return false;
  }

  state.joined = true;
  state.connecting = false;
  state.muted = false;

  els.joinBlock.hidden = true;
  els.body.hidden = false;
  els.controls.hidden = false;
  els.panel.dataset.joined = 'true';
  if (els.pill) els.pill.hidden = false;

  // Локальная плитка
  state.localTileEntry = {
    userId: 'local',
    username: CONFIG.username,
    tileNode: createTile({ userId: 'local', username: CONFIG.username, isLocal: true }),
    muted: false,
    sharing: false,
    screenAudioOn: false,
  };
  mountTile(state.localTileEntry);
  refreshLocalVideo();

  // Инициатор — новичок: делаем offer всем, кто уже в канале
  const existing = response.users || [];
  for (const user of existing) {
    if (Number(user.user_id) === CONFIG.userId) continue;
    await createPeer(Number(user.user_id), user.username, { initiator: true });
    if (user.muted) setPeerMuted(user.user_id, true);
    if (user.sharing) setPeerSharing(user.user_id, true, { hasAudio: user.screen_audio ?? null });
  }

  setVoiceCount(slug, existing.length + 1, [
    CONFIG.username,
    ...existing.map((user) => user.username),
  ]);
  emit('voice_media_state', { room: slug, muted: false, camera: false });
  updateControls();
  updateVoiceStatus();
  if (!state.rafId) state.rafId = requestAnimationFrame(levelLoop);
  bus.emit('voice:joined', { room: slug });
  return true;
}

export async function leaveVoice() {
  if (!state.joined && !state.connecting) return;
  const slug = state.room;

  if (state.screenOn) await state.screen?.stop({ silent: true });

  emit('voice_leave', { room: slug });
  closeAllPeers();

  stopStream(state.localStream);
  stopStream(state.sendStream);
  stopStream(state.screenStream);
  state.localStream = null;
  state.sendStream = null;
  state.screenStream = null;
  releaseCamera();
  destroyAudioGraph();

  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  state.levels.clear();

  state.localTileEntry?.tileNode?.tile.remove();
  state.localTileEntry = null;
  state.localScreenTile?.tile.remove();
  state.localScreenTile = null;
  state.monitorOn = false;

  state.joined = false;
  state.connecting = false;
  state.muted = false;
  state.cameraOn = false;
  state.screenOn = false;

  els.joinBlock.hidden = false;
  els.body.hidden = false;
  els.controls.hidden = true;
  els.panel.dataset.joined = 'false';
  els.pill.hidden = true;

  if (slug) setVoiceCount(slug, 0, []);
  setVoiceCurrent(null);
  updateControls();
  updateVoiceStatus();
  bus.emit('voice:left', { room: slug });
}

export function toggleMute() {
  if (!state.joined) return;
  state.muted = !state.muted;

  const track = outboundAudioTrack();
  if (track) track.enabled = !state.muted;
  // Сырой трек тоже глушим, чтобы не «просачивался» через анализатор
  state.localStream?.getAudioTracks().forEach((raw) => {
    raw.enabled = !state.muted;
  });

  // Во время прослушивания себя микрофон должен оставаться живым локально:
  // окружающие при этом нас не слышат (трек в звонок выключен выше).
  if (state.monitorOn) applyMonitorGain(!state.muted);

  updateControls();
  updateSpeaking(state.localTileEntry, state.levels.get('local') || 0, state.muted);
  if (state.localTileEntry) {
    state.localTileEntry.muted = state.muted;
    updateTileBadges(state.localTileEntry);
  }
  emit('voice_media_state', { room: state.room, muted: state.muted, camera: state.cameraOn });
  bus.emit('voice:mute-changed', { muted: state.muted });
  return state.muted;
}

export async function toggleCamera() {
  if (!state.joined) return state.cameraOn;

  if (state.cameraOn) {
    state.cameraOn = false;
    await pushCameraToPeers();
    releaseCamera();
    refreshLocalVideo();
    emit('voice_media_state', { room: state.room, muted: state.muted, camera: false });
    updateControls();
    return false;
  }

  try {
    await acquireCamera();
    state.cameraOn = true;
    await pushCameraToPeers();
    refreshLocalVideo();
    emit('voice_media_state', { room: state.room, muted: state.muted, camera: true });
    updateControls();
  } catch (error) {
    bus.emit('ui:toast', { message: t('voice.permission_denied'), variant: 'danger' });
  }
  return state.cameraOn;
}

/** Вызывается из screen.js, когда шаринг начался/остановился. */
export async function setScreenState(active, stream = null) {
  state.screenOn = active;
  if (active) {
    state.screenStream = stream;
  }

  const videoTrack = active ? stream?.getVideoTracks()[0] || null : null;
  const audioTrack = active ? stream?.getAudioTracks()[0] || null : null;

  await Promise.all(
    [...state.peers.values()].map(async (entry) => {
      await entry.screenVideoSender?.replaceTrack(videoTrack).catch(() => {});
      await entry.screenAudioSender?.replaceTrack(audioTrack).catch(() => {});
    }),
  );

  if (state.localTileEntry) {
    state.localTileEntry.sharing = active;
    state.localTileEntry.screenAudioOn = Boolean(audioTrack);
    updateTileBadges(state.localTileEntry);
  }
  refreshLocalVideo();
  refreshLocalScreen();
  updateControls();

  if (!active) {
    state.screenStream = null;
  }
  emit(active ? 'screen_started' : 'screen_stopped', {
    room: state.room,
    audio: Boolean(active && audioTrack),
  });
  bus.emit('voice:screen-changed', { active });
}

/**
 * Громкость монитора внутри графа. 0 — выключено.
 * Монитор сидит на последнем узле цепочки, поэтому при RNNoise слышно
 * именно обработанный голос.
 */
function applyMonitorGain(on) {
  const graph = state.audioGraph;
  if (!graph?.monitor) return;
  graph.monitor.gain.value = on ? Math.max(0, Math.min(1, outputVolume())) : 0;
}

/**
 * «Слышать себя» прямо в звонке.
 *
 * Пока режим включён, микрофон не уходит в звонок: собеседники нас не слышат,
 * а мы не слышим их (их элементы воспроизведения глушатся). Так исключается
 * акустическая петля «свой микрофон ↔ свой динамик», которая иначе даёт эхо.
 */
export function toggleMonitor() {
  if (!state.joined) return false;
  state.monitorOn = !state.monitorOn;

  const track = outboundAudioTrack();
  if (track) track.enabled = state.monitorOn ? false : !state.muted;

  applyMonitorGain(state.monitorOn && !state.muted);
  applyPeerVolume();

  updateControls();
  updateTileBadges(state.localTileEntry || {});
  emit('voice_media_state', { room: state.room, muted: state.muted || state.monitorOn, camera: state.cameraOn });
  bus.emit('voice:monitor-changed', { active: state.monitorOn });
  return state.monitorOn;
}

export function isMonitorOn() {
  return state.monitorOn;
}

export function toggleScreen() {
  return state.screen?.toggle();
}

/** Смена комнаты во время звонка: выходим из текущей и входим в новую. */
export async function switchVoiceRoom(slug) {
  if (!state.joined) return joinVoice(slug);
  if (slug === state.room) return true;
  await leaveVoice();
  return joinVoice(slug);
}

// ======================================================================
//  Состояние участников с сервера
// ======================================================================
function setPeerMuted(userId, muted) {
  const entry = state.peers.get(Number(userId));
  if (!entry) return;
  entry.muted = muted;
  updateTileBadges({ ...entry, muted, sharing: entry.sharing });
}

function setPeerSharing(userId, sharing, { hasAudio = null } = {}) {
  const entry = state.peers.get(Number(userId));
  if (!entry) return;
  entry.sharing = sharing;
  if (hasAudio !== null) entry.screenAudioOn = Boolean(hasAudio);
  if (!sharing) entry.screenAudioOn = false;
  updateTileBadges(entry);
  refreshRemoteScreen(entry);
}

function renderVoiceRoster(users) {
  const list = els.list;
  if (!list) return;
  list.innerHTML = '';

  if (!users.length) {
    list.append(el('div', { class: 'voice-list__empty' }, t('room.nobody_in_voice')));
    els.count.hidden = true;
    return;
  }

  els.count.hidden = false;
  els.count.textContent = String(users.length);

  users.forEach((user) => {
    const row = el('div', { class: 'voice-list__row' });
    const avatar = el('span', { class: 'avatar avatar--sm' }, initials(user.username));
    Object.assign(avatar.style, avatarStyle(user.username));
    row.append(avatar, el('span', { class: 'voice-list__name' }, user.username));

    if (user.sharing) {
      const badge = el('span', { class: 'badge badge--accent' });
      badge.append(icon('screen'));
      row.append(badge);
    }
    if (user.muted) {
      const badge = el('span', { class: 'badge badge--danger' });
      badge.append(icon('mic-off'));
      row.append(badge);
    }
    list.append(row);
  });
}

// ======================================================================
//  UI
// ======================================================================
function updateControls() {
  const muteBtn = els.mute;
  muteBtn.setAttribute('aria-pressed', String(state.muted));
  muteBtn.dataset.i18nAriaLabel = state.muted ? 'voice.unmute' : 'voice.mute';
  muteBtn.setAttribute('aria-label', t(state.muted ? 'voice.unmute' : 'voice.mute'));
  muteBtn.setAttribute('title', t(state.muted ? 'voice.unmute' : 'voice.mute'));
  muteBtn.querySelector('use').setAttribute('href', state.muted ? '#i-mic-off' : '#i-mic');
  muteBtn.classList.toggle('ctrl-btn--danger', state.muted);

  const monitorBtn = els.monitor;
  if (monitorBtn) {
    monitorBtn.setAttribute('aria-pressed', String(state.monitorOn));
    const key = state.monitorOn ? 'voice.monitor_off' : 'voice.monitor_on';
    monitorBtn.setAttribute('aria-label', t(key));
    monitorBtn.setAttribute('title', t(key));
    monitorBtn.classList.toggle('ctrl-btn--active', state.monitorOn);
  }

  const camBtn = els.camera;
  camBtn.setAttribute('aria-pressed', String(state.cameraOn));
  camBtn.setAttribute('aria-label', t(state.cameraOn ? 'voice.camera_off' : 'voice.camera_on'));
  camBtn.setAttribute('title', t(state.cameraOn ? 'voice.camera_off' : 'voice.camera_on'));
  camBtn.querySelector('use').setAttribute('href', state.cameraOn ? '#i-camera' : '#i-camera-off');

  const screenBtn = els.screen;
  screenBtn.setAttribute('aria-pressed', String(state.screenOn));
  screenBtn.setAttribute('aria-label', t(state.screenOn ? 'voice.screen_stop' : 'voice.screen_start'));
  screenBtn.setAttribute('title', t(state.screenOn ? 'voice.screen_stop' : 'voice.screen_start'));
  screenBtn.querySelector('use').setAttribute('href', state.screenOn ? '#i-screen-off' : '#i-screen');
}

function updateVoiceStatus() {
  const node = els.status;
  const text = els.statusText;
  if (!node || !text) return;

  let labelKey = 'voice.not_connected';
  let stateName = 'idle';

  if (state.connecting) {
    labelKey = 'voice.connecting';
    stateName = 'connecting';
  } else if (state.joined) {
    labelKey = 'voice.connected';
    stateName = 'connected';
  }

  if (state.joined && state.peers.size) {
    const connected = [...state.peers.values()].filter((entry) => entry.connected).length;
    if (connected === 0 && !state.peers.size) {
      text.textContent = t('voice.reconnecting');
      node.dataset.state = 'connecting';
      return;
    }
  }

  node.dataset.state = stateName;
  text.textContent = t(labelKey);
  text.dataset.i18n = labelKey;
}

function updateJoinButtonLabel() {
  const label = els.join.querySelector('span');
  if (label) label.dataset.i18n = 'voice.join';
}

function initUI() {
  els.panel = $('#voice-panel');
  els.grid = $('#voice-grid');
  els.list = $('#voice-list');
  els.joinBlock = $('#voice-join-block');
  els.body = $('#voice-body');
  els.controls = $('#voice-controls');
  els.join = $('#voice-join');
  els.mute = $('#btn-mute');
  els.camera = $('#btn-camera');
  els.screen = $('#btn-screen');
  els.leave = $('#btn-leave');
  els.status = $('#voice-status');
  els.statusText = $('#voice-status-text');
  els.pill = $('#voice-pill');
  els.count = $('#voice-count');
  els.secureWarning = $('#voice-secure-warning');
  els.closeBtn = $('#close-voice-panel');
  els.monitor = $('#btn-monitor');

  if (!els.panel) return;

  els.join.addEventListener('click', () => {
    const room = getRoom(state.room) || null;
    if (!room) {
      bus.emit('ui:toast', { message: t('chat.no_room'), variant: 'danger' });
      return;
    }
    joinVoice(room.slug);
  });

  els.mute.addEventListener('click', () => toggleMute());
  els.monitor?.addEventListener('click', () => toggleMonitor());
  els.camera.addEventListener('click', () => toggleCamera());
  els.screen.addEventListener('click', () => toggleScreen());
  els.leave.addEventListener('click', () => leaveVoice());

  els.closeBtn?.addEventListener('click', () => {
    bus.emit('voice:close-request');
  });

  // Плашка «В голосовом канале» в шапке чата возвращает к плиткам
  els.pill?.addEventListener('click', () => {
    bus.emit('voice:open-request');
  });

  // Показываем предупреждение, если браузер не даст доступ к медиа
  if (!isSecureEnoughForMedia()) {
    els.secureWarning.hidden = false;
  }
}

function initSocketHandlers() {
  on('room_state', (payload) => {
    if (!payload?.users) return;
    renderVoiceRoster(payload.users);
  });

  on('voice_user_joined', async (payload) => {
    if (!state.joined || payload.room !== state.room) return;
    if (Number(payload.user_id) === CONFIG.userId) return;
    // Новичок сам пришлёт offer — соединение создастся по нему.
    renderVoiceRoster([...state.peers.values()].map((entry) => ({
      user_id: entry.userId,
      username: entry.username,
      muted: entry.muted,
      sharing: entry.sharing,
    })).concat([{ user_id: payload.user_id, username: payload.username, muted: false, sharing: false }]));
  });

  on('voice_user_left', (payload) => {
    if (!state.joined || payload.room !== state.room) return;
    removePeer(Number(payload.user_id));
  });

  on('voice_roster', (payload) => {
    if (!payload?.users) return;
    if (payload.room === state.room && state.joined) renderVoiceRoster(payload.users);
    // Имена нужны для подсказки у счётчика в сайдбаре
    setVoiceCount(payload.room, payload.users.length, payload.users.map((user) => user.username));
  });

  on('voice_media_state', (payload) => {
    if (payload.room !== state.room) return;
    if (Number(payload.user_id) === CONFIG.userId) return;
    setPeerMuted(payload.user_id, Boolean(payload.muted));
    const entry = state.peers.get(Number(payload.user_id));
    if (entry) {
      entry.camera = Boolean(payload.camera);
      refreshRemoteVideo(entry);
    }
  });

  on('screen_state', (payload) => {
    if (payload.room !== state.room) return;
    if (Number(payload.user_id) === CONFIG.userId) return;
    setPeerSharing(payload.user_id, Boolean(payload.sharing), {
      hasAudio: payload.audio ?? null,
    });
  });

  on('offer', (payload) => applyOffer(payload));
  on('answer', (payload) => applyAnswer(payload));
  on('ice_candidate', (payload) => applyCandidate(payload));
}

export function initVoice() {
  if (!$('#voice-panel')) return; // не страница приложения
  state.settings = readSettings();
  initUI();
  initSocketHandlers();

  // Комната фактически открыта (в том числе стартовая при загрузке)
  bus.on('room:active', ({ room }) => {
    if (!room) return;
    const previous = state.room;
    state.room = room.slug;
    if (state.joined && previous && previous !== room.slug) {
      switchVoiceRoom(room.slug);
    }
  });

  /**
   * Клик по голосовому каналу в сайдбаре: открываем голосовую зону на весь
   * экран и входим в канал. Текстовый чат при этом не переключается —
   * вернуться к переписке можно кликом по текстовому каналу.
   */
  bus.on('room:voice-select', ({ slug }) => {
    setVoiceCurrent(slug);
    state.room = state.room || slug;
    els.panel.dataset.open = 'true';
    bus.emit('voice:open-request');
    if (state.joined && state.room !== slug) switchVoiceRoom(slug);
    else if (!state.joined) joinVoice(slug);
  });

  // Клик по текстовому каналу возвращает чат на место
  bus.on('room:selected', () => bus.emit('voice:close-request'));

  bus.on('settings:changed', (detail) => {
    applySettings(detail || {});
  });

  bus.on('voice:device-lost', async ({ kind }) => {
    if (kind === 'audio' && state.joined) {
      await applySettings({ restartMic: true });
    }
  });

  fetchJSON(CONFIG.urls.ice).then((result) => {
    if (result.ok && Array.isArray(result.ice_servers)) state.iceServers = result.ice_servers;
  });

  // Метка языка: подписи кнопок обновляются при смене локали
  bus.on('i18n:changed', () => {
    updateControls();
    updateVoiceStatus();
    updateJoinButtonLabel();
  });

  renderVoiceRoster([]);
  exposeDebugApi();
}

/**
 * Отладочный снапшот для E2E-проверок и поддержки: window.botyaratalk.voice.
 * Не влияет на работу приложения, но позволяет скриптам и тестам увидеть
 * состояние peer connection без чтения внутренностей модуля.
 */
function exposeDebugApi() {
  window.botyaratalk = window.botyaratalk || {};
  window.botyaratalk.voice = {
    snapshot() {
      return {
        joined: state.joined,
        room: state.room,
        muted: state.muted,
        cameraOn: state.cameraOn,
        screenOn: state.screenOn,
        monitorOn: state.monitorOn,
        layout: getMode(),
        spotlight: getSpotlight(),
        tiles: [...els.grid.querySelectorAll('.voice-tile')].map((tile) => ({
          tile: tile.dataset.tile,
          kind: tile.dataset.kind,
          local: tile.dataset.local,
          spotlight: tile.classList.contains('voice-tile--spotlight'),
          hasVideo: !tile.querySelector('video')?.hidden,
        })),
        transceivers: [...state.peers.values()].flatMap((entry) =>
          entry.pc.getTransceivers().map((t, index) => ({
            peer: entry.userId,
            index,
            mid: t.mid,
            direction: t.direction,
            currentDirection: t.currentDirection,
            senderKind: t.sender?.track?.kind || null,
            receiverKind: t.receiver?.track?.kind || null,
            receiverState: t.receiver?.track?.readyState || null,
            receiverMuted: t.receiver?.track?.muted ?? null,
          })),
        ),
        peers: [...state.peers.values()].map((entry) => ({
          userId: entry.userId,
          username: entry.username,
          connection: entry.pc.connectionState,
          ice: entry.pc.iceConnectionState,
          inboundAudio: entry.micTrack?.readyState || null,
          inboundCamera: entry.cameraTrack?.readyState || null,
          inboundScreen: entry.screenVideoTrack?.readyState || null,
          inboundScreenAudio: entry.screenAudioTrack?.readyState || null,
          muted: entry.muted,
          sharing: entry.sharing,
        })),
        levels: Object.fromEntries(state.levels),
        noise: {
          mode: state.settings.noiseMode,
          rnnoiseActive: Boolean(state.audioGraph?.rnnoiseNode),
          ...rnnoiseInfo(),
        },
        analysers: {
          ctxState: state.meter.ctx?.state || null,
          remote: [...analyserRegistry.entries()].map(([userId, rec]) => ({
            userId,
            ctxState: rec.analyser.context?.state || null,
            sample: (() => {
              const buf = new Uint8Array(rec.analyser.fftSize);
              rec.analyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i += 1) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              return Math.sqrt(sum / buf.length);
            })(),
          })),
        },
        // SDP для отладки (LAN-инструмент, ничего секретного внутри нет)
        screenAudio: [...state.peers.entries()].map(([userId, entry]) => ({
          peer: userId,
          hasScreenAudioTrack: Boolean(entry.screenAudioTrack),
          flag: Boolean(entry.screenAudioOn),
          hasElement: Boolean(entry.screenAudioEl),
        })),
        sdp: [...state.peers.values()].map((entry) => ({
          peer: entry.userId,
          initiator: entry.initiator,
          local: entry.pc.localDescription?.sdp || null,
          remote: entry.pc.remoteDescription?.sdp || null,
        })),
      };
    },
    /** Внутреннее состояние — только для отладки и E2E. */
    __state: state,
    /** Возвращает первый RTCPeerConnection — нужен E2E для getStats(). */
    __peerForStats() {
      const first = [...state.peers.values()][0];
      return first ? first.pc : null;
    },
    /** Полный отчёт getStats() по первому пиру (аудит звука шаринга). */
    async stats() {
      const pc = this.__peerForStats();
      if (!pc) return null;
      const report = await pc.getStats();
      const rows = [];
      report.forEach((entry) => {
        if (entry.type === 'inbound-rtp') {
          rows.push({
            kind: entry.kind,
            mid: entry.mid,
            bytesReceived: entry.bytesReceived || 0,
            packetsReceived: entry.packetsReceived || 0,
          });
        }
      });
      return rows;
    },
  };
}

export const __state = state;
export { MAX_PARTICIPANTS, updateControls, renderVoiceRoster, exposeDebugApi };
