require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { GoogleGenAI } = require("@google/genai");
const crypto = require('crypto');

// ── REDIS SETUP (supports both local and Redis Cloud) ──────────────────────────
// For Vercel: set REDIS_URL in environment variables to your Redis Cloud URL
// Redis Cloud free tier: https://redis.io/try-free/
// Format: redis://default:<password>@<host>:<port>
const redis = require('redis');
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 3) {
        console.warn('Redis unavailable, falling back to in-memory cache');
        return false;
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

let redisAvailable = false;
redisClient.connect()
  .then(() => { redisAvailable = true; console.log('Redis connected'); })
  .catch(() => { redisAvailable = false; console.warn('Redis not available, using in-memory cache fallback'); });

// ── IN-MEMORY CACHE FALLBACK (used when Redis is unavailable) ─────────────────
// This ensures the server works on Vercel even without Redis configured yet
const memoryCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedResponse(prompt) {
  const hash = crypto.createHash('sha256').update(prompt.toLowerCase().trim()).digest('hex');
  const key = `cache:${hash}`;

  if (redisAvailable) {
    try {
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch { /* fall through to memory cache */ }
  }

  // Memory cache fallback
  const entry = memoryCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.value;
  return null;
}

async function setCachedResponse(prompt, responseText) {
  const hash = crypto.createHash('sha256').update(prompt.toLowerCase().trim()).digest('hex');
  const key = `cache:${hash}`;

  if (redisAvailable) {
    try {
      await redisClient.setEx(key, 86400, JSON.stringify(responseText));
      return;
    } catch { /* fall through to memory cache */ }
  }

  // Memory cache fallback
  memoryCache.set(key, { value: responseText, timestamp: Date.now() });

  // Prevent memory leak — limit to 500 cached entries
  if (memoryCache.size > 500) {
    const firstKey = memoryCache.keys().next().value;
    memoryCache.delete(firstKey);
  }
}

// ── BULLMQ QUEUE (only used when Redis is available) ──────────────────────────
let chatQueue = null;
let chatQueueEvents = null;
let chatWorker = null;

if (process.env.REDIS_URL) {
  const { Queue, Worker, QueueEvents } = require('bullmq');
  const redisConnection = { url: process.env.REDIS_URL };

  chatQueue = new Queue('chatQueue', { connection: redisConnection });
  chatQueueEvents = new QueueEvents('chatQueue', { connection: redisConnection });

  chatWorker = new Worker('chatQueue', async job => {
    const { messages, systemInstruction } = job.data;
    return await callGeminiDirect(messages, systemInstruction);
  }, { connection: redisConnection, concurrency: 5 });
}

// ── RATE LIMITING (in-memory, works on Vercel without Redis) ──────────────────
const rateLimit = require('express-rate-limit');
const rateLimitStore = new Map();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Uses built-in memory store — works without Redis on Vercel
});

// ── PARALLEL REQUEST PREVENTION (in-memory) ───────────────────────────────────
const activeLocks = new Map();

const preventParallelRequests = (req, res, next) => {
  const userId = req.ip;
  if (activeLocks.get(userId)) {
    return res.status(429).json({ error: 'Please wait for your previous request to finish.' });
  }
  activeLocks.set(userId, true);
  res.on('finish', () => activeLocks.delete(userId));
  next();
};

// ── APP SETUP ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── COMPANY PAGES TO SCRAPE ───────────────────────────────────────────────────
const COMPANY_PAGES = [
  // VDart Main Website
  "https://vdart.com",
  "https://vdart.com/about",
  "https://vdart.com/services",
  "https://vdart.com/careers",
  "https://vdart.com/contact",

  // VDart Digital
  "https://www.vdartdigital.com/",
  "https://www.vdartdigital.com/ai-agentic-ai-services/",
  "https://www.vdartdigital.com/data-analytics/",
  "https://www.vdartdigital.com/cloud-services/",
  "https://www.vdartdigital.com/managed-services/",
  "https://www.vdartdigital.com/cybersecurity/",
  "https://www.vdartdigital.com/digital-services/",
  "https://www.vdartdigital.com/blockchain/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/",
  "https://www.vdartdigital.com/quality-engineering/",
  "https://www.vdartdigital.com/supply-chain/#3",
  "https://www.vdartdigital.com/supply-chain/#1",
  "https://www.vdartdigital.com/supply-chain/#2",
  "https://www.vdartdigital.com/supply-chain/#4",
  "https://www.vdartdigital.com/data-analytics/ai-nlp/",
  "https://www.vdartdigital.com/data-analytics/computer-vision/",
  "https://www.vdartdigital.com/data-analytics/speech/",
  "https://www.vdartdigital.com/data-analytics/ml-mlops/",
  "https://www.vdartdigital.com/data-analytics/internet-of-things-iot/",
  "https://www.vdartdigital.com/data-analytics/data-science/",
  "https://www.vdartdigital.com/data-analytics/analytics/",
  "https://www.vdartdigital.com/data-analytics/reports/",
  "https://www.vdartdigital.com/data-analytics/big-data-data-lake/",
  "https://www.vdartdigital.com/data-analytics/data-fabric/",
  "https://www.vdartdigital.com/cloud-services/cloud-migration/",
  "https://www.vdartdigital.com/cloud-services/mainframe-modernization/",
  "https://www.vdartdigital.com/cloud-services/sap-on-cloud/",
  "https://www.vdartdigital.com/cloud-services/cloud-security/",
  "https://www.vdartdigital.com/cloud-services/cloud-finops/",
  "https://www.vdartdigital.com/cloud-services/platform-engineering/",
  "https://www.vdartdigital.com/cloud-services/cloud-managed-services/",
  "https://www.vdartdigital.com/cloud-services/cloud-advisory-sme-services/",
  "https://www.vdartdigital.com/managed-services/network-security-management/",
  "https://www.vdartdigital.com/managed-services/strategic-it-consulting-continuous-improvement",
  "https://www.vdartdigital.com/managed-services/infrastructure-data-center-management/",
  "https://www.vdartdigital.com/managed-services/end-user-support-device/",
  "https://www.vdartdigital.com/managed-services/cloud-application-management/",
  "https://www.vdartdigital.com/managed-services/it-operations-service-management/",
  "https://www.vdartdigital.com/cybersecurity/ciam/",
  "https://www.vdartdigital.com/cybersecurity/workforce-identity/",
  "https://www.vdartdigital.com/cybersecurity/security-engineering/",
  "https://www.vdartdigital.com/cybersecurity/zero-trust-architecture/",
  "https://www.vdartdigital.com/cybersecurity/governance-risk-management-compliance/",
  "https://www.vdartdigital.com/cybersecurity/cyber-defense-investigations/",
  "https://www.vdartdigital.com/cybersecurity/cyber-advisory/",
  "https://www.vdartdigital.com/cybersecurity/cyber-resilience/",
  "https://www.vdartdigital.com/digital-services/full-stack-web-development/",
  "https://www.vdartdigital.com/digital-services/mobile-app-development/",
  "https://www.vdartdigital.com/digital-services/apps-support-maintenance/",
  "https://www.vdartdigital.com/digital-services/hyperautomation/",
  "https://www.vdartdigital.com/digital-services/devsecops-automation/",
  "https://www.vdartdigital.com/digital-services/sre-chaos-engineering/",
  "https://www.vdartdigital.com/digital-services/ui-ux-front-end-development/",
  "https://www.vdartdigital.com/digital-services/quality-engineering-assurance/",
  "https://www.vdartdigital.com/digital-services/design-architecture/",
  "https://www.vdartdigital.com/digital-services/back-end-development/",
  "https://www.vdartdigital.com/blockchain/distributed-trust/",
  "https://www.vdartdigital.com/blockchain/ethereum/",
  "https://www.vdartdigital.com/blockchain/hyperledger/",
  "https://www.vdartdigital.com/blockchain/decentralized-applications-dapps/",
  "https://www.vdartdigital.com/blockchain/nft/",
  "https://www.vdartdigital.com/blockchain/ipfs/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/sap/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/salesforce/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/servicenow/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/workday/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/oracle/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/adobe/",
  "https://www.vdartdigital.com/enterprise-saas-solutions/sitecore/",
  "https://www.vdartdigital.com/quality-engineering/qa-consulting-strategy/",
  "https://www.vdartdigital.com/quality-engineering/agile-testing/",
  "https://www.vdartdigital.com/quality-engineering/independent-certification/",
  "https://www.vdartdigital.com/quality-engineering/managed-testing-services/",
  "https://www.vdartdigital.com/testsamurai/",
  "https://www.vdartdigital.com/lendsmart-ai/",
  "https://www.vdartdigital.com/idoc-lens/",
  "https://www.vdartdigital.com/vaartax/",
  "https://www.vdartdigital.com/vgo/",
  "https://www.vdartdigital.com/vengage/",
  "https://www.vdartdigital.com/v-validate/",
  "https://www.vdartdigital.com/forec-ai/",
  "https://www.vdartdigital.com/dxm/",
  "https://www.vdartdigital.com/dm/",
  "https://www.vdartdigital.com/dmps/",
  "https://www.vdartdigital.com/dzen/",
  "https://www.vdartdigital.com/case-studies/",
  "https://www.vdartdigital.com/blogs/",
  "https://www.vdartdigital.com/csr/",
  "https://www.vdartdigital.com/about-us/",
  "https://www.vdartdigital.com/awards/",
  "https://www.vdartdigital.com/careers/",
  "https://www.vdartdigital.com/partners/",
  "https://www.vdartdigital.com/contact-us/",

  // Sidd Ahmed
  "https://www.siddahmed.com/",
  "https://www.siddahmed.com/booking/",
  "https://www.siddahmed.com/journey/",
  "https://www.siddahmed.com/mentorship/",
  "https://www.siddahmed.com/books/",
  "https://www.siddahmed.com/media/",
  "https://www.siddahmed.com/blogs/",
  "https://www.siddahmed.com/career/",
  "https://www.siddahmed.com/resume-template/",
  "https://www.siddahmed.com/contact/",

  // VDart Academy
  "https://www.vdartacademy.com/",
  "https://www.vdartacademy.com/careers",
];

// ── WEBSITE SCRAPING AND CACHING ──────────────────────────────────────────────
// FIX: Removed the 5,000 character truncation that was cutting off most content.
// Each page is now individually capped at 3,000 characters to keep content
// meaningful per page while allowing the full site to be represented.
// Total content across ~100 pages = up to 300,000 chars which Gemini 1.5 Flash
// and Claude Haiku both support comfortably in their context windows.

let cachedContent = null;
let lastFetched = null;
const ONE_HOUR = 60 * 60 * 1000;

async function scrapeWebsitePage(url) {
  try {
    const res = await fetch(url, { timeout: 8000 });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("nav, footer, script, style, head, noscript, iframe").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();

    // Cap each individual page at 3,000 chars — enough for full page content
    // without letting a single page dominate the whole context
    return text.substring(0, 3000);
  } catch (err) {
    console.error(`Failed to scrape ${url}:`, err.message);
    return "";
  }
}

async function getWebsiteContent() {
  if (!cachedContent || Date.now() - lastFetched > ONE_HOUR) {
    console.log("Scraping website...");
    const pages = await Promise.all(
      COMPANY_PAGES.map(async (url) => {
        const content = await scrapeWebsitePage(url);
        return content ? `--- ${url} ---\n${content}` : "";
      })
    );
    // Filter out empty pages (failed scrapes)
    cachedContent = pages.filter(Boolean).join("\n\n");
    lastFetched = Date.now();
    console.log(`Website cached. Total content length: ${cachedContent.length} characters`);
  }
  return cachedContent;
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
// Comprehensive rules covering all chatbot behavior
const SYSTEM_PROMPT = `
You are Vee, a friendly and professional AI assistant for VDart — a global staffing and technology company.
You represent VDart, VDart Digital, VDart Academy, and Sidd Ahmed (CEO of VDart).

═══════════════════════════════════════════
KNOWLEDGE AND ANSWERING RULES
═══════════════════════════════════════════
1. Always try to answer using the provided website content first.
2. If the answer is not in the website content, you may use Google Search ONLY for topics directly related to VDart, VDart Digital, VDart Academy, or Sidd Ahmed.
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
"I'm only able to help with questions about VDart and its services. For further assistance, please contact us at csm@vdartinc.com or call (470) 323-8433."

═══════════════════════════════════════════
TONE AND PERSONALITY
═══════════════════════════════════════════
- Be warm, professional, and approachable at all times
- Greet users by saying: "Hi, I'm Vee! How can I help you with VDart today?"
- Use clear, plain language — avoid corporate jargon
- Keep all responses under 150 words unless a detailed list is specifically needed
- Never use markdown bold (asterisks like **text**) or bullet point asterisks (*) in responses
- Write in clean plain text only
- If a user writes in another language, respond in that same language

═══════════════════════════════════════════
HANDLING SPECIFIC SITUATIONS
═══════════════════════════════════════════
JOB APPLICATIONS:
- Provide details about the role or team if available
- Direct candidates to: https://vdart.com/careers or https://www.vdartdigital.com/careers/
- Never promise a job or interview

COMPLAINTS OR FRUSTRATION:
- Acknowledge the frustration calmly: "I understand your frustration and I'm sorry to hear that."
- Always escalate to: csm@vdartinc.com or (470) 323-8433
- Never argue or become defensive

RUDE OR ABUSIVE MESSAGES:
- Respond once calmly: "I'm here to help with VDart-related questions. Please keep the conversation respectful."
- If it continues, say: "I'm unable to continue this conversation. Please contact us directly at csm@vdartinc.com."

GREETINGS (hi, hello, hey):
- Respond: "Hi, I'm Vee! How can I help you with VDart today?"

FOLLOW-UP AND CLARIFICATION:
- If a question is vague, ask one short clarifying question before answering
- Example: "Are you asking about VDart staffing services or VDart Digital technology services?"

SENSITIVE TOPICS (salaries, layoffs, legal, internal matters):
- Respond: "That's something our team can better assist you with. Please reach out at csm@vdartinc.com or call (470) 323-8433."

═══════════════════════════════════════════
CONTACT DETAILS (always use these exactly)
═══════════════════════════════════════════
Email: csm@vdartinc.com
Phone: (470) 323-8433
Careers: https://vdart.com/careers
VDart Digital Careers: https://www.vdartdigital.com/careers/
`;

// ── GEMINI API CALL (testing — will be replaced with Claude Haiku for production)
async function callGeminiDirect(messages, systemInstruction) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const formattedContents = messages.map((msg) => ({
    role: (msg.role === "assistant" || msg.role === "model") ? "model" : "user",
    parts: [{ text: msg.content || msg.text || "" }]
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: formattedContents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// ── CHAT ENDPOINT ─────────────────────────────────────────────────────────────
app.post("/chat", apiLimiter, preventParallelRequests, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "No message provided" });

    // Cache lookup
    const cached = await getCachedResponse(message);
    if (cached) return res.json({ reply: cached });

    const websiteContent = await getWebsiteContent();

    // Keep last 6 messages of history (up from 4 — better conversation context)
    const trimmedHistory = history.slice(-6);

    const messages = [
      ...trimmedHistory,
      {
        role: "user",
        content: `Website content:\n${websiteContent}\n\nUser question: ${message}`
      }
    ];

    let reply;

    // Use queue if Redis available, otherwise call directly
    if (chatQueue && chatQueueEvents) {
      const job = await chatQueue.add('generateChat', {
        messages,
        systemInstruction: SYSTEM_PROMPT
      }, {
        removeOnComplete: true,
        removeOnFail: true,
        timeout: 15000
      });
      reply = await job.waitUntilFinished(chatQueueEvents);
    } else {
      reply = await callGeminiDirect(messages, SYSTEM_PROMPT);
    }

    const cleanedReply = (reply || "").replace(/\*/g, "");
    await setCachedResponse(message, cleanedReply);
    res.json({ reply: cleanedReply });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── TEST ROUTE ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Server is running" });
});

// ── TESTING UI ────────────────────────────────────────────────────────────────
app.get("/testing-ai", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini API Test Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: rgba(17, 24, 39, 0.75);
      --border-color: rgba(255, 255, 255, 0.08);
      --accent-color: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.4);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --success-color: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
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
        <div class="status-badge"><div class="status-dot"></div>Gemini SDK Connected</div>
        <h1>Gemini API Live Tester</h1>
        <p class="subtitle">Direct interface to check model outputs — testing only</p>
      </header>
      <div class="form-group">
        <label for="prompt">Test Prompt</label>
        <input type="text" id="prompt" value="What services does VDart offer?" placeholder="Enter your prompt here...">
      </div>
      <div class="form-group">
        <label for="model">Model</label>
        <select id="model">
          <option value="gemini-2.5-flash">gemini-2.5-flash (Recommended)</option>
          <option value="gemini-1.5-flash">gemini-1.5-flash</option>
          <option value="gemini-2.5-pro">gemini-2.5-pro</option>
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
    const { prompt = "What services does VDart offer?", model = "gemini-2.5-flash" } = req.body;

    const cached = await getCachedResponse(prompt);
    if (cached) return res.json({ text: cached });

    const websiteContent = await getWebsiteContent();

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model,
      contents: `Website content:\n${websiteContent}\n\nUser question: ${prompt}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }]
      }
    });

    const cleanedText = (response.text || "").replace(/\*/g, "");
    await setCachedResponse(prompt, cleanedText);
    res.json({ text: cleanedText });

  } catch (err) {
    console.error("SDK Test Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});