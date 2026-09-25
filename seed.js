const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./tracker.db');

// Ensure schema exists (safe to run before the server has ever started)
db.serialize(() => {
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

  const demoEmail = 'demo@example.com';
  const demoPassword = 'demo1234';

  bcrypt.hash(demoPassword, 10, (err, hash) => {
    if (err) {
      console.error('Failed to hash password:', err);
      return;
    }

    db.run(
      'INSERT OR IGNORE INTO users (email, password_hash) VALUES (?, ?)',
      [demoEmail, hash],
      function (err) {
        if (err) {
          console.error('Failed to insert demo user:', err);
          return;
        }

        // Get the user's id whether just inserted or already existing
        db.get('SELECT id FROM users WHERE email = ?', [demoEmail], (err, user) => {
          if (err || !user) {
            console.error('Could not find demo user after insert');
            return;
          }

          const userId = user.id;

          db.run(
            'INSERT INTO products (name, url, user_id, last_price) VALUES (?, ?, ?, ?)',
            ['Demo Wireless Mouse', 'http://localhost:3000/fake-store/1', userId, 75],
            function (err) {
              if (err) return console.error(err);
              const productId = this.lastID;

              db.run(
                'INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)',
                [productId, 80, new Date(Date.now() - 3600000).toISOString()]
              );
              db.run(
                'INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)',
                [productId, 75, new Date().toISOString()]
              );

              console.log(`Seeded product id ${productId} with price history`);
            }
          );

          db.run(
            'INSERT INTO expenses (user_id, merchant, amount, category, expense_date, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              userId,
              'Demo Grocery Store',
              24.5,
              'groceries',
              new Date().toISOString().split('T')[0],
              'Demo Grocery Store\nMilk 3.50\nBread 2.20\nEggs 4.00\nTotal: 24.50',
              new Date().toISOString()
            ],
            function (err) {
              if (err) return console.error(err);
              console.log(`Seeded demo expense id ${this.lastID}`);
            }
          );

          console.log('---');
          console.log('Seed complete. Demo login:');
          console.log(`  email: ${demoEmail}`);
          console.log(`  password: ${demoPassword}`);
        });
      }
    );
  });
});