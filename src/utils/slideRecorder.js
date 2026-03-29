/**
 * SlideRecorder — Records a single slide's canvas + audio into a video file.
 *
 * Architecture:
 *   Strategy 1 (preferred): WebCodecs H.264 VideoEncoder + AAC AudioEncoder → mp4-muxer → MP4
 *   Strategy 2 (fallback):  MediaRecorder → WebM (VP9/Opus)
 *
 * Output: MP4 (H.264+AAC) or WebM (VP9+Opus) video at 1920×1080, 30fps
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { PlaybackEngine } from './playbackEngine.js';
import { createCanvas, renderSlideAsync } from './slideRenderer.js';

const RECORD_W = 1920;
const RECORD_H = 1080;
const FPS = 30;
const VIDEO_BITRATE = 5_000_000; // 5 Mbps

/**
 * Check if WebCodecs MP4 pipeline is available.
 */
function isWebCodecsSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

/**
 * Convert a blob URL to an ArrayBuffer
 */
async function blobUrlToArrayBuffer(blobUrl) {
  const response = await fetch(blobUrl);
  return response.arrayBuffer();
}

/**
 * Convert a Float32Array (interleaved stereo or mono) to 16-bit PCM Int16Array.
 */
function floatTo16BitPCM(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

/**
 * Record a single slide to video using WebCodecs (H.264 + AAC → MP4).
 */
async function recordSlideToMP4(options) {
  const { parsedSlide, actions, onProgress, audioContext: existingAudioCtx } = options;

  onProgress?.('render', '渲染幻灯片到画布...');

  // 1. Create offscreen canvas at recording resolution
  const { canvas, ctx } = createCanvas(RECORD_W, RECORD_H);

  const renderSlide = async (renderCtx) => {
    renderCtx.save();
    renderCtx.scale(2, 2);
    await renderSlideAsync(renderCtx, parsedSlide, { width: 960, height: 540 });
    renderCtx.restore();
  };

  // 2. Collect all speech audio blobs
  const speechSegments = actions.filter(a => a.type === 'speech' && a.audioUrl);

  onProgress?.('audio', `准备 ${speechSegments.length} 段语音...`);

  // 3. Create AudioContext for audio capture
  let audioContext = existingAudioCtx || null;
  let audioStream = null;
  let scriptProcessor = null;

  if (speechSegments.length > 0 && !audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext) {
    audioStream = audioContext.createMediaStreamDestination();
    // ScriptProcessorNode sits in the audio signal chain to capture PCM data
    // before it reaches the recording destination (audioStream).
    // Correct topology: Source → ScriptProcessorNode → audioStream
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    // The onaudioprocess callback will be set later (step 9) after AudioEncoder is ready
    scriptProcessor.connect(audioStream);
  }

  // 4. Create PlaybackEngine with modified speech handler
  const engine = new PlaybackEngine({
    canvas,
    ctx,
    renderSlide,
    actions,
    slideData: parsedSlide,
    onStateChange: () => {},
    onScriptUpdate: () => {},
    onTimeUpdate: () => {},
    onSlideComplete: () => {},
  });

  // Override _executeSpeech to schedule audio through AudioContext
  const originalExecuteSpeech = engine._executeSpeech.bind(engine);
  engine._executeSpeech = async function (action) {
    const text = action.text || '';
    const audioUrl = action.audioUrl;
    this._charOffset += text.length;

    if (audioUrl && audioContext && audioStream) {
      try {
        const arrayBuffer = await blobUrlToArrayBuffer(audioUrl);
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        // Connect: Source → ScriptProcessorNode → audioStream (for recording)
        // ScriptProcessorNode is already connected to audioStream in step 3
        source.connect(scriptProcessor);
        // Also play through speakers so the user hears during recording
        source.connect(audioContext.destination);

        const now = audioContext.currentTime;
        source.start(now);

        onProgress?.('playing', `播放: "${text.substring(0, 30)}..."`);

        return new Promise((resolve) => {
          source.onended = () => {
            console.log(`[Recorder] Segment ended: "${text.substring(0, 30)}..."`);
            resolve();
          };
          source.onerror = () => {
            console.warn(`[Recorder] Segment error: "${text.substring(0, 30)}..."`);
            resolve();
          };
        });
      } catch (err) {
        console.warn('[Recorder] Audio decode failed, using estimation:', err.message);
      }
    }

    // No audio or decode failed — use estimation
    const estDuration = engine._estimateDuration(text);
    onProgress?.('playing', `计时: "${text.substring(0, 30)}..."`);
    return new Promise(resolve => setTimeout(resolve, estDuration * 1000));
  };

  // Override _processNext to handle async speech
  engine._processNext = async function () {
    if (this.state !== 'playing') return;

    if (this.currentActionIndex >= this.actions.length) {
      this._handleSlideComplete();
      return;
    }

    const action = this.actions[this.currentActionIndex];
    this.currentActionIndex++;

    console.log(`[Recorder] Action ${this.currentActionIndex - 1}/${this.actions.length}: ${action.type}`);

    switch (action.type) {
      case 'speech':
        await this._executeSpeech(action);
        this._processNext();
        break;
      case 'spotlight':
        this._executeSpotlight(action);
        break;
      case 'clearSpotlight':
        this._executeClearSpotlight(action);
        break;
      case 'laser':
        this._executeLaser(action);
        break;
      case 'wait':
        await new Promise(r => setTimeout(r, (action.duration || 1) * 1000));
        this._processNext();
        break;
      default:
        this._processNext();
    }
  };

  // 5. Set up MP4 muxer
  onProgress?.('record', '开始录制 MP4 视频...');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: RECORD_W,
      height: RECORD_H,
    },
    audio: {
      codec: 'aac',
      numberOfChannels: 1,
      sampleRate: audioContext ? audioContext.sampleRate : 44100,
    },
    fastStart: 'in-memory',
  });

  // 6. Set up VideoEncoder (H.264)
  let frameCount = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error('[Recorder] VideoEncoder error:', e);
    },
  });

  const videoConfig = {
    codec: 'avc1.640028', // H.264 High Profile Level 4.0
    width: RECORD_W,
    height: RECORD_H,
    bitrate: VIDEO_BITRATE,
    framerate: FPS,
  };

  // Check if config is supported, fallback to baseline if needed
  let videoCodecSupported = false;
  try {
    const support = await VideoEncoder.isConfigSupported(videoConfig);
    videoCodecSupported = support.supported;
  } catch {
    videoCodecSupported = false;
  }

  if (!videoCodecSupported) {
    // Try baseline profile
    videoConfig.codec = 'avc1.42001E';
    try {
      const support = await VideoEncoder.isConfigSupported(videoConfig);
      videoCodecSupported = support.supported;
    } catch {
      videoCodecSupported = false;
    }
  }

  if (!videoCodecSupported) {
    throw new Error('H.264 encoding not supported on this browser');
  }

  videoEncoder.configure(videoConfig);

  // 7. Set up AudioEncoder (AAC)
  let audioEncoder = null;
  if (audioContext) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: (e) => {
        console.error('[Recorder] AudioEncoder error:', e);
      },
    });

    const audioConfig = {
      codec: 'mp4a.40.2', // AAC-LC
      numberOfChannels: 1,
      sampleRate: audioContext.sampleRate,
      bitrate: 128000,
    };

    try {
      const support = await AudioEncoder.isConfigSupported(audioConfig);
      if (support.supported) {
        audioEncoder.configure(audioConfig);
      } else {
        console.warn('[Recorder] AAC not supported, recording without audio');
        audioEncoder = null;
      }
    } catch {
      console.warn('[Recorder] AAC encoding not available, recording without audio');
      audioEncoder = null;
    }
  }

  // 8. Frame capture loop: use VideoFrame from canvas at regular intervals
  let recording = true;
  let audioSampleCount = 0;

  // Capture frames at 30fps using requestAnimationFrame (capped at 30fps)
  let lastFrameTime = 0;
  const frameInterval = 1000 / FPS;

  const captureLoop = () => {
    if (!recording) return;

    const now = performance.now();
    if (now - lastFrameTime >= frameInterval) {
      lastFrameTime = now - ((now - lastFrameTime) % frameInterval);

      try {
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(frameCount * (1_000_000 / FPS)), // microseconds
        });
        videoEncoder.encode(frame, { keyFrame: frameCount % (FPS * 2) === 0 }); // keyframe every 2 seconds
        frame.close();
        frameCount++;
      } catch (e) {
        console.warn('[Recorder] Frame capture error:', e.message);
      }
    }

    requestAnimationFrame(captureLoop);
  };

  requestAnimationFrame(captureLoop);

  // 9. Capture audio via ScriptProcessorNode → AudioEncoder
  let audioChunks = [];
  if (audioEncoder && scriptProcessor) {
    scriptProcessor.onaudioprocess = (e) => {
      if (!recording) return;
      const inputBuffer = e.inputBuffer.getChannelData(0);
      const audioData = new Float32Array(inputBuffer);

      try {
        const frame = new AudioData({
          format: 'f32-planar',
          sampleRate: audioContext.sampleRate,
          numberOfFrames: audioData.length,
          numberOfChannels: 1,
          timestamp: Math.round(audioSampleCount * (1_000_000 / audioContext.sampleRate)),
          data: audioData,
        });
        audioEncoder.encode(frame);
        audioSampleCount += audioData.length;
        frame.close();
      } catch (e) {
        // Silently drop audio frames on error (e.g., AudioEncoder is closed)
      }
    };
  }

  // 10. Start playback engine
  const startTime = Date.now();

  const engineFinished = new Promise((resolve) => {
    engine.onSlideComplete = () => {
      console.log('[Recorder] Engine slide complete');
      setTimeout(resolve, 300); // extra delay for last frames
    };
  });

  engine.play();
  await engineFinished;

  // 11. Stop recording: flush encoders and finalize muxer
  recording = false;

  console.log(`[Recorder] Captured ${frameCount} frames, flushing...`);

  // Flush video encoder
  await videoEncoder.flush();
  videoEncoder.close();

  // Flush audio encoder
  if (audioEncoder) {
    try {
      await audioEncoder.flush();
    } catch {
      console.warn('[Recorder] AudioEncoder flush had errors');
    }
    audioEncoder.close();
  }

  // Finalize muxer
  muxer.finalize();

  const duration = (Date.now() - startTime) / 1000;
  const mp4Blob = new Blob([target.buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(mp4Blob);

  // Cleanup
  engine.destroy();
  if (scriptProcessor) {
    scriptProcessor.disconnect();
  }
  if (audioStream) {
    audioStream.disconnect();
  }
  if (audioContext && !existingAudioCtx) {
    await audioContext.close().catch(() => {});
  }

  onProgress?.('done', '录制完成');
  console.log(`[Recorder] MP4 recording complete: ${formatFileSize(mp4Blob.size)}, ${frameCount} frames, ${duration.toFixed(1)}s`);
  return { blobUrl, duration, size: mp4Blob.size, format: 'mp4' };
}

/**
 * Record a single slide to video using MediaRecorder (WebM fallback).
 */
async function recordSlideToWebM(options) {
  const { parsedSlide, actions, onProgress } = options;

  onProgress?.('render', '渲染幻灯片到画布...');

  const { canvas, ctx } = createCanvas(RECORD_W, RECORD_H);

  const renderSlide = async (renderCtx) => {
    renderCtx.save();
    renderCtx.scale(2, 2);
    await renderSlideAsync(renderCtx, parsedSlide, { width: 960, height: 540 });
    renderCtx.restore();
  };

  const speechSegments = actions.filter(a => a.type === 'speech' && a.audioUrl);

  onProgress?.('audio', `准备 ${speechSegments.length} 段语音...`);

  let audioContext = null;
  let audioStream = null;

  if (speechSegments.length > 0) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioStream = audioContext.createMediaStreamDestination();
  }

  const engine = new PlaybackEngine({
    canvas,
    ctx,
    renderSlide,
    actions,
    slideData: parsedSlide,
    onStateChange: () => {},
    onScriptUpdate: () => {},
    onTimeUpdate: () => {},
    onSlideComplete: () => {},
  });

  // Override _executeSpeech
  const originalExecuteSpeech = engine._executeSpeech.bind(engine);
  engine._executeSpeech = async function (action) {
    const text = action.text || '';
    const audioUrl = action.audioUrl;
    this._charOffset += text.length;

    if (audioUrl && audioContext && audioStream) {
      try {
        const arrayBuffer = await blobUrlToArrayBuffer(audioUrl);
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioStream);
        source.connect(audioContext.destination);

        const now = audioContext.currentTime;
        source.start(now);

        onProgress?.('playing', `播放: "${text.substring(0, 30)}..."`);

        return new Promise((resolve) => {
          source.onended = () => {
            console.log(`[Recorder] Segment ended: "${text.substring(0, 30)}..."`);
            resolve();
          };
          source.onerror = () => {
            console.warn(`[Recorder] Segment error: "${text.substring(0, 30)}..."`);
            resolve();
          };
        });
      } catch (err) {
        console.warn('[Recorder] Audio decode failed, using estimation:', err.message);
      }
    }

    const estDuration = engine._estimateDuration(text);
    onProgress?.('playing', `计时: "${text.substring(0, 30)}..."`);
    return new Promise(resolve => setTimeout(resolve, estDuration * 1000));
  };

  // Override _processNext
  engine._processNext = async function () {
    if (this.state !== 'playing') return;

    if (this.currentActionIndex >= this.actions.length) {
      this._handleSlideComplete();
      return;
    }

    const action = this.actions[this.currentActionIndex];
    this.currentActionIndex++;

    console.log(`[Recorder] Action ${this.currentActionIndex - 1}/${this.actions.length}: ${action.type}`);

    switch (action.type) {
      case 'speech':
        await this._executeSpeech(action);
        this._processNext();
        break;
      case 'spotlight':
        this._executeSpotlight(action);
        break;
      case 'clearSpotlight':
        this._executeClearSpotlight(action);
        break;
      case 'laser':
        this._executeLaser(action);
        break;
      case 'wait':
        await new Promise(r => setTimeout(r, (action.duration || 1) * 1000));
        this._processNext();
        break;
      default:
        this._processNext();
    }
  };

  // MediaRecorder setup
  onProgress?.('record', '开始录制 WebM 视频...');

  const videoStream = canvas.captureStream(30);

  let combinedStream;
  if (audioStream) {
    combinedStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.stream.getAudioTracks(),
    ]);
  } else {
    combinedStream = videoStream;
  }

  const mimeType = getSupportedWebMMimeType();
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITRATE,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const startTime = Date.now();

  const recordingDone = new Promise((resolve, reject) => {
    recorder.onerror = (e) => reject(new Error(`MediaRecorder error: ${e.error?.message || 'unknown'}`));
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const blobUrl = URL.createObjectURL(blob);
      const duration = (Date.now() - startTime) / 1000;
      resolve({ blobUrl, duration, size: blob.size, format: 'webm' });
    };
  });

  const engineFinished = new Promise((resolve) => {
    engine.onSlideComplete = () => {
      console.log('[Recorder] Engine slide complete, stopping recorder');
      setTimeout(resolve, 200);
    };
  });

  recorder.start(100);
  engine.play();

  await engineFinished;

  if (recorder.state === 'recording') {
    recorder.stop();
  }

  const result = await recordingDone;

  engine.destroy();
  if (audioContext) {
    await audioContext.close().catch(() => {});
  }

  onProgress?.('done', '录制完成');
  console.log(`[Recorder] WebM recording complete: ${formatFileSize(result.size)}`);
  return result;
}

/**
 * Record a single slide to video (auto-select MP4 or WebM).
 *
 * @param {Object} options
 * @param {Object} options.parsedSlide - Full parsed slide data
 * @param {Array}  options.actions     - Action sequence
 * @param {Function} options.onProgress - (status, detail) for progress updates
 * @returns {Promise<{blobUrl: string, duration: number, size: number, format: string}>}
 */
export async function recordSlideToVideo(options) {
  if (isWebCodecsSupported()) {
    console.log('[Recorder] Using WebCodecs H.264 + AAC → MP4 pipeline');
    try {
      return await recordSlideToMP4(options);
    } catch (err) {
      console.warn('[Recorder] WebCodecs failed, falling back to MediaRecorder WebM:', err.message);
    }
  } else {
    console.log('[Recorder] WebCodecs not available, using MediaRecorder WebM');
  }

  return recordSlideToWebM(options);
}

/**
 * Record all slides to individual videos.
 *
 * @param {Object} options
 * @param {Array}  options.parsedSlides - All parsed slide data
 * @param {Array}  options.actionsData  - [[action, ...]] per slide
 * @param {Function} options.onProgress - (slideIndex, status, detail, total)
 * @returns {Promise<Array<{blobUrl: string, duration: number, size: number, format: string}>>}
 */
export async function recordAllSlides(options) {
  const { parsedSlides, actionsData, onProgress } = options;
  const results = [];

  for (let i = 0; i < parsedSlides.length; i++) {
    onProgress?.(i, 'recording', `正在录制第 ${i + 1} 页...`, parsedSlides.length);

    try {
      const result = await recordSlideToVideo({
        parsedSlide: parsedSlides[i],
        actions: actionsData[i] || [],
        onProgress: (status, detail) => {
          onProgress?.(i, status, detail, parsedSlides.length);
        },
      });
      results.push(result);
      const fmtLabel = result.format === 'mp4' ? 'MP4' : 'WebM';
      onProgress?.(i, 'done', `第 ${i + 1} 页完成 (${fmtLabel} ${formatFileSize(result.size)})`, parsedSlides.length);
    } catch (err) {
      console.error(`[Recorder] Slide ${i + 1} recording failed:`, err);
      results.push({ blobUrl: '', duration: 0, size: 0, format: 'error', error: err.message });
      onProgress?.(i, 'error', `第 ${i + 1} 页失败: ${err.message}`, parsedSlides.length);
    }
  }

  return results;
}

/**
 * Record a single slide with a silent fallback for speech estimation.
 */
export async function recordSingleSlide(options) {
  const { index, parsedSlide, actions, onProgress } = options;
  const finalActions = actions.length > 0 ? actions : [{ type: 'speech', text: '' }];
  return recordSlideToVideo({
    parsedSlide,
    actions: finalActions,
    onProgress,
  });
}

/**
 * Get the best supported MediaRecorder mimeType for WebM.
 */
function getSupportedWebMMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      console.log(`[Recorder] Using WebM codec: ${type}`);
      return type;
    }
  }
  console.warn('[Recorder] No WebM codec supported, using default');
  return '';
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Trigger download of a blob URL as a file.
 * @param {string} blobUrl
 * @param {string} filename
 * @param {string} [format='webm'] - 'mp4' or 'webm', used to determine extension
 */
export function downloadBlob(blobUrl, filename, format = 'webm') {
  const a = document.createElement('a');
  a.href = blobUrl;
  // Ensure correct file extension
  const ext = format === 'mp4' ? '.mp4' : '.webm';
  const finalName = filename.replace(/\.(webm|mp4)$/i, '') + ext;
  a.download = finalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Release all blob URLs to free memory.
 */
export function releaseBlobUrls(blobUrls) {
  for (const url of blobUrls) {
    if (url) URL.revokeObjectURL(url);
  }
}
