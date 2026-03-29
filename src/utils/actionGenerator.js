/**
 * Action Generator - Creates action sequences that sync speech with slide visuals
 * 
 * Given a script and the slide's shapes, generates:
 * - speech actions (text segments to speak)
 * - spotlight actions (highlight shapes relevant to current speech)
 * - laser actions (point to specific locations)
 * 
 * Key design: when audio is present, action durations are less important
 * (audio drives timing). Actions mainly control visual effects timing.
 * When no audio, durations drive everything.
 */

/**
 * Split script text into segments by sentences
 */
function splitIntoSegments(script) {
  const sentences = [];
  let current = '';
  
  for (const char of script) {
    current += char;
    if ('。！？\n'.includes(char)) {
      if (current.trim()) sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  
  return sentences;
}

/**
 * Find a shape that best matches a text segment
 */
function findMatchingShape(segment, shapes) {
  if (!shapes || shapes.length === 0) return null;
  
  // Filter to only text-containing shapes
  const textShapes = shapes.filter(s => s.isTextOnly && s.text && s.text.length > 0);
  if (textShapes.length === 0) return null;
  
  // Get all text from a shape
  function getShapeFullText(shape) {
    return shape.text.map(p => p.runs.map(r => r.text).join('')).join(' ');
  }
  
  // Score each shape by keyword overlap
  const segmentClean = segment.replace(/[，。！？、；：""''（）\s\.\,\!\?\;\:\"]/g, '');
  const chars = [...segmentClean];
  const significantChars = chars.filter(c => c.trim().length > 0);
  
  let bestShape = null;
  let bestScore = 0;
  
  for (const shape of textShapes) {
    const shapeText = getShapeFullText(shape);
    let score = 0;
    
    for (const char of significantChars) {
      if (shapeText.includes(char)) score++;
    }
    
    // Normalize by shape text length
    if (shapeText.length > 0) {
      score = score / Math.sqrt(shapeText.length);
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestShape = shape;
    }
  }
  
  // Only return a match if score is meaningful
  if (bestScore >= 2) return bestShape;
  return null;
}

/**
 * Get center point of a shape in canvas coordinates
 */
function getShapeCenter(shape) {
  if (!shape || !shape.xfrm) return null;
  return {
    x: shape.xfrm.x + shape.xfrm.w / 2,
    y: shape.xfrm.y + shape.xfrm.h / 2,
  };
}

/**
 * Estimate duration of a text segment in seconds
 * Used when there's no audio to drive timing
 * Chinese: ~4 chars/sec, English: ~3 words/sec
 */
function estimateDuration(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  return Math.max(2, chineseChars / 4 + englishWords / 3);
}

/**
 * Generate actions for a single slide
 * @param {string} script - The full script text for this slide
 * @param {object} parsedSlide - The parsed slide data (shapes, etc.)
 * @param {number} slideIndex - Current slide index
 * @returns {Array} Action sequence
 */
export function generateActions(script, parsedSlide, slideIndex) {
  if (!script || !script.trim()) return [];
  
  const actions = [];
  const shapes = parsedSlide.shapes || [];
  const segments = splitIntoSegments(script);
  
  // First action: small delay to let the slide settle
  actions.push({
    type: 'wait',
    duration: 0.5,
  });
  
  let charPos = 0; // Track cumulative character position in script
  
  // Track which shapes have been highlighted to avoid too much repetition
  const highlightedShapes = new Set();
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const duration = estimateDuration(segment);
    const startChar = charPos;
    const endChar = charPos + segment.length;
    charPos = endChar;
    
    // Find a matching shape for this segment
    const match = findMatchingShape(segment, shapes);
    
    // Spotlight: only highlight if shape hasn't been highlighted recently
    // and isn't the same as the last one
    if (match && !highlightedShapes.has(match.id)) {
      const center = getShapeCenter(match);
      
      actions.push({
        type: 'spotlight',
        shapeId: match.id,
        shapeName: match.name,
        duration: 0.3,
      });
      
      // Laser for emphasis (only on every other match to avoid clutter)
      if (center && i % 2 === 0) {
        actions.push({
          type: 'laser',
          x: center.x,
          y: center.y,
          duration: Math.min(1.5, duration * 0.4),
        });
      }
      
      highlightedShapes.add(match.id);
      // Reset set periodically to allow re-highlighting important shapes
      if (highlightedShapes.size > Math.max(3, shapes.length / 2)) {
        highlightedShapes.clear();
      }
      
      // Will clear after speech
    }
    
    // The speech action
    actions.push({
      type: 'speech',
      text: segment,
      duration, // used as fallback when no audio
      startChar,
      endChar,
    });
    
    // Clear spotlight after speech (only if we set one)
    if (match) {
      actions.push({
        type: 'clearSpotlight',
        duration: 0.2,
      });
    }
  }
  
  // Final pause before auto-advance
  actions.push({
    type: 'wait',
    duration: 1.0,
  });
  
  return actions;
}

/**
 * Generate actions for all slides
 */
export function generateAllActions(scripts, parsedSlides) {
  return scripts.map((script, i) => {
    const parsedSlide = parsedSlides[i] || { shapes: [] };
    return generateActions(script.script || '', parsedSlide, i);
  });
}
