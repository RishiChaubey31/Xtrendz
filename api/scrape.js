// File: api/scrape.js
const chromium = require('chrome-aws-lambda');
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
require("dotenv").config();

const mongoUri = process.env.MONGO_URI;
const TWITTER_USERNAME = process.env.TWITTER_USERNAME;
const TWITTER_PASSWORD = process.env.TWITTER_PASSWORD;

// Helper function for delays
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Get client IP address
function getClientIP(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress
  );
}

async function scrapeTrendingTopics() {
  let browser = null;
  let page = null;
  
  try {
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to login page
    console.log("Navigating to login page...");
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle0' });
    await delay(2000);

    // Type username
    console.log("Entering username...");
    await page.waitForSelector('input[autocomplete="username"]');
    await page.type('input[autocomplete="username"]', TWITTER_USERNAME);
    
    // Click next
    await page.click('[role="button"]:has-text("Next")');
    await delay(2000);

    // Type password
    console.log("Entering password...");
    await page.waitForSelector('input[type="password"]');
    await page.type('input[type="password"]', TWITTER_PASSWORD);
    
    // Click login
    await page.click('[role="button"]:has-text("Log in")');
    await delay(3000);

    // Navigate to explore page
    console.log("Navigating to explore page...");
    await page.goto('https://x.com/explore', { waitUntil: 'networkidle0' });
    await delay(2000);

    // Get trends
    console.log("Extracting trends...");
    const trends = await page.$$eval('[data-testid="trend"]', elements => 
      elements.slice(0, 5).map(element => element.textContent)
    );

    if (trends.length === 0) {
      throw new Error("No trends were found");
    }

    console.log("Successfully scraped trends:", trends);
    return {
      trends,
      timestamp: new Date(),
      id: crypto.randomUUID(),
    };
  } catch (error) {
    console.error("Scraping error:", error);
    throw error;
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

async function saveTrendsToMongo(trendsData, clientIP, userAgent) {
  let client;
  try {
    client = await MongoClient.connect(mongoUri);
    const db = client.db("twitter_trends");
    const collection = db.collection("trends");

    const dataWithIP = {
      ...trendsData,
      clientIP,
      userAgent,
      accessTimestamp: new Date(),
    };

    await collection.insertOne(dataWithIP);
    return dataWithIP;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

// Export the serverless function handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-Requested-With, Content-Type, Accept'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Verify environment variables
    const required = ['MONGO_URI', 'TWITTER_USERNAME', 'TWITTER_PASSWORD'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }

    const clientIP = getClientIP(req);
    const userAgent = req.headers["user-agent"];
    
    console.log("Starting scraping process...");
    const trendsData = await scrapeTrendingTopics();
    
    console.log("Saving to MongoDB...");
    const savedData = await saveTrendsToMongo(trendsData, clientIP, userAgent);
    
    res.status(200).json(savedData);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};