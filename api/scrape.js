const { kv } = require('@vercel/kv');
const { scrapeWithConcurrency } = require('../lib/scraper');
const { COMPANY_PAGES } = require('../lib/prompt');

// This endpoint is called by Vercel Cron every hour.
// It scrapes all company pages and saves the result to Vercel KV.
// Protected by a secret token so it can't be triggered by anyone externally.

export default async function handler(req, res) {
  // Only allow GET (cron) or POST with valid admin token
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    console.log(`Starting scrape of ${COMPANY_PAGES.length} pages...`);
    const content = await scrapeWithConcurrency(COMPANY_PAGES, 4);

    if (!content) {
      return res.status(500).json({ error: 'Scrape returned empty content' });
    }

    // Store in KV with 2 hour TTL (cron runs every hour so always fresh)
    await kv.set('website_content', content, { ex: 7200 });
    await kv.set('website_scraped_at', new Date().toISOString(), { ex: 7200 });

    console.log(`Scrape complete. Content length: ${content.length} chars`);
    return res.status(200).json({
      success: true,
      pages: COMPANY_PAGES.length,
      contentLength: content.length,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Scrape error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
