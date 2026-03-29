import React, { useState } from 'react';
import UploadView from './components/UploadView';
import GenerationView from './components/GenerationView';
import PlayerView from './components/PlayerView';

export default function App() {
  const [currentView, setCurrentView] = useState('upload');
  const [slideData, setSlideData] = useState([]);
  const [parsedSlides, setParsedSlides] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [ttsMode, setTtsMode] = useState('');
  const [actionsData, setActionsData] = useState([]);

  const handleSlidesExtracted = (slides, parsed) => {
    setSlideData(slides);
    setParsedSlides(parsed);
    setCurrentView('generate');
  };

  /**
   * Generation complete callback
   * @param {Array} generatedScripts - [{script: string}] per slide
   * @param {Array} generatedActions - [[action, ...]] per slide (each speech has audioUrl)
   * @param {string} mode - 'qwen' | 'browser' | 'timer'
   */
  const handleGenerationComplete = (generatedScripts, generatedActions, mode) => {
    setScripts(generatedScripts);
    setTtsMode(mode || '');
    setActionsData(generatedActions || []);

    const totalActions = (generatedActions || []).flat().length;
    const totalSpeech = (generatedActions || []).flat().filter(a => a.type === 'speech').length;
    const withAudio = (generatedActions || []).flat().filter(a => a.type === 'speech' && a.audioUrl).length;
    console.log(`[App] Generation complete: ${generatedScripts.length} slides, ${totalSpeech} speech segments (${withAudio} with audio), ${totalActions} total actions, mode=${mode}`);

    setCurrentView('player');
  };

  const handleBackToUpload = () => {
    setCurrentView('upload');
    setSlideData([]);
    setParsedSlides([]);
    setScripts([]);
    setTtsMode('');
    setActionsData([]);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left" onClick={handleBackToUpload} style={{ cursor: 'pointer' }}>
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            <span className="logo-text">PPT Speaker</span>
          </div>
        </div>
        <div className="header-center">
          <div className="step-indicator">
            <div className={`step ${currentView === 'upload' ? 'active' : currentView !== 'upload' ? 'done' : ''}`}>
              <span className="step-num">{currentView === 'upload' ? '1' : '✓'}</span>
              <span className="step-label">上传PPT</span>
            </div>
            <div className="step-line" />
            <div className={`step ${currentView === 'generate' ? 'active' : currentView !== 'generate' && currentView !== 'upload' ? 'done' : ''}`}>
              <span className="step-num">{currentView === 'generate' ? '2' : (currentView !== 'upload' ? '✓' : '2')}</span>
              <span className="step-label">生成演讲</span>
            </div>
            <div className="step-line" />
            <div className={`step ${currentView === 'player' ? 'active' : ''}`}>
              <span className="step-num">3</span>
              <span className="step-label">播放导出</span>
            </div>
          </div>
        </div>
        <div className="header-right" />
      </header>

      <main className="app-main">
        {currentView === 'upload' && (
          <UploadView onSlidesExtracted={handleSlidesExtracted} />
        )}
        {currentView === 'generate' && (
          <GenerationView
            slideData={slideData}
            onComplete={handleGenerationComplete}
            onBack={() => setCurrentView('upload')}
          />
        )}
        {currentView === 'player' && (
          <PlayerView
            slideData={slideData}
            scripts={scripts}
            actionsData={actionsData}
            parsedSlides={parsedSlides}
            ttsMode={ttsMode}
            onRegenerate={() => setCurrentView('generate')}
          />
        )}
      </main>
    </div>
  );
}
