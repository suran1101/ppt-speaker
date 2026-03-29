/**
 * PlaybackEngine — Event-chain driven playback coordinator
 * 
 * Inspired by OpenMAIC's PlaybackEngine.processNext() architecture.
 * 
 * Each slide has ONE ordered action sequence, e.g.:
 *   [spotlight(id:3), speech("第一段...", audioUrl: "..."), clearSpotlight,
 *    spotlight(id:5), speech("第二段...", audioUrl: "..."), clearSpotlight,
 *    speech("结尾...", audioUrl: "...")]
 * 
 * Core rule:
 *   - "speech" is the ONLY blocking action. It plays its own audio clip,
 *     and _processNext() is only called when that clip's 'ended' event fires.
 *   - "spotlight" / "clearSpotlight" / "laser" are fire-and-forget:
 *     trigger the visual effect immediately, then _processNext() continues.
 *   - The ORDER of actions in the array determines synchronization.
 *     Spotlight before speech → visible while speech audio plays.
 *     clearSpotlight after speech → cleared when speech audio ends.
 */

import { drawSpotlight, drawLaser } from './slideRenderer.js';

export class PlaybackEngine {
  constructor(options = {}) {
    this.canvas = options.canvas;
    this.ctx = options.ctx;
    this.renderSlide = options.renderSlide;
    this.actions = options.actions || [];    // Array of actions for this slide
    this.slideData = options.slideData || {};
    
    // State
    this.state = 'idle';           // idle | playing | paused | finished
    this.currentActionIndex = 0;
    this._destroyed = false;
    
    // Audio — managed per-speech-action (no single shared audio)
    this._currentAudio = null;
    this._audioPlaying = false;
    
    // Overlay state
    this.spotlightShapeId = null;
    this.laserPos = null;
    this.laserOpacity = 1;
    
    // Script tracking — accumulate char positions across speech segments
    this._fullScript = '';
    this._charOffset = 0;   // cumulative char offset for current speech segment
    for (const a of this.actions) {
      if (a.type === 'speech' && a.text) {
        this._fullScript += a.text;
      }
    }
    
    // Timing tracking — for progress bar (sum of all segment durations)
    this._segmentDurations = [];   // will be filled as we play each speech
    this._totalElapsed = 0;
    this._segmentStartTime = 0;
    
    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onScriptUpdate = options.onScriptUpdate || (() => {});
    this.onTimeUpdate = options.onTimeUpdate || (() => {});
    this.onSlideComplete = options.onSlideComplete || (() => {});
  }
  
  /**
   * Start playback from beginning
   */
  async play() {
    if (this.state === 'playing') return;
    if (this._destroyed) return;
    
    this.state = 'playing';
    this.currentActionIndex = 0;
    this.spotlightShapeId = null;
    this.laserPos = null;
    this.laserOpacity = 1;
    this._audioPlaying = false;
    this._charOffset = 0;
    this._totalElapsed = 0;
    this._segmentDurations = [];
    
    this.onStateChange('playing');
    this.onScriptUpdate(0);
    this.onTimeUpdate(0, 0);
    
    // Render base slide
    await this._renderBaseSlide();
    
    // Start the action chain
    this._processNext();
  }
  
  /**
   * Pause playback
   */
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.onStateChange('paused');
    
    if (this._currentAudio) {
      this._currentAudio.pause();
    }
  }
  
  /**
   * Resume from pause
   */
  async resume() {
    if (this.state !== 'paused') return;
    if (this._destroyed) return;
    
    this.state = 'playing';
    this.onStateChange('playing');
    
    // Resume current audio if any
    if (this._currentAudio && this._audioPlaying) {
      try {
        await this._currentAudio.play();
      } catch (e) {
        console.warn('[Engine] Audio resume failed:', e);
        // If audio can't resume, just continue the chain
        this._processNext();
      }
    } else {
      // No audio was playing when paused (e.g. between segments)
      // Re-enter the action chain
      this._processNext();
    }
  }
  
  /**
   * Stop playback and reset
   */
  stop() {
    this.state = 'idle';
    this.currentActionIndex = 0;
    this._cleanupAudio();
    this._clearAllEffects();
    
    this.onStateChange('idle');
    this.onScriptUpdate(0);
    this.onTimeUpdate(0, 0);
    
    this._renderBaseSlide();
  }
  
  /**
   * Cleanup current audio element
   */
  _cleanupAudio() {
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.removeAttribute('src');
      this._currentAudio.load(); // release resources
      this._currentAudio = null;
    }
    this._audioPlaying = false;
  }
  
  /**
   * Clear all visual effects
   */
  _clearAllEffects() {
    this.spotlightShapeId = null;
    this.laserPos = null;
    this.laserOpacity = 1;
    this._renderFrame();
  }
  
  /**
   * Core action processing loop — event-chain architecture
   * 
   * Each call processes ONE action:
   * - spotlight/clearSpotlight/laser: fire-and-forget (trigger + recurse)
   * - speech: blocking (play audio, wait for 'ended' event to recurse)
   * - wait: blocking with fixed duration
   */
  _processNext() {
    if (this.state !== 'playing') return;
    
    // All actions consumed → slide complete
    if (this.currentActionIndex >= this.actions.length) {
      this._handleSlideComplete();
      return;
    }
    
    const action = this.actions[this.currentActionIndex];
    this.currentActionIndex++;
    
    console.log(`[Engine] Action ${this.currentActionIndex - 1}/${this.actions.length}: ${action.type}` +
      (action.type === 'spotlight' ? ` shapeId=${action.shapeId}` : '') +
      (action.type === 'speech' ? ` "${(action.text || '').substring(0, 40)}..."` : ''));
    
    switch (action.type) {
      case 'speech':
        this._executeSpeech(action);
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
        this._executeWait(action);
        break;
      default:
        this._processNext();
    }
  }
  
  /**
   * Execute speech — the ONLY blocking action
   * 
   * Each speech action carries its own audioUrl (generated per-segment).
   * When audio ends, the 'ended' event triggers _processNext() to continue.
   * Without audio, estimate duration from text length.
   */
  _executeSpeech(action) {
    const text = action.text || '';
    const audioUrl = action.audioUrl;
    const prevCharOffset = this._charOffset;
    this._charOffset += text.length;
    
    if (audioUrl) {
      // Play segment audio
      this._cleanupAudio();
      
      const audio = new Audio(audioUrl);
      audio.preload = 'auto';
      this._currentAudio = audio;
      this._audioPlaying = true;
      this._segmentStartTime = Date.now();
      
      audio.addEventListener('ended', () => {
        const segDuration = (Date.now() - this._segmentStartTime) / 1000;
        this._segmentDurations.push(segDuration);
        this._totalElapsed += segDuration;
        this._audioPlaying = false;
        console.log(`[Engine] Segment audio ended (${segDuration.toFixed(1)}s), continuing chain`);
        this._processNext();
      }, { once: true });
      
      // Time update for progress bar
      audio.addEventListener('timeupdate', () => {
        if (this.state !== 'playing') return;
        const time = audio.currentTime;
        const dur = audio.duration || 1;
        const totalTime = this._totalElapsed + time;
        this.onTimeUpdate(totalTime, 0); // 0 = unknown total
      });
      
      audio.play().catch(e => {
        console.warn('[Engine] Audio play failed, using text estimation:', e.message);
        this._audioPlaying = false;
        this._playWithEstimation(action, prevCharOffset);
      });
      
      // Script highlight tracking for audio playback
      const startHighlightTick = () => {
        if (!audio.duration || isNaN(audio.duration)) return;
        const dur = audio.duration;
        const tickInterval = setInterval(() => {
          if (this.state !== 'playing' || !this._audioPlaying) {
            clearInterval(tickInterval);
            return;
          }
          const progress = Math.min(1, audio.currentTime / dur);
          const charCount = prevCharOffset + Math.floor(progress * text.length);
          this.onScriptUpdate(charCount);
        }, 150);
        
        audio.addEventListener('ended', () => clearInterval(tickInterval), { once: true });
        audio.addEventListener('pause', () => clearInterval(tickInterval));
      };
      
      // Wait for metadata if needed
      if (audio.duration && !isNaN(audio.duration)) {
        startHighlightTick();
      } else {
        audio.addEventListener('loadedmetadata', () => startHighlightTick(), { once: true });
      }
      
    } else {
      // No audio for this segment — use text length estimation
      this._playWithEstimation(action, prevCharOffset);
    }
  }
  
  /**
   * Play a speech segment using estimated duration (no audio fallback)
   */
  _playWithEstimation(action, prevCharOffset) {
    const text = action.text || '';
    const estDuration = this._estimateDuration(text);
    
    this._segmentStartTime = Date.now();
    
    const tickInterval = setInterval(() => {
      if (this.state !== 'playing') {
        clearInterval(tickInterval);
        return;
      }
      const elapsed = (Date.now() - this._segmentStartTime) / 1000;
      this.onTimeUpdate(this._totalElapsed + elapsed, 0);
      
      // Update script highlight position
      const progress = estDuration > 0 ? Math.min(1, elapsed / estDuration) : 0;
      const charCount = prevCharOffset + Math.floor(progress * text.length);
      this.onScriptUpdate(charCount);
    }, 150);
    
    setTimeout(() => {
      clearInterval(tickInterval);
      const actualDuration = (Date.now() - this._segmentStartTime) / 1000;
      this._segmentDurations.push(actualDuration);
      this._totalElapsed += actualDuration;
      this.onScriptUpdate(this._charOffset);
      this._processNext();
    }, estDuration * 1000);
  }
  
  /**
   * Execute spotlight — fire-and-forget
   */
  _executeSpotlight(action) {
    this.spotlightShapeId = action.shapeId;
    this._renderFrame();
    this._processNext();
  }
  
  /**
   * Clear spotlight — fire-and-forget
   */
  _executeClearSpotlight() {
    this.spotlightShapeId = null;
    this._renderFrame();
    this._processNext();
  }
  
  /**
   * Execute laser — fire-and-forget with fade animation
   */
  _executeLaser(action) {
    this.laserPos = { x: action.x, y: action.y };
    this.laserOpacity = 1;
    this._renderFrame();
    
    const fadeStart = Date.now();
    const fadeDuration = (action.duration || 2) * 1000;
    const fade = () => {
      if (this.state !== 'playing' || !this.laserPos) return;
      const elapsed = Date.now() - fadeStart;
      this.laserOpacity = Math.max(0, 1 - elapsed / fadeDuration);
      this._renderFrame();
      if (this.laserOpacity > 0) {
        requestAnimationFrame(fade);
      } else {
        this.laserPos = null;
        this._renderFrame();
      }
    };
    requestAnimationFrame(fade);
    
    this._processNext();
  }
  
  /**
   * Execute wait — blocking
   */
  _executeWait(action) {
    setTimeout(() => this._processNext(), (action.duration || 1) * 1000);
  }
  
  /**
   * Estimate speech duration in seconds
   */
  _estimateDuration(text) {
    if (!text) return 2;
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const eng = (text.match(/[a-zA-Z]+/g) || []).length;
    return Math.max(2, cjk / 4 + eng / 3);
  }
  
  async _renderBaseSlide() {
    if (this.ctx && this.renderSlide) {
      try { await this.renderSlide(this.ctx); } catch (e) {
        console.warn('[Engine] Slide render failed:', e);
      }
    }
  }
  
  async _renderFrame() {
    if (!this.ctx) return;
    await this._renderBaseSlide();
    
    if (this.spotlightShapeId && this.slideData.shapes) {
      drawSpotlight(this.ctx, this.spotlightShapeId, this.slideData, {
        width: 960, height: 540,
      });
    }
    
    if (this.laserPos) {
      this.ctx.save();
      this.ctx.globalAlpha = this.laserOpacity;
      drawLaser(this.ctx, this.laserPos.x, this.laserPos.y);
      this.ctx.restore();
    }
  }
  
  _handleSlideComplete() {
    if (this.state !== 'playing') return;
    
    this.state = 'finished';
    this._cleanupAudio();
    this._clearAllEffects();
    
    // Show full script
    this.onScriptUpdate(this._fullScript.length);
    
    this.onStateChange('finished');
    this.onSlideComplete();
    console.log('[Engine] Slide complete');
  }
  
  destroy() {
    this._destroyed = true;
    this._cleanupAudio();
  }
}
