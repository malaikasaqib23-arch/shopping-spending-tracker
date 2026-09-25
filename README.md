\# Smart Shopping \& Spending Tracker



A backend API that watches product prices on a schedule and turns pasted receipt text into structured expense records using an LLM.



\## The problem



Tracking prices on products you're thinking of buying means manually rechecking sites over and over. Logging expenses after a purchase means manually typing out every line from a receipt. Both are small, repetitive tasks that are easy to drop.



\## What it does



\- Register/log in, add a product to your watchlist

\- A scheduled background job checks the product's price every minute and logs changes to a price history

\- Recent price checks are cached for 30 seconds so repeated lookups don't re-scrape unnecessarily

\- Paste raw receipt text and an LLM (via Groq) extracts merchant, amount, category, and date into a structured expense record, with token usage logged per call



\## Concepts implemented (5+ required)



| # | Concept | Where it lives |

|---|---------|-----------------|

| 1 | API endpoints | All routes in `server.js` (Express) — see Endpoints below |

| 2 | Database | SQLite (`tracker.db`) — `users`, `products`, `price\_history`, `expenses`, `llm\_usage` tables |

| 3 | Authentication | `POST /register`, `POST /login` (bcrypt + JWT); `requireAuth` middleware protects product/expense routes |

| 4 | Background jobs/cron | `node-cron` job in `server.js`, runs every minute, checks all watched products |

| 5 | Caching | In-memory price cache with 30s TTL on `GET /products/:id/price` |

| 6 | LLM integration | `POST /expenses/parse` — Groq (`openai/gpt-oss-20b`) extracts structured data from receipt text, with input validation and a token-usage log (`llm\_usage` table) |



No swaps were used — all 6 concepts are from the primary list (5 required, one extra).



\## Non-goals



No multi-currency support, no shared/household accounts, no browser extension, no real payment processing, no real scraping target (price checks run against a built-in fake store endpoint to keep the demo self-contained and reliable — see below).



\## Tech stack



Node.js, Express, SQLite (`sqlite3`), bcrypt, jsonwebtoken, node-cron, axios, cheerio, Groq API (free tier).



\## Setup



\*\*Requirements:\*\* Node.js installed, a free Groq API key from \[console.groq.com](https://console.groq.com).



1\. Clone the repo and install dependencies:

