require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const crypto = require('crypto');

// ── REDIS SETUP ───────────────────────────────────────────────────────────────
// Redis is optional. Only connects if REDIS_URL is explicitly set in .env.
// Without it the server falls back to in-memory cache automatically.
// To enable locally: add REDIS_URL=redis://127.0.0.1:6379 to your .env
let redisClient = null;
let redisAvailable = false;

if (process.env.REDIS_URL) {
  const redis = require('redis');
  redisClient = redis.createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 3) { console.warn('Redis unavailable, falling back to in-memory cache'); return false; }
        return Math.min(retries * 100, 3000);
      }
    }
  });
  redisClient.connect()
    .then(() => { redisAvailable = true; console.log('Redis connected'); })
    .catch(() => { redisAvailable = false; console.warn('Redis not available, using in-memory cache fallback'); });
} else {
  console.log('No REDIS_URL set — using in-memory cache.');
}

// ── IN-MEMORY CACHE FALLBACK ──────────────────────────────────────────────────
const memoryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Content version tied to lastFetched so cached AI responses are invalidated
// automatically when the scraped website content is refreshed.
function getContentVersion() {
  return lastFetched ? Math.floor(lastFetched / ONE_HOUR) : 0;
}

async function getCachedResponse(prompt) {
  const hash = crypto.createHash('sha256')
    .update(`${prompt.toLowerCase().trim()}:${getContentVersion()}`)
    .digest('hex');
  const key = `cache:${hash}`;
  if (redisAvailable) {
    try {
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch { /* fall through */ }
  }
  const entry = memoryCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.value;
  return null;
}

async function setCachedResponse(prompt, responseText) {
  const hash = crypto.createHash('sha256')
    .update(`${prompt.toLowerCase().trim()}:${getContentVersion()}`)
    .digest('hex');
  const key = `cache:${hash}`;
  if (redisAvailable) {
    try { await redisClient.setEx(key, 86400, JSON.stringify(responseText)); return; } catch { /* fall through */ }
  }
  memoryCache.set(key, { value: responseText, timestamp: Date.now() });
  if (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value);
}

// ── BULLMQ QUEUE (only when Redis available) ──────────────────────────────────
let chatQueue = null;
let chatQueueEvents = null;

if (process.env.REDIS_URL) {
  const { Queue, Worker, QueueEvents } = require('bullmq');
  const redisConnection = { url: process.env.REDIS_URL };
  chatQueue = new Queue('chatQueue', { connection: redisConnection });
  chatQueueEvents = new QueueEvents('chatQueue', { connection: redisConnection });
  new Worker('chatQueue', async job => {
    return await callAI(job.data.messages, job.data.systemInstruction, job.data.websiteContent, job.data.model);
  }, { connection: redisConnection, concurrency: 5 });
}

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many requests, please try again in a minute.' },
  standardHeaders: true, legacyHeaders: false,
});

// ── PARALLEL REQUEST PREVENTION ───────────────────────────────────────────────
const activeLocks = new Map();
const preventParallelRequests = (req, res, next) => {
  const userId = req.ip;
  if (activeLocks.get(userId)) return res.status(429).json({ error: 'Please wait for your previous request to finish.' });
  activeLocks.set(userId, true);
  res.on('finish', () => activeLocks.delete(userId));
  next();
};

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
// Add ADMIN_TOKEN=your-secret to your .env file.
// Pass it as the x-admin-token header when calling /clear-cache or /test-scrape.
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ── APP SETUP ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── COMPANY PAGES TO SCRAPE ───────────────────────────────────────────────────
// Add all 26 pages here. Concurrency-limited scraping means adding more pages
// won't crash the server — it just adds more rounds at 4 pages at a time.
const COMPANY_PAGES = [
  "https://vdart.com",
  "https://www.vdart.com/services/digital-talent-management/",
  "https://vdart.com/services",
  "https://vdart.com/careers",
  "https://www.vdart.com/contact-us/",
  "https://www.vdart.com/people-of-vdart",
  "https://vdart.com/insights",
  "https://www.vdart.com/products/fleet-management/",
  "https://www.vdart.com/industries",
  "https://www.vdart.com/industries/automotive/",
  "https://www.vdart.com/industries/banking-and-finance/",
  "https://www.vdarthealthcare.com/",
  "https://www.vdartepc.com/",
  "https://www.vdart.com/industries/energy-and-utilities/",
  "https://www.vdart.com/our-origin-story",
  "https://www.vdart.com/our-culture/",
  "https://www.vdart.com/sustainability-and-esg-services/",
  "https://www.vdart.com/what-we-do",
  "https://www.vdart.com/what-we-do/events/",
  "https://www.vdart.com/what-we-do/partners/",
  "https://www.vdart.com/internship/",
  "https://www.vdart.com/candidate-referral-program",
  "https://www.vdart.com/uae",
  "https://www.vdart.com/malaysia",
  "https://www.vvalidate.com/",
];

// ── PUPPETEER: SINGLE SHARED BROWSER INSTANCE ─────────────────────────────────
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    const puppeteer = require('puppeteer');
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log("Browser launched.");
  }
  return browserInstance;
}

async function scrapeWebsitePage(url) {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const content = await page.evaluate(() => {
      // Extended selector list strips more noise than before
      document.querySelectorAll(
        'nav, footer, script, style, head, noscript, iframe, header, ' +
        '[class*="cookie"], [class*="banner"], [id*="popup"], ' +
        '[class*="popup"], [class*="modal"], [aria-hidden="true"]'
      ).forEach(el => el.remove());
      return document.body.innerText.replace(/\s+/g, ' ').trim();
    });
    await page.close();
    // 2500 chars per page keeps total context manageable at 26 pages (~65k chars).
    // Previous limit of 5000 would hit ~130k chars with 26 pages.
    return content.substring(0, 2500);
  } catch (err) {
    console.error(`Failed to scrape ${url}:`, err.message);
    return "";
  }
}

// ── PARALLEL SCRAPING WITH CONCURRENCY LIMIT ──────────────────────────────────
// Scrapes up to `concurrency` pages simultaneously instead of one-by-one.
// With 26 pages at concurrency 4: ~7 parallel rounds (~45s total).
// vs sequential: 26 rounds (~4-5 minutes total).
async function scrapeWithConcurrency(urls, concurrency = 4) {
  const results = [];
  const queue = [...urls];

  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      console.log(`Scraping: ${url}`);
      const content = await scrapeWebsitePage(url);
      if (content) results.push(`--- ${url} ---\n${content}`);
    }
  });

  await Promise.all(workers);
  return results.join("\n\n");
}

// ── WEBSITE CACHING ───────────────────────────────────────────────────────────
let cachedContent = null;
let lastFetched = null;
let scrapeInProgress = false;

async function getWebsiteContent() {
  // Already cached and fresh — return immediately
  if (cachedContent && Date.now() - lastFetched < ONE_HOUR) {
    return cachedContent;
  }

  // Scrape already running (triggered by boot) — wait for it instead of
  // launching a duplicate scrape
  if (scrapeInProgress) {
    console.log("Scrape already in progress, waiting...");
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (!scrapeInProgress) { clearInterval(interval); resolve(); }
        if (Date.now() - start > 120000) { clearInterval(interval); reject(new Error("Scrape wait timeout")); }
      }, 500);
    });
    return cachedContent;
  }

  scrapeInProgress = true;
  try {
    console.log(`Scraping ${COMPANY_PAGES.length} pages with concurrency 4...`);
    cachedContent = await scrapeWithConcurrency(COMPANY_PAGES, 4);
    lastFetched = Date.now();
    console.log(`Website cached. Total length: ${cachedContent.length} chars across ${COMPANY_PAGES.length} pages.`);
  } catch (err) {
    console.error("Scrape failed:", err.message);
  } finally {
    scrapeInProgress = false;
  }

  return cachedContent;
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are Vee, a friendly and professional AI assistant for VDart — a global staffing and technology company.
You represent VDart, VDart Digital, VDart Academy, and Sidd Ahmed (CEO of VDart).

═══════════════════════════════════════════
IMPORTANT: INTRO AND GREETING RULES
═══════════════════════════════════════════
- You NEVER introduce yourself or say "Hi I am Vee" inside an answer. The introduction is handled separately before the conversation starts.
- Do NOT begin any response with a greeting like "Hi", "Hello", "Hey", or "Hi, I am Vee".
- Jump straight into answering the question in a warm, helpful tone.
- The only exception: if the user sends ONLY a greeting with no question (hi, hello, hey), respond with: "How can I help you with VDart today?"

═══════════════════════════════════════════
KNOWLEDGE AND ANSWERING RULES
═══════════════════════════════════════════
1. Always try to answer using the provided website content first.
2. If the answer is not in the website content, use your knowledge about VDart, VDart Digital, VDart Academy, or Sidd Ahmed.
3. If the question is completely unrelated to VDart or its brands, refuse politely and redirect to contact.
4. Never make up information. If you are unsure, say so and direct the user to contact the team.

═══════════════════════════════════════════
TOPICS YOU MUST REFUSE TO ANSWER
═══════════════════════════════════════════
- General knowledge, math, coding help, definitions, or trivia unrelated to VDart
- Questions about competitors or other companies
- Legal advice, salary negotiations, or compensation details
- Questions about layoffs, internal company issues, or confidential matters
- Medical, financial, or personal advice
- Anything that is not directly related to VDart and its services

For ALL refused topics, reply with exactly:
"I don't have that information available. For further assistance please contact us at csm@vdartinc.com or call (470) 323-8433 and our team will be happy to help."

═══════════════════════════════════════════
TONE AND PERSONALITY
═══════════════════════════════════════════
- Be warm, professional, and approachable at all times
- Use clear, plain language — avoid corporate jargon
- Keep all responses under 150 words unless a detailed list is specifically needed
- Never use markdown bold (asterisks like **text**) or bullet point asterisks (*) in responses
- Write in clean plain text only
- If a user writes in another language, respond in that same language

═══════════════════════════════════════════
LINK ROUTING RULES
═══════════════════════════════════════════
IMPORTANT: Always give a helpful answer first, then provide the relevant link at the end.
Never just drop a link with no explanation. The link should feel like a natural next step.

CAREERS & JOBS:
- Topic: job openings, apply for a job, hiring, positions, working at VDart
- Response: answer what you know about the role or team, then say: "You can explore open positions and apply at https://vdart.com/careers"

INTERNSHIPS:
- Topic: internships, intern programs, student opportunities
- Response: share what you know, then say: "To learn more about internship opportunities, visit https://vdart.com/careers"

SERVICES:
- Topic: what does VDart do, staffing services, technology services, solutions
- Response: briefly describe VDart's offerings, then say: "For a full overview of our services, visit https://vdart.com/services"

ABOUT VDART:
- Topic: company history, who is VDart, about the company, leadership, Sidd Ahmed
- Response: answer from website content, then say: "Learn more about us at https://vdart.com/about"

CONTACT:
- Topic: how to reach VDart, get in touch, contact someone
- Response: answer warmly, then provide: Email: csm@vdartinc.com | Phone: (470) 323-8433 | https://vdart.com/contact

PEOPLE OF VDART:
- Topic: team, employees, culture, people, staff stories
- Response: answer what you know, then say: "Meet the people behind VDart at https://www.vdart.com/people-of-vdart"

VDART UAE:
- Topic: VDart UAE, VDart in the UAE, Dubai, Middle East
- Response: share what you know, then say: "For more on VDart UAE, visit https://www.vdart.com/uae"

VDART MALAYSIA:
- Topic: VDart Malaysia, VDart in Malaysia, Kuala Lumpur
- Response: share what you know, then say: "For more on VDart Malaysia, visit https://www.vdart.com/malaysia"

DOCUMENT AUTHENTICATION:
- Topic: document authentication, document verification, verify documents, vValidate
- Response: explain what the service does, then say: "For document authentication, visit our verification platform at https://www.vvalidate.com/"

VDART DIGITAL:
- Topic: VDart Digital, digital transformation, technology solutions
- Response: describe VDart Digital's work, then say: "Learn more at https://vdart.com/services"

VDART ACADEMY:
- Topic: VDart Academy, training, learning programs, upskilling
- Response: describe the academy, then say: "Find out more at https://vdart.com/about"

═══════════════════════════════════════════
HANDLING SPECIFIC SITUATIONS
═══════════════════════════════════════════
COMPLAINTS OR FRUSTRATION:
- Acknowledge the frustration calmly: "I understand your frustration and I am sorry to hear that."
- Always escalate to: csm@vdartinc.com or (470) 323-8433
- Never argue or become defensive

RUDE OR ABUSIVE MESSAGES:
- Respond once calmly: "I am here to help with VDart-related questions. Please keep the conversation respectful."
- If it continues, say: "I am unable to continue this conversation. Please contact us directly at csm@vdartinc.com."

FOLLOW-UP AND CLARIFICATION:
- If a question is vague, ask one short clarifying question before answering
- Example: "Are you asking about VDart staffing services or VDart Digital technology services?"

SENSITIVE TOPICS (salaries, layoffs, legal, internal matters):
- Respond: "That is something our team can better assist you with. Please reach out at csm@vdartinc.com or call (470) 323-8433."

═══════════════════════════════════════════
CONTACT DETAILS (always use these exactly)
═══════════════════════════════════════════
Email: csm@vdartinc.com
Phone: (470) 323-8433
Careers: https://vdart.com/careers
`;

// ── INTRO MESSAGE ─────────────────────────────────────────────────────────────
// Returned by GET /chat/intro when the widget first loads.
// Displayed as Vee's opening message before any user input.
// Keeping it here (not in the AI) means it is instant — no API call needed.
const INTRO_MESSAGE = "Hi, I am Vee, VDart's virtual assistant! I am here to help you with anything related to VDart — from our services and careers to regional offices and more. What can I help you with today?";

// ── FALLBACK RESPONSE ─────────────────────────────────────────────────────────
// Returned if a user messages before the boot scrape has finished.
// Only relevant in the first ~45 seconds after server start.
const FALLBACK_RESPONSE = "Hi, I am Vee! I am just finishing my startup — please try again in about a minute and I will be ready to answer any questions about VDart.";

// ── AI API CALL ───────────────────────────────────────────────────────────────
// Website content is injected into the system prompt, not the user message.
// The conversation history stays clean and the content blob is only sent
// once per request regardless of how many history turns exist.
async function callAI(messages, systemInstruction, websiteContent, model = "gemini-2.0-flash") {
  const fullSystem = websiteContent
    ? `${systemInstruction}\n\n═══════════════════════════════════════════\nCURRENT WEBSITE CONTENT\n═══════════════════════════════════════════\n${websiteContent}`
    : systemInstruction;

  const geminiModel = genAI.getGenerativeModel({
    model,
    systemInstruction: fullSystem,
  });

  // Gemini uses "user"/"model" roles — map "assistant" back to "model"
  const history = messages.slice(0, -1).map(msg => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content || msg.text || "" }]
  }));

  const lastMessage = messages[messages.length - 1];
  const chat = geminiModel.startChat({
    history,
    generationConfig: { maxOutputTokens: 500 }
  });

  const result = await chat.sendMessage(lastMessage.content || lastMessage.text || "");
  return result.response.text();
}

// ── CHAT ENDPOINT ─────────────────────────────────────────────────────────────
app.post("/chat", apiLimiter, preventParallelRequests, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "No message provided" });

    // Return fallback immediately if boot scrape hasn't finished yet
    if (!cachedContent) {
      return res.json({ reply: FALLBACK_RESPONSE });
    }

    const cached = await getCachedResponse(message);
    if (cached) return res.json({ reply: cached });

    const websiteContent = await getWebsiteContent();
    const trimmedHistory = history.slice(-6);

    // User message is a clean string — website content travels in the system prompt
    const messages = [
      ...trimmedHistory,
      { role: "user", content: message }
    ];

    let reply;
    if (chatQueue && chatQueueEvents) {
      const job = await chatQueue.add('generateChat', { messages, systemInstruction: SYSTEM_PROMPT, websiteContent }, {
        removeOnComplete: true, removeOnFail: true, timeout: 15000
      });
      reply = await job.waitUntilFinished(chatQueueEvents, 15000);
    } else {
      reply = await callAI(messages, SYSTEM_PROMPT, websiteContent);
    }

    const cleanedReply = (reply || "").replace(/\*/g, "");
    await setCachedResponse(message, cleanedReply);
    res.json({ reply: cleanedReply });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── INTRO ENDPOINT ────────────────────────────────────────────────────────────
// Called once by the frontend when the chat widget opens.
// Returns Vee's intro message instantly without hitting the AI API.
app.get('/chat/intro', (req, res) => {
  res.json({ message: INTRO_MESSAGE });
});

// ── TEST ROUTE ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Server is running",
    scrapeReady: !!cachedContent,
    lastFetched: lastFetched ? new Date(lastFetched).toISOString() : null,
    pageCount: COMPANY_PAGES.length,
    contentLength: cachedContent ? cachedContent.length : 0
  });
});

// ── TESTING UI ────────────────────────────────────────────────────────────────
app.get("/testing-ai", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Test Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root { --bg-color: #0b0f19; --card-bg: rgba(17,24,39,0.75); --border-color: rgba(255,255,255,0.08); --accent-color: #6366f1; --accent-hover: #4f46e5; --accent-glow: rgba(99,102,241,0.4); --text-main: #f3f4f6; --text-muted: #9ca3af; --success-color: #10b981; }
    * { box-sizing: border-box; margin: 0; padding: 0; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
    body { background-color: var(--bg-color); color: var(--text-main); font-family: 'Plus Jakarta Sans', sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
    .container { width: 100%; max-width: 800px; }
    .card { background: var(--card-bg); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 24px; padding: 3rem; box-shadow: 0 20px 40px rgba(0,0,0,0.4); position: relative; overflow: hidden; }
    .card::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #6366f1, #10b981, #a855f7); }
    header { margin-bottom: 2.5rem; text-align: center; }
    h1 { font-size: 2.25rem; font-weight: 700; background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
    .subtitle { color: var(--text-muted); font-size: 1rem; }
    .status-badge { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.2); color: var(--success-color); border-radius: 9999px; font-size: 0.85rem; font-weight: 600; margin-bottom: 1.5rem; }
    .status-dot { width: 8px; height: 8px; background-color: var(--success-color); border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0% { transform: scale(0.95); opacity: 0.5; } 55% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(0.95); opacity: 0.5; } }
    .form-group { margin-bottom: 1.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
    label { font-size: 0.85rem; font-weight: 600; color: #cbd5e1; letter-spacing: 0.05em; text-transform: uppercase; }
    input[type="text"], select { width: 100%; background: rgba(10,15,26,0.8); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem 1.25rem; color: var(--text-main); font-family: inherit; font-size: 1rem; outline: none; }
    input[type="text"]:focus, select:focus { border-color: var(--accent-color); box-shadow: 0 0 15px var(--accent-glow); }
    .btn { width: 100%; background: linear-gradient(135deg, var(--accent-color) 0%, var(--accent-hover) 100%); color: #fff; border: none; border-radius: 12px; padding: 1.1rem; font-size: 1.05rem; font-weight: 700; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 0.75rem; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(99,102,241,0.5); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .output-container { margin-top: 2.5rem; display: none; flex-direction: column; gap: 0.75rem; }
    .output-header { display: flex; justify-content: space-between; align-items: center; }
    .output-box { width: 100%; background: rgba(10,15,26,0.95); border: 1px solid var(--border-color); border-radius: 16px; padding: 1.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; line-height: 1.6; white-space: pre-wrap; color: #e2e8f0; min-height: 120px; max-height: 400px; overflow-y: auto; }
    .spinner { width: 20px; height: 20px; border: 3px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 1s ease-in-out infinite; display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .meta-info { font-size: 0.8rem; color: var(--text-muted); display: flex; gap: 1.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <header>
        <div class="status-badge"><div class="status-dot"></div>Gemini Connected</div>
        <h1>AI Live Tester</h1>
        <p class="subtitle">Direct interface to check model outputs — testing only</p>
      </header>
      <div class="form-group">
        <label for="prompt">Test Prompt</label>
        <input type="text" id="prompt" value="What services does VDart offer?" placeholder="Enter your prompt here...">
      </div>
      <div class="form-group">
        <label for="model">Model</label>
        <select id="model">
          <option value="gemini-2.0-flash">gemini-2.0-flash (Free tier, recommended)</option>
          <option value="gemini-2.5-flash">gemini-2.5-flash (Smarter, still fast)</option>
          <option value="gemini-2.5-pro">gemini-2.5-pro (Most capable)</option>
        </select>
      </div>
      <button id="runBtn" class="btn" onclick="runTest()">
        <span class="spinner" id="spinner"></span>
        <span id="btnText">Generate Content</span>
      </button>
      <div class="output-container" id="outputContainer">
        <div class="output-header">
          <label>API Response</label>
          <div class="meta-info">
            <div>⏱️ Latency: <span id="latency">0ms</span></div>
            <div>🤖 Model: <span id="resModel">N/A</span></div>
          </div>
        </div>
        <div class="output-box" id="outputBox"></div>
      </div>
    </div>
  </div>
  <script>
    async function runTest() {
      const prompt = document.getElementById('prompt').value.trim();
      const model = document.getElementById('model').value;
      const runBtn = document.getElementById('runBtn');
      const spinner = document.getElementById('spinner');
      const btnText = document.getElementById('btnText');
      const outputContainer = document.getElementById('outputContainer');
      const outputBox = document.getElementById('outputBox');
      if (!prompt) { alert("Please enter a prompt!"); return; }
      runBtn.disabled = true;
      spinner.style.display = 'block';
      btnText.textContent = 'Generating...';
      outputContainer.style.display = 'none';
      const startTime = Date.now();
      try {
        const response = await fetch('/testing-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model })
        });
        const data = await response.json();
        const latency = Date.now() - startTime;
        outputContainer.style.display = 'flex';
        document.getElementById('latency').textContent = latency + 'ms';
        document.getElementById('resModel').textContent = model;
        outputBox.textContent = response.ok ? data.text : "Error: " + (data.error || "Failed");
        outputBox.style.color = response.ok ? '#e2e8f0' : '#ef4444';
      } catch (err) {
        outputContainer.style.display = 'flex';
        outputBox.textContent = "Error: " + err.message;
        outputBox.style.color = '#ef4444';
      } finally {
        runBtn.disabled = false;
        spinner.style.display = 'none';
        btnText.textContent = 'Generate Content';
      }
    }
  </script>
</body>
</html>`);
});

// ── POST /testing-ai ──────────────────────────────────────────────────────────
app.post("/testing-ai", apiLimiter, preventParallelRequests, async (req, res) => {
  try {
    const {
      prompt = "What services does VDart offer?",
      model = "llama-3.3-70b-versatile"
    } = req.body;

    if (!cachedContent) {
      return res.json({ text: FALLBACK_RESPONSE });
    }

    const cached = await getCachedResponse(prompt);
    if (cached) return res.json({ text: cached });

    const websiteContent = await getWebsiteContent();

    const cleanedText = (await callAI(
      [{ role: "user", content: prompt }],
      SYSTEM_PROMPT,
      websiteContent,
      model
    )).replace(/\*/g, "");

    await setCachedResponse(prompt, cleanedText);
    res.json({ text: cleanedText });

  } catch (err) {
    console.error("Test error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TEST SCRAPE ENDPOINT (protected) ─────────────────────────────────────────
app.get("/test-scrape", adminAuth, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  const content = await scrapeWebsitePage(url);
  res.json({ length: content.length, preview: content.substring(0, 1000) });
});

// ── CLEAR CACHE ENDPOINT (protected) ─────────────────────────────────────────
app.get("/clear-cache", adminAuth, (req, res) => {
  cachedContent = null;
  lastFetched = null;
  memoryCache.clear();
  // Re-trigger background scrape immediately after clearing
  getWebsiteContent().catch(err => console.error("Re-scrape after clear failed:", err.message));
  res.json({ status: "Cache cleared. Re-scraping in background." });
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
async function shutdown() {
  console.log("Shutting down...");
  if (browserInstance) {
    await browserInstance.close();
    console.log("Browser closed.");
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // PRE-WARM: scrape fires on boot in the background.
  // By the time a real user sends a message the content is already cached.
  // The fallback response covers the rare case where someone hits the bot
  // within the first ~45 seconds of server startup.
  getWebsiteContent().catch(err => console.error("Boot scrape failed:", err.message));
});