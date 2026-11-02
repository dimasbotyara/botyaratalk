/**
 * RNNoise через AudioWorklet — локальная сборка, без CDN и npm.
 *
 * Что лежит в static/vendor/rnnoise/:
 *   - workletProcessor.js  — процессор из пакета @sapphi-red/web-noise-suppressor
 *                            (внутри — сборка @shiguredo/rnnoise-wasm, Apache-2.0);
 *   - rnnoise.wasm         — обычная сборка;
 *   - rnnoise_simd.wasm    — SIMD-сборка (быстрее, используется если браузер умеет);
 *   - LICENSE              — лицензия апстрима.
 *
 * Модуль отдаёт готовый AudioWorkletNode. Ошибки не пробрасываются наружу:
 * если браузер не умеет AudioWorklet/WebAssembly или WASM не загрузился,
 * возвращается null, и вызывающая сторона остаётся на нативном шумодаве.
 */

const WORKLET_URL = '/static/vendor/rnnoise/workletProcessor.js';
const WASM_URL = '/static/vendor/rnnoise/rnnoise.wasm';
const WASM_SIMD_URL = '/static/vendor/rnnoise/rnnoise_simd.wasm';
const PROCESSOR_NAME = '@sapphi-red/web-noise-suppressor/rnnoise';

/** Имя модуля в кеше: worklet загружается один раз на AudioContext. */
const loadedContexts = new WeakSet();
let wasmBufferCache = null;
let supportCache = null;

/** Минимальная проверка SIMD-поддержки — ровно тот же байткод, что в апстриме. */
function supportsSimd() {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}

export function isRnnoiseSupported() {
  if (supportCache !== null) return supportCache;
  supportCache = Boolean(
    typeof window !== 'undefined' &&
      window.AudioWorkletNode &&
      window.WebAssembly &&
      window.AudioContext &&
      window.fetch,
  );
  return supportCache;
}

/** Скачивает .wasm один раз на вкладку и держит ArrayBuffer в памяти. */
async function loadWasmBinary() {
  if (wasmBufferCache) return wasmBufferCache;

  const url = supportsSimd() ? WASM_SIMD_URL : WASM_URL;
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`rnnoise wasm: HTTP ${response.status}`);
  wasmBufferCache = await response.arrayBuffer();
  return wasmBufferCache;
}

/**
 * Создаёт узел шумоподавления.
 * @param {AudioContext} ctx
 * @returns {Promise<AudioWorkletNode|null>}
 */
export async function createRnnoiseNode(ctx) {
  if (!isRnnoiseSupported()) return null;

  try {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      loadedContexts.add(ctx);
    }
    const wasmBinary = await loadWasmBinary();
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { wasmBinary, maxChannels: 1 },
    });
    // Работаем в 48 кГц: RNNoise обучен именно на этой частоте
    return node;
  } catch (error) {
    console.warn('[rnnoise] не удалось инициализировать:', error);
    return null;
  }
}

/** Освобождает ресурсы воркера (структура процессора ждёт команду 'destroy'). */
export function destroyRnnoiseNode(node) {
  if (!node) return;
  try {
    node.port.postMessage('destroy');
  } catch {
    /* узел уже отключён */
  }
  try {
    node.disconnect();
  } catch {
    /* noop */
  }
}

/** Диагностика для настроек и E2E: что реально будет использовано. */
export function rnnoiseInfo() {
  return {
    supported: isRnnoiseSupported(),
    simd: typeof WebAssembly !== 'undefined' ? supportsSimd() : false,
    wasmUrl: supportsSimd() ? WASM_SIMD_URL : WASM_URL,
    workletUrl: WORKLET_URL,
  };
}
