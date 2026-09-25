const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CACHE_TTL_MS = 30 * 1000;

// --- Database setup ---
const db = new sqlite3.Database('./tracker.db');

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    last_price REAL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    checked_at TEXT NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    merchant TEXT,
    amount REAL,
    category TEXT,
    expense_date TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing or invalid authorization header' });
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    req.userId = decoded.userId;
    next();
  });
}

// --- Auth routes ---
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'email already registered' });
          }
          return res.status(500).json({ error: 'database error' });
        }
        res.status(201).json({ id: this.lastID, email });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: 'database error' });
    if (!user) return res.status(401).json({ error: 'invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'invalid email or password' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  });
});

// --- Fake store ---
const fakeStorePrices = {};

app.get('/fake-store/:id', (req, res) => {
  const id = req.params.id;
  if (!(id in fakeStorePrices)) {
    fakeStorePrices[id] = Math.floor(Math.random() * 50) + 50;
  }
  if (Math.random() < 0.3) {
    const change = Math.floor(Math.random() * 10) - 5;
    fakeStorePrices[id] = Math.max(10, fakeStorePrices[id] + change);
  }
  res.send(`
    <html>
      <body>
        <h1>Fake Product ${id}</h1>
        <span class="price">$${fakeStorePrices[id]}</span>
      </body>
    </html>
  `);
});

// --- Scraper ---
async function scrapePrice(url) {
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  const priceText = $('.price').first().text().replace('$', '').trim();
  return parseFloat(priceText);
}

async function checkProductPrice(product) {
  try {
    const price = await scrapePrice(product.url);
    if (isNaN(price)) {
      console.log(`[${new Date().toISOString()}] Product ${product.id}: could not parse price`);
      return;
    }
    if (product.last_price === null || price !== product.last_price) {
      db.run(
        'INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)',
        [product.id, price, new Date().toISOString()]
      );
      db.run('UPDATE products SET last_price = ? WHERE id = ?', [price, product.id]);
      console.log(`[${new Date().toISOString()}] Product ${product.id}: price changed to $${price}`);
    } else {
      console.log(`[${new Date().toISOString()}] Product ${product.id}: no change ($${price})`);
    }
  } catch (err) {
    console.log(`[${new Date().toISOString()}] Product ${product.id}: check failed - ${err.message}`);
  }
}

cron.schedule('* * * * *', () => {
  db.all('SELECT * FROM products', [], (err, products) => {
    if (err || !products.length) return;
    products.forEach(checkProductPrice);
  });
});

// --- Price cache ---
const priceCache = {};

// --- Product routes ---
app.post('/products', requireAuth, (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  db.run(
    'INSERT INTO products (name, url, user_id) VALUES (?, ?, ?)',
    [name, url, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'database error' });
      res.status(201).json({ id: this.lastID, name, url });
    }
  );
});

app.get('/products', requireAuth, (req, res) => {
  db.all('SELECT * FROM products WHERE user_id = ?', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'database error' });
    res.json(rows);
  });
});

app.get('/products/:id/history', requireAuth, (req, res) => {
  db.all(
    'SELECT * FROM price_history WHERE product_id = ? ORDER BY checked_at DESC',
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'database error' });
      res.json(rows);
    }
  );
});

app.get('/products/:id/price', requireAuth, (req, res) => {
  const productId = req.params.id;
  db.get(
    'SELECT * FROM products WHERE id = ? AND user_id = ?',
    [productId, req.userId],
    async (err, product) => {
      if (err) return res.status(500).json({ error: 'database error' });
      if (!product) return res.status(404).json({ error: 'product not found' });

      const cached = priceCache[productId];
      const now = Date.now();

      if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
        console.log(`[${new Date().toISOString()}] Product ${productId}: cache HIT`);
        return res.json({ price: cached.price, source: 'cache', cachedAgeMs: now - cached.cachedAt });
      }

      try {
        console.log(`[${new Date().toISOString()}] Product ${productId}: cache MISS - scraping`);
        const price = await scrapePrice(product.url);
        priceCache[productId] = { price, cachedAt: now };
        res.json({ price, source: 'live' });
      } catch (err) {
        res.status(500).json({ error: 'failed to fetch price' });
      }
    }
  );
});

// --- LLM: receipt parsing ---
async function parseReceiptWithGroq(receiptText) {
  const systemPrompt = `You extract structured data from receipt text. Respond with ONLY a JSON object, no other text, no markdown fences. The JSON must have exactly these fields: "merchant" (string), "amount" (number, the total), "category" (one of: "groceries", "dining", "transport", "shopping", "utilities", "entertainment", "other"), "date" (string, YYYY-MM-DD format, use today if not found). If a field can't be determined, use null for merchant/date or 0 for amount.`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-20b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: receiptText }
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      reasoning_format: 'hidden'
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const content = response.data.choices[0].message.content;
  const usage = response.data.usage;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error('LLM did not return valid JSON');
  }

  return { parsed, usage };
}

app.post('/expenses/parse', requireAuth, async (req, res) => {
  const { receiptText } = req.body;

  if (!receiptText || typeof receiptText !== 'string' || receiptText.trim().length === 0) {
    return res.status(400).json({ error: 'receiptText is required and must be a non-empty string' });
  }

  if (receiptText.length > 3000) {
    return res.status(400).json({ error: 'receiptText too long (max 3000 characters)' });
  }

  try {
    const { parsed, usage } = await parseReceiptWithGroq(receiptText);

    const validCategories = ['groceries', 'dining', 'transport', 'shopping', 'utilities', 'entertainment', 'other'];
    const merchant = typeof parsed.merchant === 'string' ? parsed.merchant : null;
    const amount = typeof parsed.amount === 'number' ? parsed.amount : 0;
    const category = validCategories.includes(parsed.category) ? parsed.category : 'other';
    const date = typeof parsed.date === 'string' ? parsed.date : new Date().toISOString().split('T')[0];

    db.run(
      'INSERT INTO expenses (user_id, merchant, amount, category, expense_date, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.userId, merchant, amount, category, date, receiptText, new Date().toISOString()],
      function (err) {
        if (err) return res.status(500).json({ error: 'database error' });

        db.run(
          'INSERT INTO llm_usage (user_id, endpoint, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [req.userId, '/expenses/parse', usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, new Date().toISOString()]
        );

        res.status(201).json({
          id: this.lastID,
          merchant,
          amount,
          category,
          date,
          tokensUsed: usage.total_tokens
        });
      }
    );
  } catch (err) {
    console.log(`[${new Date().toISOString()}] Receipt parse failed: ${err.message}`);
    res.status(500).json({ error: 'failed to parse receipt' });
  }
});

app.get('/expenses', requireAuth, (req, res) => {
  db.all('SELECT * FROM expenses WHERE user_id = ? ORDER BY created_at DESC', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'database error' });
    res.json(rows);
  });
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});