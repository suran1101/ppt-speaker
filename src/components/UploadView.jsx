import React, { useState, useCallback, useRef } from 'react';
import { parsePPTX } from '../utils/pptxParser';
import '../App.css';

export default function UploadView({ onSlidesExtracted }) {
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleFile = useCallback(async (f) => {
    if (!f) return;
    if (!f.name.endsWith('.pptx')) {
      setError('请上传 .pptx 格式的文件');
      return;
    }
    setError('');
    setFile(f);
    setIsProcessing(true);

    try {
      const arrayBuffer = await f.arrayBuffer();
      const parsed = await parsePPTX(arrayBuffer);
      
      if (!parsed.slides || parsed.slides.length === 0) {
        setError('未能从 PPT 中提取到幻灯片内容');
        setIsProcessing(false);
        return;
      }
      
      // Extract simple text data for script generation, keep shapes for action generation
      const slides = parsed.slides.map(s => {
        // Collect all text from shapes
        const title = s.shapes.find(sh => sh.isTextOnly && sh.text)?.text?.[0]?.runs?.[0]?.text || '';
        const content = s.shapes
          .filter(sh => sh.isTextOnly && sh.text)
          .slice(1)
          .map(sh => sh.text.map(p => p.runs.map(r => r.text).join('')).join('\n'))
          .join('\n');
        return { title, content, shapes: s.shapes };
      });
      
      onSlidesExtracted(slides, parsed.slides);
    } catch (err) {
      console.error(err);
      setError('解析 PPT 文件失败: ' + err.message);
      setIsProcessing(false);
    }
  }, [onSlidesExtracted]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    handleFile(f);
  }, [handleFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  return (
    <div className="upload-view">
      <div className="upload-container">
        <div className="upload-hero">
          <h1>AI 演讲稿生成器</h1>
          <p>
            上传 PPT 文件，AI 将为每页幻灯片生成专业演讲稿，并合成语音，最终呈现可播放的演讲演示。
          </p>
        </div>

        <div
          className={`upload-zone ${isDragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => !file && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pptx"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />

          {!file && !isProcessing && (
            <>
              <div className="upload-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="18" x2="12" y2="12"/>
                  <polyline points="9 15 12 12 15 15"/>
                </svg>
              </div>
              <h3>拖放 PPT 文件到此处</h3>
              <p>或点击选择文件 (支持 .pptx 格式)</p>
            </>
          )}

          {isProcessing && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', position: 'relative', zIndex: 1 }}>
              <div className="spinner" style={{ width: '32px', height: '32px' }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: '15px' }}>
                正在解析 PPT 文件...
              </p>
            </div>
          )}

          {file && !isProcessing && (
            <div className="upload-file-info">
              <div className="file-icon">P</div>
              <div className="file-details">
                <div className="file-name">{file.name}</div>
                <div className="file-size">{formatSize(file.size)}</div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '14px', textAlign: 'center' }}>
            {error}
          </p>
        )}

        {file && !isProcessing && (
          <div className="upload-actions">
            <button
              className="btn btn-secondary"
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
                setError('');
              }}
            >
              重新选择
            </button>
          </div>
        )}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '20px',
          width: '100%',
          maxWidth: '640px'
        }}>
          {[
            { icon: '📝', title: '智能演讲稿', desc: 'AI 理解每页内容，生成流畅自然的演讲稿' },
            { icon: '🔊', title: '语音合成', desc: '浏览器原生 TTS 将演讲稿转为生动语音' },
            { icon: '▶️', title: '一键播放', desc: '幻灯片与语音同步播放，自动翻页' },
          ].map((f, i) => (
            <div key={i} style={{
              textAlign: 'center',
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>{f.icon}</div>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary)' }}>{f.title}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
