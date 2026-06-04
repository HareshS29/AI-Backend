const cheerio = require('cheerio');

async function scrapeWebsitePage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VDartBot/1.0)' },
      signal: AbortSignal.timeout(10000), // 10s timeout per page
    });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $(
      'nav, footer, script, style, head, noscript, iframe, header, ' +
      '[class*="cookie"], [class*="banner"], [id*="popup"], ' +
      '[class*="popup"], [class*="modal"], [aria-hidden="true"]'
    ).remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return text.substring(0, 2500);
  } catch (err) {
    console.error(`Failed to scrape ${url}:`, err.message);
    return "";
  }
}

// Scrape up to `concurrency` pages at a time
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
  return results.join('\n\n');
}

module.exports = { scrapeWithConcurrency };
