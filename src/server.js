require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ── WEBSITE PAGES TO SCRAPE ──────────────────────────────
const COMPANY_PAGES = [
  "https://yourcompany.com",
  "https://yourcompany.com/jobs",
  "https://yourcompany.com/services",
  "https://yourcompany.com/about",
  "https://yourcompany.com/contact",
  "https://yourcompany.com/faq",
];

// ── CACHE ────────────────────────────────────────────────
let cachedContent = null;
let lastFetched = null;
const ONE_HOUR = 60 * 60 * 1000;

async function scrapeWebsitePage(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    $("nav, footer, script, style, head").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
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
        return `--- ${url} ---\n${content}`;
      })
    );
    cachedContent = pages.join("\n\n");
    lastFetched = Date.now();
    console.log("Website content cached.");
  }
  return cachedContent;
}

// ── SYSTEM PROMPT ────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a helpful assistant for a staffing company.
You will be given content scraped from the company website.
Answer the user's question using ONLY that content.

Rules:
- Only answer based on the website content provided
- If the answer is not in the content, say exactly:
  "I don't have that information. Please contact us at [email] or call [phone number]."
- Never make up information
- Be friendly, clear and concise
- Keep responses under 150 words
`;

// ── MOCK AI RESPONSE (used until API key is ready) ───────
function mockAIResponse(message) {
  return `This is a mock response to: "${message}". The real AI will answer here once the API key is connected.`;
}

// ── CHAT ENDPOINT ────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    const websiteContent = await getWebsiteContent();

    // Build conversation history
    const messages = [
      ...history,
      {
        role: "user",
        content: `Website content:\n${websiteContent}\n\nUser question: ${message}`
      }
    ];

    // ── SWAP THIS OUT WHEN API KEY IS READY ──
    const reply = mockAIResponse(message);

    res.json({ reply });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── TEST ROUTE ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Server is running" });
});

// ── START SERVER ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});s