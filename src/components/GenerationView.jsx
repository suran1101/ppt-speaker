import React, { useState, useEffect, useCallback, useRef } from 'react';
import { generateScript, generateActions } from '../utils/scriptGenerator';
import { generateAudioBlobUrl, detectTtsMode } from '../utils/ttsEngine';
import '../App.css';

const STATUS = { PENDING: 'pending', GENERATING: 'generating', DONE: 'done' };

export default function GenerationView({ slideData, onComplete, onBack }) {
  const [slideStatuses, setSlideStatuses] = useState(() =>
    slideData.map(() => STATUS.PENDING)
  );
  const [scripts, setScripts] = useState(() =>
    slideData.map((s) => ({ title: s.title, content: s.content, script: '', duration: 0 }))
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState('scripts'); // 'scripts' | 'actions' | 'tts' | 'done'
  const [ttsProgress, setTtsProgress] = useState({ current: 0, total: 0, status: '' });
  const allActionsRef = useRef([]);
  const abortRef = useRef(false);

  // Step 1: Generate scripts (full speech per slide)
  const generateForSlide = useCallback(async (index) => {
    setSlideStatuses(prev => {
      const next = [...prev];
      next[index] = STATUS.GENERATING;
      return next;
    });

    try {
      const slide = slideData[index];
      const scriptText = await generateScript(slide.title, slide.content, index, slideData.length);
      if (!scriptText || !scriptText.trim()) throw new Error('Empty script');

      const charCount = scriptText.replace(/\s/g, '').length;
      const duration = Math.ceil(charCount / 4);

      setScripts(prev => {
        const next = [...prev];
        next[index] = { title: slide.title, content: slide.content, script: scriptText, duration };
        return next;
      });
      setSlideStatuses(prev => {
        const next = [...prev];
        next[index] = STATUS.DONE;
        return next;
      });
    } catch (err) {
      console.error('Script generation failed for slide', index, err);
      setSlideStatuses(prev => {
        const next = [...prev];
        next[index] = STATUS.PENDING;
        return next;
      });
    }
  }, [slideData]);

  // Auto-generate all scripts on mount
  useEffect(() => {
    abortRef.current = false;
    const run = async () => {
      for (let i = 0; i < slideData.length; i++) {
        if (abortRef.current) return;
        setCurrentIndex(i);
        await generateForSlide(i);
        if (i < slideData.length - 1) await new Promise(r => setTimeout(r, 150));
      }
      if (!abortRef.current) setPhase('actions');
    };
    run();
    return () => { abortRef.current = true; };
  }, [slideData, generateForSlide]);

  // Step 2: Generate action sequences (LLM splits into speech segments + spotlights)
  useEffect(() => {
    if (phase !== 'actions') return;
    abortRef.current = false;
    allActionsRef.current = [];

    const run = async () => {
      for (let i = 0; i < slideData.length; i++) {
        if (abortRef.current) return;
        setCurrentIndex(i);
        try {
          const actions = await generateActions(
            scripts[i].script,
            slideData[i].shapes || [],
            i,
            slideData.length,
          );
          const speechCount = actions.filter(a => a.type === 'speech').length;
          const spotCount = actions.filter(a => a.type === 'spotlight').length;
          console.log(`[GenView] Slide ${i + 1}: ${actions.length} actions (${speechCount} speech, ${spotCount} spotlights)`);
          allActionsRef.current.push(actions);
        } catch (err) {
          console.warn(`[GenView] Slide ${i + 1} actions failed:`, err.message);
          // Fallback: single speech action with full script
          allActionsRef.current.push([{ type: 'speech', text: scripts[i].script }]);
        }
      }

      if (!abortRef.current) {
        const totalSpeech = allActionsRef.current.flat().filter(a => a.type === 'speech').length;
        const totalSpot = allActionsRef.current.flat().filter(a => a.type === 'spotlight').length;
        console.log(`[GenView] Actions complete: ${totalSpeech} speech segments, ${totalSpot} spotlights across ${slideData.length} slides`);
        setPhase('tts');
      }
    };

    run();
    return () => { abortRef.current = true; };
  }, [phase]);

  // Step 3: Generate TTS audio for each speech segment in each slide's action sequence
  useEffect(() => {
    if (phase !== 'tts') return;
    abortRef.current = false;

    const run = async () => {
      const mode = await detectTtsMode();
      const actionsWithAudio = [...allActionsRef.current]; // deep copy

      // Count total speech segments across all slides
      const allSpeechSegments = [];
      actionsWithAudio.forEach((slideActions, slideIdx) => {
        slideActions.forEach((action, actionIdx) => {
          if (action.type === 'speech') {
            allSpeechSegments.push({ slideIdx, actionIdx, text: action.text });
          }
        });
      });

      const totalSegments = allSpeechSegments.length;
      console.log(`[GenView] Generating TTS for ${totalSegments} speech segments, mode=${mode}`);

      if (mode === 'qwen') {
        // Generate audio for each speech segment
        for (let i = 0; i < allSpeechSegments.length; i++) {
          if (abortRef.current) return;
          const seg = allSpeechSegments[i];
          setCurrentIndex(seg.slideIdx);
          setTtsProgress({ current: i + 1, total: totalSegments, status: 'generating' });

          try {
            const audioUrl = await generateAudioBlobUrl(seg.text);
            actionsWithAudio[seg.slideIdx][seg.actionIdx].audioUrl = audioUrl;
            console.log(`[GenView] TTS: slide ${seg.slideIdx + 1} segment ${seg.actionIdx} → ${(seg.text || '').substring(0, 30)}...`);
          } catch (err) {
            console.warn(`[GenView] TTS failed for slide ${seg.slideIdx + 1} segment ${seg.actionIdx}:`, err.message);
            actionsWithAudio[seg.slideIdx][seg.actionIdx].audioUrl = '';
          }
        }
      }

      setTtsProgress({ current: totalSegments, total: totalSegments, status: 'done' });

      if (!abortRef.current) {
        console.log(`[GenView] All done. Passing to player: ${actionsWithAudio.length} slide action sequences`);
        onComplete(scripts, actionsWithAudio, mode);
      }
    };

    run();
    return () => { abortRef.current = true; };
  }, [phase]);

  const handleRegenerate = useCallback(async (index) => {
    await generateForSlide(index);
  }, [generateForSlide]);

  const handleScriptEdit = useCallback((index, newScript) => {
    const charCount = newScript.replace(/\s/g, '').length;
    setScripts(prev => {
      const next = [...prev];
      next[index] = { ...next[index], script: newScript, duration: Math.ceil(charCount / 4) };
      return next;
    });
  }, []);

  const doneCount = slideStatuses.filter(s => s === STATUS.DONE).length;

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="generation-view">
      {/* Toolbar */}
      <div className="gen-toolbar">
        <div className="gen-toolbar-left">
          <button className="btn btn-sm btn-secondary" onClick={onBack}>
            ← 返回
          </button>
          <span className="gen-slide-count">
            共 <span>{slideData.length}</span> 页幻灯片
          </span>
        </div>
        <div className="gen-actions">
          {phase === 'scripts' && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Step 1/3: 生成演讲稿
            </span>
          )}
          {phase === 'actions' && (
            <span style={{ fontSize: '13px', color: 'var(--warning)' }}>
              Step 2/3: 编排动作序列 ({currentIndex + 1}/{slideData.length})
            </span>
          )}
          {phase === 'tts' && (
            <span style={{ fontSize: '13px', color: 'var(--warning)' }}>
              Step 3/3: 语音合成 ({ttsProgress.current}/{ttsProgress.total})
            </span>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="gen-progress">
        <div className="gen-progress-bar">
          {phase === 'scripts' ? (
            <div
              className="gen-progress-fill"
              style={{ width: `${(doneCount / slideData.length) * 33}%` }}
            />
          ) : phase === 'actions' ? (
            <>
              <div className="gen-progress-fill" style={{ width: '33%', background: 'var(--success)' }} />
              <div
                className="gen-progress-fill"
                style={{ width: `${slideData.length ? ((currentIndex + 1) / slideData.length) * 33 : 0}%` }}
              />
            </>
          ) : (
            <>
              <div className="gen-progress-fill" style={{ width: '33%', background: 'var(--success)' }} />
              <div className="gen-progress-fill" style={{ width: '33%', background: 'var(--success)' }} />
              <div
                className="gen-progress-fill"
                style={{ width: `${ttsProgress.total ? (ttsProgress.current / ttsProgress.total) * 34 : 0}%` }}
              />
            </>
          )}
        </div>
        <div className="gen-progress-text">
          {phase === 'scripts' && (
            <>
              <span>演讲稿生成: {doneCount} / {slideData.length}</span>
              <span>{doneCount === slideData.length ? '演讲稿完成，正在编排动作...' : '正在生成中...'}</span>
            </>
          )}
          {phase === 'actions' && (
            <>
              <span>动作编排: {currentIndex + 1} / {slideData.length}</span>
              <span>AI 正在拆分演讲段落并匹配聚光灯...</span>
            </>
          )}
          {phase === 'tts' && (
            <>
              <span>语音合成: {ttsProgress.current} / {ttsProgress.total} 段</span>
              <span>Qwen TTS 逐段合成中...</span>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="gen-content">
        {/* Slide List */}
        <div className="gen-slides-panel">
          {slideData.map((slide, i) => (
            <div
              key={i}
              className={`gen-slide-thumb ${i === currentIndex ? 'active' : ''}`}
              onClick={() => setCurrentIndex(i)}
            >
              <div className="gen-slide-thumb-num">{i + 1}</div>
              <span className="gen-slide-thumb-title">
                {slide.title || `幻灯片 ${i + 1}`}
              </span>
              <div className={`status-dot ${phase === 'tts' && i < ttsProgress.current ? 'done' : slideStatuses[i]}`} />
            </div>
          ))}
        </div>

        {/* Main Panel */}
        <div className="gen-main-panel">
          <div className="gen-slide-preview">
            {phase === 'tts' ? (
              <div className="gen-slide-card fade-in">
                <div className="gen-slide-header">
                  <h3>
                    正在合成语音
                    <span className="badge" style={{ background: 'var(--warning)' }}>TTS</span>
                  </h3>
                </div>
                <div className="gen-slide-body" style={{ padding: '48px 24px', textAlign: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                    <div className="spinner" style={{ width: '40px', height: '40px', borderWidth: '3px' }} />
                    <div>
                      <p style={{ fontSize: '16px', color: 'var(--text-primary)', marginBottom: '8px' }}>
                        正在合成第 {ttsProgress.current} / {ttsProgress.total} 段语音
                      </p>
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        每段演讲独立合成，确保语音与聚光灯精确同步
                      </p>
                    </div>
                    <div className="gen-progress-bar" style={{ width: '300px' }}>
                      <div
                        className="gen-progress-fill"
                        style={{ width: `${ttsProgress.total ? (ttsProgress.current / ttsProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : slideData[currentIndex] ? (
              <div className="gen-slide-card fade-in" key={currentIndex}>
                <div className="gen-slide-header">
                  <h3>
                    第 {currentIndex + 1} 页
                    <span className="badge">
                      {slideStatuses[currentIndex] === STATUS.DONE
                        ? '已生成'
                        : slideStatuses[currentIndex] === STATUS.GENERATING
                          ? '生成中...'
                          : '等待中'}
                    </span>
                  </h3>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                    ~{formatTime(scripts[currentIndex]?.duration || 0)}
                  </span>
                </div>

                <div className="gen-slide-body">
                  <div className="gen-slide-content-preview">
                    <div className="gen-preview-box">
                      <h4>幻灯片标题</h4>
                      <div className="content-text">
                        {slideData[currentIndex].title || '（无标题）'}
                      </div>
                    </div>
                    <div className="gen-preview-box">
                      <h4>幻灯片内容</h4>
                      <div className="content-text">
                        {slideData[currentIndex].content || '（无文本内容）'}
                      </div>
                    </div>
                    <div className="gen-preview-box gen-script-box">
                      <h4>演讲稿</h4>
                      {slideStatuses[currentIndex] === STATUS.GENERATING ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 0' }}>
                          <div className="spinner" />
                          <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                            正在生成演讲稿...
                          </span>
                        </div>
                      ) : (
                        <textarea
                          className="gen-script-textarea"
                          value={scripts[currentIndex]?.script || ''}
                          onChange={(e) => handleScriptEdit(currentIndex, e.target.value)}
                          placeholder="演讲稿将在此处显示，您也可以手动编辑..."
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="gen-slide-actions">
                  <div className="gen-slide-actions-left">
                    {scripts[currentIndex]?.script
                      ? `${scripts[currentIndex].script.length} 字 · 约 ${formatTime(scripts[currentIndex].duration)}`
                      : '暂无演讲稿'}
                  </div>
                  <div className="gen-slide-actions-right">
                    <button
                      className="btn btn-sm btn-secondary"
                      disabled={phase === 'tts'}
                      onClick={() => handleRegenerate(currentIndex)}
                    >
                      重新生成
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Navigation */}
          <div className="gen-nav">
            <button
              className="btn btn-sm btn-secondary"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex(i => i - 1)}
            >
              ← 上一页
            </button>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {currentIndex + 1} / {slideData.length}
            </span>
            <button
              className="btn btn-sm btn-secondary"
              disabled={currentIndex === slideData.length - 1}
              onClick={() => setCurrentIndex(i => i + 1)}
            >
              下一页 →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
