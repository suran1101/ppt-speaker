/**
 * Canvas SlideRenderer - Renders PPT slides on HTML5 Canvas with overlay effects
 * 
 * Renders: shapes, text, lines, images
 * Overlay: spotlight (highlight shape), laser (point at location)
 */

const DPR = window.devicePixelRatio || 1;

/**
 * Create a canvas with proper DPR scaling
 */
export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width * DPR;
  canvas.height = height * DPR;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  return { canvas, ctx };
}

/**
 * Draw rounded rectangle path
 */
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Apply fill to context
 */
function applyFill(ctx, fill, x, y, w, h) {
  if (!fill || fill.type === 'none') return;
  
  ctx.globalAlpha = fill.alpha !== undefined ? fill.alpha : 1;
  
  if (fill.type === 'solid' && fill.color) {
    ctx.fillStyle = fill.color;
    if (w !== undefined) {
      ctx.fillRect(x, y, w, h);
    }
  }
  
  ctx.globalAlpha = 1;
}

/**
 * Draw a block of text on canvas, handling word wrap, multiple lines, alignment
 */
function drawTextBlock(ctx, x, y, w, h, paragraphs, options = {}) {
  const {
    fontSize = 14,
    bold = false,
    italic = false,
    color = '#000000',
    align = 'left',
    anchor = 't',
    font = '',
  } = options;
  
  const fontWeight = bold ? 'bold' : 'normal';
  const fontStyle = italic ? 'italic' : 'normal';
  const fontFamily = font || '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  
  // Build the full line list from all paragraphs
  const lineHeight = fontSize * 1.4;
  const allLines = [];
  
  for (const para of paragraphs) {
    const paraAlign = para.align || align;
    const paraLines = [];
    
    // Each run in this paragraph
    let currentLineRuns = [];
    let currentLineWidth = 0;
    
    for (const run of para.runs) {
      if (!run.text) continue;
      
      const runFont = `${run.italic ? 'italic' : ''} ${run.bold ? 'bold' : ''} ${run.size || fontSize}px ${run.font || fontFamily}`.trim();
      ctx.font = runFont;
      
      // Character-by-character wrapping
      for (const char of run.text) {
        const charWidth = ctx.measureText(char).width;
        
        if (currentLineWidth + charWidth > w && currentLineRuns.length > 0) {
          // Push current line
          paraLines.push({ runs: [...currentLineRuns], width: currentLineWidth, align: paraAlign });
          currentLineRuns = [];
          currentLineWidth = 0;
        }
        
        currentLineRuns.push({ char, width: charWidth, font: runFont, color: run.color || color });
        currentLineWidth += charWidth;
      }
    }
    
    if (currentLineRuns.length > 0) {
      paraLines.push({ runs: [...currentLineRuns], width: currentLineWidth, align: paraAlign });
    }
    
    if (paraLines.length === 0) {
      paraLines.push({ runs: [], width: 0, align: paraAlign }); // empty paragraph = blank line
    }
    
    allLines.push(...paraLines);
  }
  
  // Calculate vertical start position
  const totalTextHeight = allLines.length * lineHeight;
  let startY;
  if (anchor === 'ctr') {
    startY = y + (h - totalTextHeight) / 2;
  } else if (anchor === 'b') {
    startY = y + h - totalTextHeight;
  } else {
    startY = y;
  }
  
  // Clip to shape bounds
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  
  // Draw each line
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const ly = startY + i * lineHeight;
    
    if (line.runs.length === 0) continue;
    
    // Determine alignment
    let startX = x;
    ctx.textBaseline = 'middle';
    
    if (line.align === 'center') {
      startX = x + (w - line.width) / 2;
    } else if (line.align === 'right') {
      startX = x + w - line.width;
    }
    
    // Draw each run character
    let cx = startX;
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillStyle = run.color;
      ctx.fillText(run.char, cx, ly + lineHeight / 2);
      cx += run.width;
    }
  }
  
  ctx.restore();
}

/**
 * Render a single slide to canvas (synchronous - shapes, text, lines only)
 */
export function renderSlide(ctx, slide, options = {}) {
  const W = options.width || 960;
  const H = options.height || 540;
  
  // Clear
  ctx.clearRect(0, 0, W, H);
  
  // Background
  if (slide.background) {
    applyFill(ctx, slide.background, 0, 0, W, H);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
  }
  
  // Render shapes
  for (const shape of slide.shapes) {
    renderShape(ctx, shape);
  }
  
  // Render connectors/lines
  for (const conn of slide.connectors || []) {
    renderConnector(ctx, conn);
  }
}

/**
 * Render a shape
 */
function renderShape(ctx, shape) {
  if (!shape.xfrm) return;
  const { x, y, w, h } = shape.xfrm;
  
  // Skip zero-size shapes
  if (w < 1 || h < 1) return;
  
  ctx.save();
  
  // Shadow
  if (shape.shadow) {
    const s = shape.shadow;
    ctx.shadowColor = s.color?.color || 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = s.blur;
    ctx.shadowOffsetX = s.offset * 0.7;
    ctx.shadowOffsetY = s.offset;
  }
  
  if (shape.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    if (shape.line) {
      ctx.strokeStyle = shape.line.color?.color || '#000000';
      ctx.lineWidth = Math.max(1, shape.line.width / 12700);
      ctx.globalAlpha = shape.line.color?.alpha !== undefined ? shape.line.color.alpha : 1;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else {
    // Rectangle/shape with fill
    if (shape.fill && shape.fill.type !== 'none') {
      roundRectPath(ctx, x, y, w, h, 0);
      applyFill(ctx, shape.fill, x, y, w, h);
    }
    
    // Border
    if (shape.line && shape.line.color) {
      roundRectPath(ctx, x, y, w, h, 0);
      ctx.strokeStyle = shape.line.color.color || '#000000';
      ctx.lineWidth = Math.max(0.5, shape.line.width / 12700);
      ctx.globalAlpha = shape.line.color.alpha !== undefined ? shape.line.color.alpha : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  
  // Text content
  if (shape.text && shape.text.length > 0 && shape.isTextOnly) {
    const padding = 4;
    const anchor = shape.bodyPr?.anchor || 't';
    
    drawTextBlock(ctx, x + padding, y + padding, w - padding * 2, h - padding * 2, shape.text, {
      anchor,
    });
  }
  
  ctx.restore();
}

/**
 * Render a connector/line
 */
function renderConnector(ctx, conn) {
  if (!conn.xfrm) return;
  const { x, y, w, h } = conn.xfrm;
  
  if (conn.line && conn.line.color) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.strokeStyle = conn.line.color.color || '#000000';
    ctx.lineWidth = Math.max(1, (conn.line?.width || 12700) / 12700);
    ctx.globalAlpha = conn.line.color.alpha !== undefined ? conn.line.color.alpha : 1;
    ctx.stroke();
    ctx.restore();
  }
}

// Image cache
const imageCache = new Map();

function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Render pictures (async for image loading)
 */
async function renderPictures(ctx, slide) {
  for (const pic of slide.pictures || []) {
    if (!pic.xfrm) continue;
    const { x, y, w, h } = pic.xfrm;
    
    const imageUrl = pic.relTarget ? (slide.images?.[pic.relTarget] || slide.images?.[pic.imageRId]) : slide.images?.[pic.imageRId];
    
    if (imageUrl) {
      try {
        const img = await loadImage(imageUrl);
        ctx.drawImage(img, x, y, w, h);
      } catch {
        ctx.fillStyle = '#E0E0E0';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#999';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Image', x + w / 2, y + h / 2);
        ctx.textAlign = 'left';
      }
    }
  }
}

/**
 * Full async render: shapes + text + lines + pictures
 */
export async function renderSlideAsync(ctx, slide, options = {}) {
  const W = options.width || 960;
  const H = options.height || 540;
  
  // Render synchronous parts (shapes, text, lines)
  renderSlide(ctx, slide, options);
  
  // Render pictures (async)
  await renderPictures(ctx, slide);
}

/**
 * Draw spotlight effect on a shape — soft glow border, no dimming overlay
 */
export function drawSpotlight(ctx, shapeId, slide, options = {}) {
  const shape = slide.shapes.find(s => s.id === shapeId);
  if (!shape || !shape.xfrm) return;
  
  const { x, y, w, h } = shape.xfrm;
  const { width = 960, height = 540, color = '#6c5ce7', alpha = 0.7 } = options;
  
  ctx.save();
  
  // No dim overlay — keep the slide fully visible
  
  // Outer glow
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  ctx.globalAlpha = alpha;
  roundRectPath(ctx, x - 4, y - 4, w + 8, h + 8, 6);
  ctx.stroke();
  
  // Second pass for stronger glow
  ctx.shadowBlur = 40;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = alpha * 0.4;
  roundRectPath(ctx, x - 6, y - 6, w + 12, h + 12, 8);
  ctx.stroke();
  
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Draw laser pointer effect
 */
export function drawLaser(ctx, x, y, options = {}) {
  const { color = '#FF3333', size = 8, glow = 15 } = options;
  
  ctx.save();
  
  // Outer glow
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, glow);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.3, 'rgba(255, 50, 50, 0.6)');
  gradient.addColorStop(1, 'rgba(255, 50, 50, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, glow, 0, Math.PI * 2);
  ctx.fill();
  
  // Inner bright dot
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(x, y, size / 3, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
}
