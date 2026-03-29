import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-f34860934eb2427aad9fe0b8250197a7';
const DASHSCOPE_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DASHSCOPE_LLM_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen-max';
const LLM_ACTION_MODEL = process.env.LLM_ACTION_MODEL || 'qwen-turbo';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'server-routes',
      configureServer(server) {
        // ---- /api/generate-script ----
        const handleScript = async (req, res) => {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { title, content, slideIndex, totalSlides } = JSON.parse(body);

              // Build context-aware prompt
              let userPrompt = '';
              if (slideIndex === 0) {
                userPrompt += `这是演讲的第一页（共 ${totalSlides} 页），请生成吸引人的开场白，引入主题并调动听众兴趣。\n\n`;
              } else if (slideIndex === totalSlides - 1) {
                userPrompt += `这是演讲的最后一页，请做总结陈词并感谢听众。\n\n`;
              } else {
                userPrompt += `这是演讲的第 ${slideIndex + 1} 页（共 ${totalSlides} 页）。\n\n`;
              }

              if (title) userPrompt += `幻灯片标题：${title}\n\n`;
              if (content) userPrompt += `幻灯片上的文字内容：\n${content}\n\n`;
              if (!title && !content) userPrompt += `（这一页仅有图片，没有文字）\n\n`;

              userPrompt += `请基于以上幻灯片信息，生成一段专业的演讲稿。`;

              const systemPrompt = `你是一位经验丰富的专业演讲教练和演讲稿撰写人。

核心原则：
1. **扩展而非重复**：演讲稿必须对幻灯片内容进行深入解读、补充背景信息、举例说明，绝不能仅仅复述幻灯片上的文字。
2. **自然口语化**：使用口语化的表达方式，像真正在演讲一样，避免书面语和生硬的表达。
3. **生动有趣**：适当使用比喻、反问、案例等方式让内容更生动，吸引听众注意力。
4. **逻辑清晰**：段落之间有自然的过渡，整体有起承转合。
5. **专业可信**：在涉及专业知识时，展现专业深度，让听众感受到演讲者的专业能力。

格式要求：
- 直接输出演讲稿正文，不要标题、编号、Markdown 格式
- 长度控制在 200-400 字
- 使用中文`;

              const apiRes = await fetch(DASHSCOPE_LLM_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                },
                body: JSON.stringify({
                  model: LLM_MODEL,
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                  ],
                  temperature: 0.85,
                  max_tokens: 1024,
                }),
              });

              if (!apiRes.ok) {
                const errText = await apiRes.text();
                console.error('LLM API error:', apiRes.status, errText);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'LLM_ERROR', script: '' }));
              }

              const data = await apiRes.json();
              let script = data.choices?.[0]?.message?.content || '';

              // Clean up markdown formatting if present
              script = script.replace(/^#+\s+/gm, '').replace(/\*\*/g, '').trim();

              console.log(`[Script] Slide ${slideIndex + 1}: ${script.length} chars`);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ script }));
            } catch (err) {
              console.error('Script generation error:', err);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message, script: '' }));
            }
          });
        };

        // ---- /api/tts (Qwen TTS) ----
        const handleTts = async (req, res) => {
          const url = new URL(req.url, `http://localhost`);

          // Health check
          if (url.searchParams.get('check') === '1') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ available: true }));
          }

          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { text } = JSON.parse(body);
              if (!text || !text.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Empty text' }));
              }

              // Split text into chunks if > 600 chars (Qwen TTS limit)
              const chunks = [];
              const MAX_LEN = 500;
              let remaining = text;
              while (remaining.length > 0) {
                if (remaining.length <= MAX_LEN) {
                  chunks.push(remaining);
                  break;
                }
                // Try to split at sentence boundary
                let splitAt = remaining.lastIndexOf('。', MAX_LEN);
                if (splitAt < 50) splitAt = remaining.lastIndexOf('，', MAX_LEN);
                if (splitAt < 50) splitAt = remaining.lastIndexOf('！', MAX_LEN);
                if (splitAt < 50) splitAt = remaining.lastIndexOf('？', MAX_LEN);
                if (splitAt < 50) splitAt = MAX_LEN;
                chunks.push(remaining.substring(0, splitAt + 1));
                remaining = remaining.substring(splitAt + 1).trim();
              }

              // Generate audio for each chunk (non-streaming, get URL)
              const audioBuffers = [];

              for (const chunk of chunks) {
                const apiRes = await fetch(DASHSCOPE_TTS_URL, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                  },
                  body: JSON.stringify({
                    model: 'qwen3-tts-flash',
                    input: {
                      text: chunk,
                      voice: 'Cherry',
                      language_type: 'Chinese',
                    },
                  }),
                });

                if (!apiRes.ok) {
                  const errText = await apiRes.text();
                  console.error('Qwen TTS API error:', apiRes.status, errText);
                  throw new Error(`TTS API error: ${apiRes.status}`);
                }

                const data = await apiRes.json();
                const audioUrl = data.output?.audio?.url;

                if (!audioUrl) {
                  throw new Error('No audio URL in response');
                }

                // Download the audio file from the URL
                const audioRes = await fetch(audioUrl);
                if (!audioRes.ok) {
                  throw new Error(`Failed to download audio: ${audioRes.status}`);
                }

                const arrayBuffer = await audioRes.arrayBuffer();
                audioBuffers.push(Buffer.from(arrayBuffer));
              }

              // If multiple chunks, concatenate WAV files
              let finalBuffer;
              if (audioBuffers.length === 1) {
                finalBuffer = audioBuffers[0];
              } else {
                // Concatenate WAV: use first file's header, append PCM data from rest
                finalBuffer = concatWavBuffers(audioBuffers);
              }

              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': finalBuffer.length,
              });
              res.end(finalBuffer);
            } catch (err) {
              console.error('TTS route error:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
        };

        // ---- /api/generate-actions ----
        const handleActions = async (req, res) => {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { script, shapes, slideIndex, totalSlides } = JSON.parse(body);

              // Extract shape info for the prompt
              const shapeInfo = (shapes || [])
                .filter(s => s.isTextOnly && s.text && s.text.length > 0)
                .map(s => ({
                  id: s.id,
                  name: s.name,
                  text: s.text.map(p => p.runs.map(r => r.text).join('')).join(' ').trim().substring(0, 100),
                }));

              const systemPrompt = `你是一个演示文稿动作编排专家。根据演讲稿和幻灯片元素，生成一个有序的动作序列。

**执行模型**：
- 每页的演讲稿会被拆成多段，每段独立合成TTS音频
- 动作按序列顺序执行。"speech" 播放该段音频（阻塞，等音频播完才继续）
- "spotlight" / "clearSpotlight" 立即触发不阻塞，紧跟的 speech 开始时聚光灯保持可见

**动作类型**：
- "speech": {"type":"speech","text":"该段演讲稿文本"} — 播放该段TTS音频，阻塞等待
- "spotlight": {"type":"spotlight","shapeId":数字} — 高亮指定形状，立即继续
- "clearSpotlight": {"type":"clearSpotlight"} — 取消高亮，立即继续

**生成规则**：
1. 将演讲稿拆分为 2-5 个语义段落，每段一个 speech action
2. 每段 speech 的 text 必须是演讲稿原文的子串，不能改动文字
3. 当某段演讲内容和幻灯片元素语义相关时，在该 speech 前插入 spotlight，后插入 clearSpotlight
4. 不相关的段落不需要 spotlight，只有纯 speech
5. 第一段前通常不加 spotlight（开场白）

**示例输出**：
[{"type":"speech","text":"大家好，欢迎来到今天的分享。"},{"type":"spotlight","shapeId":3},{"type":"speech","text":"接下来我们来看价值投资的核心概念。"},{"type":"clearSpotlight"},{"type":"speech","text":"价值投资的本质是寻找被市场低估的优质企业。"}]

输出严格的 JSON 数组，不要输出其他内容。`;

              let userPrompt = `这是第 ${slideIndex + 1} 页（共 ${totalSlides} 页）。\n\n演讲稿：\n${script}\n\n`;
              if (shapeInfo.length > 0) {
                userPrompt += `幻灯片上的文本元素：\n`;
                shapeInfo.forEach(s => {
                  userPrompt += `- ID=${s.id}, 名称="${s.name}", 文本="${s.text}"\n`;
                });
              } else {
                userPrompt += `（幻灯片上没有文本元素）\n`;
              }
              userPrompt += `\n请生成动作序列 JSON：`;

              const apiRes = await fetch(DASHSCOPE_LLM_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                },
                body: JSON.stringify({
                  model: LLM_ACTION_MODEL,
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                  ],
                  temperature: 0.3, // Low temperature for precise JSON
                  max_tokens: 2048,
                }),
              });

              if (!apiRes.ok) {
                const errText = await apiRes.text();
                console.error('Action LLM error:', apiRes.status, errText);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'LLM_ERROR', actions: [] }));
              }

              const data = await apiRes.json();
              let content = data.choices?.[0]?.message?.content || '';

              // Extract JSON from response (handle markdown code blocks)
              const jsonMatch = content.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                content = jsonMatch[0];
              }

              let actions;
              try {
                actions = JSON.parse(content);
              } catch {
                console.error('Action JSON parse failed:', content.substring(0, 200));
                actions = [];
              }

              // Validate and normalize actions
              actions = actions.filter(a => a && a.type).map(a => {
                if (a.type === 'speech') {
                  return { type: 'speech', text: String(a.text || '') };
                }
                if (a.type === 'spotlight') {
                  return { type: 'spotlight', shapeId: Number(a.shapeId) || 0 };
                }
                if (a.type === 'clearSpotlight') {
                  return { type: 'clearSpotlight' };
                }
                return null;
              }).filter(Boolean);

              // Fallback: if no speech actions, create one from the full script
              const hasSpeech = actions.some(a => a.type === 'speech');
              if (!hasSpeech && script) {
                actions.unshift({ type: 'speech', text: script });
              }

              console.log(`[Actions] Slide ${slideIndex + 1}: ${actions.length} actions (${actions.filter(a => a.type === 'spotlight').length} spotlights)`);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ actions }));
            } catch (err) {
              console.error('Action generation error:', err);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message, actions: [] }));
            }
          });
        };

        // Register middleware
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/generate-script')) {
            return handleScript(req, res);
          }
          if (req.url?.startsWith('/api/generate-actions')) {
            return handleActions(req, res);
          }
          if (req.url?.startsWith('/api/tts')) {
            return handleTts(req, res);
          }
          next();
        });
      }
    }
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});

/**
 * Concatenate multiple WAV buffers into one
 */
function concatWavBuffers(buffers) {
  // WAV header is 44 bytes, PCM data starts at offset 44
  // Sum all data sizes, write new header with total size
  const HEADER_SIZE = 44;
  let totalDataSize = 0;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;

  for (const buf of buffers) {
    if (buf.length < HEADER_SIZE) continue;
    totalDataSize += buf.length - HEADER_SIZE;

    if (!sampleRate) {
      // Read WAV header from first buffer
      numChannels = buf.readUInt16LE(22);
      sampleRate = buf.readUInt32LE(24);
      bitsPerSample = buf.readUInt16LE(34);
    }
  }

  if (!sampleRate) return buffers[0];

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + totalDataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(totalDataSize, 40);

  const parts = [header];
  for (const buf of buffers) {
    if (buf.length > HEADER_SIZE) {
      parts.push(buf.subarray(HEADER_SIZE));
    }
  }

  return Buffer.concat(parts);
}
