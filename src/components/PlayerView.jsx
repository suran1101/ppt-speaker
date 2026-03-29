import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createCanvas, renderSlideAsync } from '../utils/slideRenderer';
import { PlaybackEngine } from '../utils/playbackEngine';
import { recordAllSlides, downloadBlob, releaseBlobUrls } from '../utils/slideRecorder';
import '../App.css';

const STATES = { IDLE: 'idle', PLAYING: 'playing', PAUSED: 'paused', FINISHED: 'finished' };

const CANVAS_W = 960;
const CANVAS_H = 540;

export default function PlayerView({ slideData, scripts, actionsData, parsedSlides, ttsMode, onRegenerate }) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [playState, setPlayState] = useState(STATES.IDLE);
  const [displayedCharCount, setDisplayedCharCount] = useState(0);
  const [audioTime, setAudioTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Video recording state
  const [recording, setRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState({ current: 0, total: 0, status: '', detail: '' });
  const [videos, setVideos] = useState([]); // [{blobUrl, duration, size}] per slide
  const [showVideoPanel, setShowVideoPanel] = useState(false);
  const [previewVideoIndex, setPreviewVideoIndex] = useState(null);

  const containerRef = useRef(null);
  const engineRef = useRef(null);
  const slideChangeLockRef = useRef(false);
  const parsedSlidesRef = useRef(parsedSlides || []);
  const actionsDataRef = useRef(actionsData || []);
  const scriptsRef = useRef(scripts || []);
  const abortRecordRef = useRef(false);

  // Keep refs in sync with props
  useEffect(() => {
    actionsDataRef.current = actionsData || [];
    const totalActions = (actionsData || []).flat().length;
    const totalSpeech = (actionsData || []).flat().filter(a => a.type === 'speech').length;
    console.log(`[Player] actionsData: ${totalActions} actions (${totalSpeech} speech) across ${(actionsData || []).length} slides`);
  }, [actionsData]);

  useEffect(() => {
    scriptsRef.current = scripts || [];
  }, [scripts]);

  const currentScript = scripts[currentSlide];
  const currentParsedSlide = parsedSlidesRef.current[currentSlide];

  // Setup canvas and render slide
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !currentParsedSlide) return;

    const prevCanvas = container._canvas;
    if (prevCanvas && prevCanvas.parentNode === container) {
      container.removeChild(prevCanvas);
    }

    const { canvas: newCanvas, ctx } = createCanvas(CANVAS_W, CANVAS_H);
    container.appendChild(newCanvas);
    container._canvas = newCanvas;
    container._ctx = ctx;

    setIsLoading(true);
    renderSlideAsync(ctx, currentParsedSlide, { width: CANVAS_W, height: CANVAS_H })
      .then(() => setIsLoading(false))
      .catch((e) => {
        console.error('Slide render failed:', e);
        setIsLoading(false);
      });
  }, [currentSlide, currentParsedSlide]);

  // Create PlaybackEngine when slide changes or actionsData updates
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !currentParsedSlide || !currentScript) return;

    if (engineRef.current) {
      engineRef.current.destroy();
      engineRef.current = null;
    }

    const ctx = container._ctx;
    const canvas = container._canvas;
    if (!ctx || !canvas) return;

    const actions = actionsDataRef.current[currentSlide] || [];
    const speechCount = actions.filter(a => a.type === 'speech').length;
    const withAudio = actions.filter(a => a.type === 'speech' && a.audioUrl).length;
    console.log(`[Player] Slide ${currentSlide + 1}: ${actions.length} actions, ${speechCount} speech (${withAudio} with audio)`);

    const finalActions = actions.length > 0 ? actions :
      [{ type: 'speech', text: currentScript.script || '' }];

    const engine = new PlaybackEngine({
      canvas,
      ctx,
      renderSlide: async (renderCtx) => {
        await renderSlideAsync(renderCtx, currentParsedSlide, { width: CANVAS_W, height: CANVAS_H });
      },
      actions: finalActions,
      slideData: currentParsedSlide,
      onStateChange: (state) => setPlayState(state),
      onScriptUpdate: (charCount) => setDisplayedCharCount(charCount),
      onTimeUpdate: (time, duration) => setAudioTime(time),
      onSlideComplete: () => {},
    });

    engineRef.current = engine;

    return () => { engine.destroy(); };
  }, [currentSlide, currentParsedSlide, currentScript, actionsData]);

  // Auto-advance on slide complete
  useEffect(() => {
    if (playState !== STATES.FINISHED) {
      slideChangeLockRef.current = false;
      return;
    }
    if (slideChangeLockRef.current) return;
    slideChangeLockRef.current = true;

    const timer = setTimeout(() => {
      if (currentSlide < slideData.length - 1) {
        setCurrentSlide(prev => prev + 1);
        setTimeout(() => {
          if (engineRef.current) engineRef.current.play();
        }, 800);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [playState, currentSlide, slideData.length]);

  const handlePlayPause = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (playState === STATES.IDLE || playState === STATES.FINISHED) engine.play();
    else if (playState === STATES.PLAYING) engine.pause();
    else if (playState === STATES.PAUSED) engine.resume();
  }, [playState]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    slideChangeLockRef.current = false;
  }, []);

  const handlePrev = useCallback(() => {
    engineRef.current?.stop();
    slideChangeLockRef.current = false;
    setPlayState(STATES.IDLE);
    setCurrentSlide(i => Math.max(0, i - 1));
  }, []);

  const handleNext = useCallback(() => {
    engineRef.current?.stop();
    slideChangeLockRef.current = false;
    setPlayState(STATES.IDLE);
    setCurrentSlide(i => Math.min(slideData.length - 1, i + 1));
  }, [slideData.length]);

  const handleRestart = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.stop();
      setTimeout(() => engineRef.current?.play(), 50);
    }
  }, []);

  // Video recording
  const handleRecordAll = useCallback(async () => {
    if (recording) return;

    // Stop any current playback
    engineRef.current?.stop();
    setPlayState(STATES.IDLE);

    // Release old video URLs
    const oldUrls = videos.map(v => v.blobUrl).filter(Boolean);
    releaseBlobUrls(oldUrls);

    setRecording(true);
    abortRecordRef.current = false;
    setVideos([]);
    setShowVideoPanel(false);
    setPreviewVideoIndex(null);

    try {
      const results = await recordAllSlides({
        parsedSlides: parsedSlidesRef.current,
        actionsData: actionsDataRef.current,
        onProgress: (slideIdx, status, detail, total) => {
          setRecordingProgress({
            current: slideIdx + 1,
            total,
            status,
            detail,
          });
        },
      });

      setVideos(results);
      setShowVideoPanel(true);
      console.log(`[Player] Recording complete: ${results.length} videos`);
    } catch (err) {
      console.error('[Player] Recording failed:', err);
    } finally {
      setRecording(false);
      setRecordingProgress({ current: 0, total: 0, status: '', detail: '' });
    }
  }, [recording, videos]);

  const handleDownloadVideo = useCallback((index) => {
    const video = videos[index];
    if (!video?.blobUrl) return;
    const filename = `slide_${(index + 1).toString().padStart(2, '0')}`;
    downloadBlob(video.blobUrl, filename, video.format);
  }, [videos]);

  const handleDownloadAll = useCallback(() => {
    videos.forEach((video, i) => {
      if (video?.blobUrl) {
        const filename = `slide_${(i + 1).toString().padStart(2, '0')}`;
        setTimeout(() => downloadBlob(video.blobUrl, filename, video.format), i * 500);
      }
    });
  }, [videos]);

  // Cleanup video URLs on unmount
  useEffect(() => {
    return () => {
      const urls = videos.map(v => v.blobUrl).filter(Boolean);
      if (urls.length > 0) releaseBlobUrls(urls);
    };
  }, []);

  const fullScript = currentScript?.script || '';
  const displayedText = fullScript.substring(0, displayedCharCount);

  const formatTime = (sec) => {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes) => {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const videoCount = videos.filter(v => v.blobUrl).length;

  return (
    <div className="player-view">
      {/* Toolbar */}
      <div className="player-toolbar">
        <button className="btn btn-sm btn-secondary" onClick={onRegenerate}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          编辑演讲稿
        </button>
        <div className="player-toolbar-center">
          <span className="current">第 {currentSlide + 1} 页</span>
          <span style={{ margin: '0 4px', color: 'var(--border-color)' }}>/</span>
          <span>共 {slideData.length} 页</span>
          <span style={{ margin: '0 8px', color: 'var(--border-color)' }}>|</span>
          {ttsMode === 'qwen' && <span className="tts-badge">Qwen TTS</span>}
          {playState === STATES.PLAYING && (
            <span style={{ marginLeft: '8px', display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span className="wave-bar" style={{ height: '8px', animationDelay: '0s' }} />
              <span className="wave-bar" style={{ height: '14px', animationDelay: '0.1s' }} />
              <span className="wave-bar" style={{ height: '10px', animationDelay: '0.2s' }} />
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {/* Record All Videos button */}
          <button
            className="btn btn-sm"
            onClick={handleRecordAll}
            disabled={recording}
            style={{
              background: recording ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #e74c3c, #c0392b)',
              color: '#fff',
              border: 'none',
            }}
          >
            {recording ? (
              <>
                <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px' }} />
                录制中 {recordingProgress.current}/{recordingProgress.total}
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="7" />
                </svg>
                生成短视频
              </>
            )}
          </button>
          {/* Show Video Panel button */}
          {videoCount > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowVideoPanel(v => !v)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
              </svg>
              视频 ({videoCount})
            </button>
          )}
        </div>
      </div>

      {/* Recording Progress Overlay */}
      {recording && (
        <div style={{
          position: 'absolute', top: '64px', left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px',
            padding: '40px', borderRadius: '16px',
            background: 'var(--bg-card)', border: '1px solid var(--border-color)',
            maxWidth: '480px',
          }}>
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%',
              background: 'rgba(231, 76, 60, 0.15)', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="#e74c3c">
                <circle cx="12" cy="12" r="7" />
              </svg>
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
                正在录制第 {recordingProgress.current} / {recordingProgress.total} 页
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                {recordingProgress.detail || '准备中...'}
              </p>
            </div>
            <div className="gen-progress-bar" style={{ width: '100%', height: '6px' }}>
              <div
                className="gen-progress-fill"
                style={{
                  width: `${recordingProgress.total ? (recordingProgress.current / recordingProgress.total) * 100 : 0}%`,
                  background: 'linear-gradient(90deg, #e74c3c, #c0392b)',
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Video Panel */}
      {showVideoPanel && (
        <div className="video-panel">
          <div className="video-panel-header">
            <h3 style={{ fontSize: '15px', fontWeight: 600 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '8px', verticalAlign: 'middle' }}>
                <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
              </svg>
              短视频列表 ({videoCount}/{slideData.length})
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400, marginLeft: '8px' }}>
                {videos.some(v => v.format === 'mp4') ? '可直接发布到抖音/视频号' : 'WebM 格式，部分平台可能不兼容'}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: '8px' }}>
              {videoCount > 0 && (
                <button className="btn btn-sm btn-secondary" onClick={handleDownloadAll}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                  </svg>
                  全部下载
                </button>
              )}
              <button className="btn btn-sm btn-secondary" onClick={() => setShowVideoPanel(false)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="video-panel-list">
            {videos.map((video, i) => (
              <div key={i} className="video-panel-item">
                <div className="video-item-left">
                  <div className="video-item-thumb">
                    {video.blobUrl ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--accent-primary)">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    ) : (
                      <span style={{ fontSize: '11px', color: 'var(--error)' }}>失败</span>
                    )}
                  </div>
                  <div className="video-item-info">
                    <span className="video-item-title">第 {i + 1} 页</span>
                    <span className="video-item-meta">
                      {video.blobUrl
                        ? `${formatTime(video.duration)} · ${formatFileSize(video.size)}${video.format === 'mp4' ? ' · MP4' : video.format === 'webm' ? ' · WebM' : ''}`
                        : video.error || '录制失败'}
                    </span>
                  </div>
                </div>
                <div className="video-item-actions">
                  {video.blobUrl && (
                    <>
                      <button
                        className="btn-icon"
                        title="预览"
                        onClick={() => setPreviewVideoIndex(previewVideoIndex === i ? null : i)}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                      <button className="btn-icon" title="下载" onClick={() => handleDownloadVideo(i)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Video Preview */}
          {previewVideoIndex !== null && videos[previewVideoIndex]?.blobUrl && (
            <div className="video-preview-overlay" onClick={() => setPreviewVideoIndex(null)}>
              <div className="video-preview-container" onClick={(e) => e.stopPropagation()}>
                <video
                  src={videos[previewVideoIndex].blobUrl}
                  controls
                  autoPlay
                  style={{ width: '100%', borderRadius: '8px' }}
                />
                <p style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>
                  第 {previewVideoIndex + 1} 页 · {formatTime(videos[previewVideoIndex].duration)}
                  {videos[previewVideoIndex].format === 'mp4' ? ' · MP4 H.264' : videos[previewVideoIndex].format === 'webm' ? ' · WebM' : ''}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage */}
      <div className="player-stage" ref={containerRef}>
        {isLoading && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)', zIndex: 10,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
          }}>
            <div className="spinner" style={{ width: '32px', height: '32px' }} />
            <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>渲染幻灯片...</span>
          </div>
        )}

        <div className="player-script-area">
          <div className="player-script-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            演讲稿
          </div>
          <div className="player-script-body">
            {displayedText || fullScript || '点击播放按钮开始演讲...'}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="player-controls">
        <button className="player-btn" onClick={handlePrev} title="上一页" disabled={currentSlide === 0}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
          </svg>
        </button>

        <div className="player-progress-wrap">
          <span className="player-progress-time">
            {formatTime(audioTime)}
          </span>
          <div className="player-progress-bar">
            <div className="player-progress-fill" style={{ opacity: 0.5 }} />
          </div>
        </div>

        <button className="player-btn" onClick={handleStop} title="停止" disabled={playState === STATES.IDLE}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
          </svg>
        </button>

        <button className="player-btn play-btn" onClick={handlePlayPause} title={
          playState === STATES.PLAYING ? '暂停' :
          playState === STATES.PAUSED ? '继续' : '播放'
        }>
          {playState === STATES.PLAYING ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          )}
        </button>

        <button className="player-btn" onClick={handleRestart} title="重播">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
        </button>

        <button className="player-btn" onClick={handleNext} title="下一页" disabled={currentSlide === slideData.length - 1}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 18h2V6h-2z"/>
            <path d="M6 18l8.5-6L6 6z"/>
          </svg>
        </button>
      </div>

      <style>{`
        .player-stage canvas {
          width: 100% !important;
          height: auto !important;
          display: block;
          aspect-ratio: 16/9;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          border: 1px solid var(--border-color);
        }
        .wave-bar {
          width: 3px;
          background: var(--accent-primary);
          border-radius: 1px;
          animation: pulse 0.5s infinite;
          display: inline-block;
        }
        .tts-badge {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
          background: rgba(74, 222, 128, 0.15);
          color: var(--success);
          font-weight: 600;
        }
        .video-panel {
          position: absolute;
          top: 64px;
          right: 0;
          bottom: 0;
          width: 320px;
          background: var(--bg-secondary);
          border-left: 1px solid var(--border-color);
          z-index: 150;
          display: flex;
          flex-direction: column;
          box-shadow: -4px 0 24px rgba(0,0,0,0.3);
        }
        .video-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          border-bottom: 1px solid var(--border-color);
          flex-shrink: 0;
        }
        .video-panel-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }
        .video-panel-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-radius: var(--radius-sm);
          transition: var(--transition);
          margin-bottom: 4px;
        }
        .video-panel-item:hover {
          background: var(--bg-hover);
        }
        .video-item-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .video-item-thumb {
          width: 40px;
          height: 40px;
          border-radius: 6px;
          background: var(--bg-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .video-item-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .video-item-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .video-item-meta {
          font-size: 11px;
          color: var(--text-muted);
        }
        .video-item-actions {
          display: flex;
          gap: 4px;
        }
        .video-preview-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.8);
          z-index: 300;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 40px;
        }
        .video-preview-container {
          max-width: 960px;
          width: 100%;
        }
      `}</style>
    </div>
  );
}
