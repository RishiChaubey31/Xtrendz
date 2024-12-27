// File: api/scrape.js
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
require("dotenv").config();

const mongoUri = process.env.MONGO_URI;
const TWITTER_USERNAME = process.env.TWITTER_USERNAME;
const TWITTER_PASSWORD = process.env.TWITTER_PASSWORD;

// Helper function for delays
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to safely execute each step
async function executeSafely(stepName, func) {
  try {
    const result = await func();
    console.log(`✓ ${stepName} completed successfully`);
    return result;
  } catch (error) {
    console.error(`✗ ${stepName} failed:`, error.message);
    throw {
      step: stepName,
      error: error.message,
      stack: error.stack
    };
  }
}

// Helper function to wait for and find element with multiple possible selectors
async function findElementWithRetry(driver, selectors, timeout = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      try {
        const element = await driver.findElement(selector);
        if (element) return element;
      } catch (e) {
        continue;
      }
    }
    await delay(500);
  }
  throw new Error(`Could not find element with selectors: ${JSON.stringify(selectors)}`);
}

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
  let driver;
  try {
    // Configure Chrome options
    const options = new chrome.Options();
    options.addArguments(
      "--headless",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();

    console.log("Starting login process...");
    await driver.get("https://x.com/i/flow/login");
    await delay(3000);

    // Username field
    console.log("Looking for username field...");
    const usernameSelectors = [
      By.css('input[autocomplete="username"]'),
      By.css('input[name="text"]'),
      By.css('input[data-testid="text-input-email"]'),
      By.xpath("//input[@autocomplete='username']"),
      By.xpath("//input[@name='text']"),
    ];

    const usernameField = await findElementWithRetry(driver, usernameSelectors);
    console.log("Found username field, entering username...");
    await usernameField.sendKeys(TWITTER_USERNAME);
    await delay(1000);

    // Next button
    console.log("Looking for next button...");
    const nextButtonSelectors = [
      By.xpath("//div[@role='button']//span[text()='Next']"),
      By.css('[data-testid="auth-next"]'),
      By.xpath("//span[contains(text(), 'Next')]/.."),
    ];

    const nextButton = await findElementWithRetry(driver, nextButtonSelectors);
    console.log("Found next button, clicking...");
    await nextButton.click();
    await delay(2000);

    // Password field
    console.log("Looking for password field...");
    const passwordField = await driver.wait(
      until.elementLocated(By.css('input[type="password"]')),
      10000
    );
    console.log("Found password field, entering password...");
    await passwordField.sendKeys(TWITTER_PASSWORD);
    await delay(1000);

    // Login button
    console.log("Looking for login button...");
    const loginButtonSelectors = [
      By.xpath("//div[@role='button']//span[text()='Log in']"),
      By.css('[data-testid="LoginButton"]'),
      By.xpath("//span[contains(text(), 'Log in')]/.."),
    ];

    const loginButton = await findElementWithRetry(driver, loginButtonSelectors);
    console.log("Found login button, clicking...");
    await loginButton.click();
    await delay(5000);

    // Navigate to Explore page
    console.log("Navigating to explore page...");
    await driver.get("https://x.com/explore");
    await delay(3000);

    // Wait for trends
    console.log("Waiting for trends...");
    const trendSelectors = [
      By.css('[data-testid="trend"]'),
      By.css('article[role="article"]'),
      By.xpath("//div[contains(@data-testid, 'trend')]"),
    ];

    const trend = await findElementWithRetry(driver, trendSelectors, 30000);
    const trends = await driver.findElements(trendSelectors[0]);

    const trendTexts = [];
    for (const trend of trends.slice(0, 5)) {
      try {
        const trendText = await trend.getText();
        if (trendText) {
          trendTexts.push(trendText);
        }
      } catch (err) {
        console.warn("Failed to extract trend text:", err);
      }
    }

    if (trendTexts.length === 0) {
      throw new Error("No trends were found");
    }

    console.log("Successfully scraped trends:", trendTexts);
    return {
      trends: trendTexts,
      timestamp: new Date(),
      id: crypto.randomUUID(),
    };
  } catch (error) {
    console.error("Scraping error:", error);
    throw error;
  } finally {
    if (driver) {
      await driver.quit();
    }
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
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-Requested-With, Content-Type, Accept'
  );

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Verify environment variables
    await executeSafely('Environment Check', () => {
      const required = ['MONGO_URI', 'TWITTER_USERNAME', 'TWITTER_PASSWORD'];
      const missing = required.filter(key => !process.env[key]);
      if (missing.length > 0) {
        throw new Error(`Missing environment variables: ${missing.join(', ')}`);
      }
      return true;
    });

    const clientIP = getClientIP(req);
    const userAgent = req.headers["user-agent"];
    
    const trendsData = await executeSafely('Scraping Trends', async () => {
      return await scrapeTrendingTopics();
    });
    
    const savedData = await executeSafely('Saving to MongoDB', async () => {
      return await saveTrendsToMongo(trendsData, clientIP, userAgent);
    });
    
    res.status(200).json(savedData);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({
      status: 'error',
      failedStep: error.step || 'unknown',
      error: error.message,
      timestamp: new Date().toISOString(),
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};