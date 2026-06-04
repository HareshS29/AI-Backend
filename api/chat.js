const { kv } = require('@vercel/kv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { SYSTEM_PROMPT, FALLBACK_RESPONSE } = require('../lib/prompt');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache helpers — stored in KV with 24hr TTL
async function getCachedResponse(prompt) {
  try {
    const hash = crypto.createHash('sha256').update(prompt.toLowerCase().trim()).digest('hex');
    return await kv.get(`cache:${hash}`);
  } catch { return null; }
}

async function setCachedResponse(prompt, response) {
  try {
    const hash = crypto.createHash('sha256').update(prompt.toLowerCase().trim()).digest('hex');
    await kv.set(`cache:${hash}`, response, { ex: 86400 });
  } catch { /* non-fatal */ }
}

export default async function handler(req, res) {
  // CORS — lock to your domain in production
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  try {
    // Check if we have scraped content in KV
    const websiteContent = await kv.get('website_content');

    if (!websiteContent) {
      // No content yet — cron hasn't run or KV expired
      return res.json({ reply: FALLBACK_RESPONSE });
    }

    // Check response cache
    const cached = await getCachedResponse(message);
    if (cached) return res.json({ reply: cached });

    // Build message history — keep last 6 turns
    const trimmedHistory = history.slice(-6);

    // Website content goes in system prompt, user message stays clean
    const fullSystem = `${SYSTEM_PROMPT}\n\n═══════════════════════════════════════════\nCURRENT WEBSITE CONTENT\n═══════════════════════════════════════════\n${websiteContent}`;

    const geminiModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: fullSystem,
    });

    // Map history to Gemini format
    const chatHistory = trimmedHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content || msg.text || '' }],
    }));

    const chat = geminiModel.startChat({
      history: chatHistory,
      generationConfig: { maxOutputTokens: 500 },
    });

    const result = await chat.sendMessage(message);
    const reply = (result.response.text() || '').replace(/\*/g, '');

    await setCachedResponse(message, reply);
    return res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
