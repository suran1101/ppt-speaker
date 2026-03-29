/**
 * TTS Engine - Generate audio using Qwen TTS (DashScope API)
 * 
 * Flow: Frontend → Vite server proxy → DashScope qwen3-tts-flash
 * 
 * Strategy:
 * 1. Call server proxy which talks to Qwen TTS API
 * 2. Server returns audio binary (WAV) directly
 * 3. Frontend creates Blob URL for Audio element
 */

const TTS_API = '/api/tts';
let ttsAvailable = null;

/**
 * Check if TTS service is available
 */
async function checkTtsAvailable() {
  if (ttsAvailable !== null) return ttsAvailable;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${TTS_API}?check=1`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    ttsAvailable = data.available === true;
  } catch {
    ttsAvailable = false;
  }
  return ttsAvailable;
}

/**
 * Detect TTS availability
 */
export async function detectTtsMode() {
  const hasTts = await checkTtsAvailable();
  if (hasTts) return 'qwen';
  if (window.speechSynthesis) return 'browser';
  return 'timer';
}

/**
 * Generate audio for a single text via Qwen TTS
 * @returns {string} Blob URL of the audio
 */
export async function generateAudioBlobUrl(text) {
  const res = await fetch(TTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `TTS error: ${res.status}`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Generate audio URLs for all scripts
 * @param {Array<{script: string}>} scripts
 * @param {Function} onProgress - (slideIndex, status, total)
 * @returns {Promise<{urls: string[], mode: string}>}
 */
export async function generateAllAudio(scripts, onProgress) {
  const mode = await detectTtsMode();

  if (mode === 'qwen') {
    const urls = [];
    for (let i = 0; i < scripts.length; i++) {
      onProgress?.(i, 'generating', scripts.length);
      try {
        const url = await generateAudioBlobUrl(scripts[i].script);
        urls.push(url);
        onProgress?.(i, 'done', scripts.length);
      } catch (err) {
        console.warn(`TTS failed for slide ${i}:`, err.message);
        urls.push('');
        onProgress?.(i, 'error', scripts.length);
      }
    }
    return { urls, mode: 'qwen' };
  }

  return { urls: scripts.map(() => ''), mode };
}

/**
 * Get TTS mode display label
 */
export function getTtsModeLabel(mode) {
  switch (mode) {
    case 'qwen': return 'Qwen TTS';
    case 'browser': return '浏览器语音';
    case 'timer': return '计时模式';
    default: return '检测中...';
  }
}
