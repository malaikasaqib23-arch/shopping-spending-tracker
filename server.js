const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// --- Database setup ---
const db = new sqlite3.Database('./tracker.db');

db.run(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL
  )
`);

// --- Routes ---
app.post('/products', (req, res) => {
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  db.run(
    'INSERT INTO products (name, url) VALUES (?, ?)',
    [name, url],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'database error' });
      }
      res.status(201).json({ id: this.lastID, name, url });
    }
  );
});

app.get('/products', (req, res) => {
  db.all('SELECT * FROM products', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'database error' });
    }
    res.json(rows);
  });
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});