const got = require('@/utils/got');
const cheerio = require('cheerio');
const { parseDate } = require('@/utils/parse-date');
const { art } = require('@/utils/render');
const path = require('path');
const { puppeteerGet } = require('./utils');

async function getPuppeteerPage(url, browser) {
    const page = await browser.newPage();

    try {
        // Add stealth settings
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            Referer: 'https://www.google.com/',
        });

        // Disable request interception for now since it might be causing issues
        const response = await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 30000,
        });

        if (response.status() === 403) {
            throw new Error('403 Forbidden - Cloudflare detected');
        }

        // Replace page.waitForTimeout with a Promise-based delay
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const content = await page.content();
        return content;
    } catch (error) {
        process.stderr.write(`Puppeteer error: ${error}\n`);
        throw error;
    } finally {
        await page.close().catch(() => {});
    }
}

async function fetchWithRetry(url, browser, maxRetries = 3) {
    let lastError;

    // First attempt without delay
    try {
        return await getPuppeteerPage(url, browser);
    } catch (error) {
        lastError = error;
        process.stderr.write(`Initial attempt failed: ${error}\n`);
    }

    // Create array of retry promises
    const retryPromises = Array(maxRetries - 1)
        .fill()
        .map(async (_, index) => {
            const delay = 2000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            try {
                return await getPuppeteerPage(url, browser);
            } catch (error) {
                lastError = error;
                process.stderr.write(`Retry ${index + 1} failed: ${error}\n`);
                return null;
            }
        });

    // Wait for all retries to complete
    const results = await Promise.all(retryPromises);
    const successfulResult = results.find((result) => result !== null);

    if (successfulResult) {
        return successfulResult;
    }

    throw lastError;
}

module.exports = async (ctx) => {
    const baseUrl = 'https://www.pixwox.com';
    const { id } = ctx.params;
    const url = `${baseUrl}/profile/${id}/`;

    const browser = await (process.env.VERCEL
        ? (async () => {
              const chromium = require('@sparticuz/chromium');
              const puppeteer = require('puppeteer-core');
              return puppeteer.launch({
                  args: [
                      ...chromium.args,
                      '--disable-web-security',
                      '--no-sandbox',
                      '--disable-setuid-sandbox',
                      '--disable-dev-shm-usage',
                      '--disable-features=IsolateOrigins,site-per-process',
                      '--disable-features=IsolateOrigins',
                      '--disable-site-isolation-trials',
                  ],
                  defaultViewport: {
                      width: 1920,
                      height: 1080,
                  },
                  executablePath: await chromium.executablePath(),
                  headless: true,
                  ignoreHTTPSErrors: true,
              });
          })()
        : require('@/utils/puppeteer')());

    let html;
    const usePuppeteer = true;

    try {
        html = await fetchWithRetry(url, browser);
    } catch (error) {
        process.stderr.write(`All retries failed: ${error}\n`);
        throw error;
    }

    const $ = cheerio.load(html);
    const profileName = $('h1.fullname').text();
    const userId = $('input[name=userid]').attr('value');

    let posts;
    if (usePuppeteer) {
        const data = await puppeteerGet(`${baseUrl}/api/posts?userid=${userId}`, browser);
        posts = data.posts;
    } else {
        const { data } = await got(`${baseUrl}/api/posts`, {
            headers: {
                accept: 'application/json',
            },
            searchParams: {
                userid: userId,
            },
        });
        posts = data.posts;
    }

    const list = await Promise.all(
        posts.items.map(async (item) => {
            const { shortcode, type, sum_pure, time } = item;
            const link = `${baseUrl}/post/${shortcode}/`;
            if (type === 'img_multi') {
                item.images = await ctx.cache.tryGet(link, async () => {
                    let html;
                    if (usePuppeteer) {
                        html = await getPuppeteerPage(link, browser);
                    } else {
                        const { data } = await got(link);
                        html = data;
                    }
                    const $ = cheerio.load(html);
                    return [
                        ...new Set(
                            $('.post_slide a')
                                .toArray()
                                .map((a) => {
                                    a = $(a);
                                    return {
                                        ori: a.attr('href'),
                                        url: a.find('img').attr('data-src'),
                                    };
                                })
                        ),
                    ];
                });
            }

            return {
                title: sum_pure,
                description: art(path.join(__dirname, 'templates/desc.art'), { item }),
                link,
                pubDate: parseDate(time, 'X'),
            };
        })
    );
    await browser.close();

    ctx.state.data = {
        title: `${profileName} (@${id}) - Picnob`,
        description: $('.info .sum').text(),
        link: url,
        image: $('.ava .pic img').attr('src'),
        item: list,
    };
};
