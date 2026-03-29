/**
 * Script Generator - Generates presentation scripts using AI (LLM API) or local templates
 * 
 * Inspired by OpenMAIC's prompt engineering approach:
 * - "Slides are visual aids, NOT lecture scripts"
 * - Speech should expand on slide content naturally
 * - Professional, engaging, conversational tone
 */

const API_ENDPOINT = '/api/generate-script';
let apiAvailable = null; // null = not checked yet, true/false

/**
 * Quick check if the LLM API is available
 */
async function checkApiAvailable() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 5s timeout
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '测试', content: '测试内容', slideIndex: 0, totalSlides: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    // Check if we got an actual script (not error/empty)
    apiAvailable = !!(data.script && data.script.trim().length > 10 && !data.error);
    if (apiAvailable) {
      console.log('[ScriptGen] LLM API available, sample output:', data.script.substring(0, 50));
    } else {
      console.warn('[ScriptGen] LLM API returned:', data.error || 'empty script');
    }
  } catch {
    console.warn('[ScriptGen] LLM API unavailable');
    apiAvailable = false;
  }
  return apiAvailable;
}

/**
 * Generate script using Vite's server-side API route
 */
async function generateScriptViaAPI(title, content, slideIndex, totalSlides) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, slideIndex, totalSlides }),
      signal: controller.signal,
    });

    const data = await response.json();

    if (data.error || !data.script) {
      throw new Error(data.error || 'Empty script');
    }

    return data.script;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate script using local template-based approach
 * Used when no API is available
 */
function generateScriptLocal(title, content, slideIndex, totalSlides) {
  if (!title && !content) {
    if (slideIndex === 0) {
      return '大家好，欢迎来到今天的分享。让我们开始今天的演讲之旅。';
    }
    if (slideIndex === totalSlides - 1) {
      return '以上就是今天的全部内容。感谢大家的聆听，希望这些内容对大家有所帮助。如果大家有任何问题，欢迎随时交流。谢谢大家！';
    }
    return '让我们继续来看下一部分的内容。';
  }

  const parts = [];

  // Opening for first slide
  if (slideIndex === 0) {
    parts.push('大家好，欢迎来到今天的分享。');
  }

  // Expand on title
  if (title) {
    parts.push(`接下来，我们来看"${title}"这部分的内容。`);
  }

  // Expand on content - add conversational filler
  if (content) {
    const sentences = content.split('\n').filter(s => s.trim());
    if (sentences.length > 0) {
      if (sentences.length === 1) {
        parts.push(`${sentences[0]}。这一点非常重要，希望大家能够牢记。`);
      } else if (sentences.length <= 3) {
        parts.push(sentences.join('。') + '。');
      } else {
        parts.push('关于这个主题，有几个要点需要我们重点关注。');
        parts.push(`首先，${sentences[0]}。`);
        for (let i = 1; i < sentences.length - 1; i++) {
          parts.push(`其次，${sentences[i]}。`);
        }
        parts.push(`最后，${sentences[sentences.length - 1]}。`);
      }
      parts.push('这些内容是这一页的核心要点，大家可以结合幻灯片上的信息来理解。');
    }
  }

  // Closing for last slide
  if (slideIndex === totalSlides - 1) {
    parts.push('以上就是今天分享的全部内容。感谢大家的聆听，希望这些内容对大家有所帮助。谢谢大家！');
  }

  return parts.join('\n\n');
}

/**
 * Main export: Generate a presentation script for a slide
 * Strategy: always try API first, fall back to local template on failure
 */
export async function generateScript(title, content, slideIndex, totalSlides) {
  // Skip pre-check, directly try API
  try {
    const script = await generateScriptViaAPI(title, content, slideIndex, totalSlides);
    if (script && script.trim()) {
      return script;
    }
  } catch (err) {
    console.warn('[ScriptGen] API failed, using local template:', err.message);
  }

  return generateScriptLocal(title, content, slideIndex, totalSlides);
}

/**
 * Generate action sequence for a slide via LLM API
 * @param {string} script - The speech script for this slide
 * @param {Array} shapes - The parsed shapes from pptxParser
 * @param {number} slideIndex - Current slide index
 * @param {number} totalSlides - Total number of slides
 * @returns {Promise<Array>} Action sequence
 */
export async function generateActions(script, shapes, slideIndex, totalSlides) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const res = await fetch('/api/generate-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, shapes, slideIndex, totalSlides }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    if (data.actions && data.actions.length > 0) {
      console.log(`[Actions] Slide ${slideIndex + 1}: ${data.actions.length} actions from LLM`);
      return data.actions;
    }
  } catch (err) {
    console.warn('[Actions] LLM failed, will use fallback:', err.message);
  }

  return [];
}
