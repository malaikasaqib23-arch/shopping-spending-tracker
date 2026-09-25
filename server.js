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

// --- Fake store (simulates a real product page with a fluctuating price) ---
const fakeStorePrices = {}; // in-memory: { productKey: currentPrice }

app.get('/fake-store/:id', (req, res) => {
  const id = req.params.id;

  if (!(id in fakeStorePrices)) {
    fakeStorePrices[id] = Math.floor(Math.random() * 50) + 50; // start between 50-99
  }

  // 30% chance the price shifts a bit on each visit, to simulate real changes
  if (Math.random() < 0.3) {
    const change = Math.floor(Math.random() * 10) - 5; // -5 to +4
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
async function checkProductPrice(product) {
  try {
    const response = await axios.get(product.url);
    const $ = cheerio.load(response.data);
    const priceText = $('.price').first().text().replace('$', '').trim();
    const price = parseFloat(priceText);

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

// --- Cron job: check all products every minute ---
cron.schedule('* * * * *', () => {
  db.all('SELECT * FROM products', [], (err, products) => {
    if (err || !products.length) return;
    products.forEach(checkProductPrice);
  });
});

// --- Product routes (protected) ---
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

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});