require('dotenv').config();

const express = require('express');
const cors = require('cors');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/leaderboard', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend .env (or REACT_APP_ fallbacks)',
      });
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/leaderboard?select=id,created_at,roundid,winner,prize&order=created_at.desc`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
        },
      }
    );

    const body = await response.text();
    if (!response.ok) {
      return res.status(response.status).send(body);
    }

    let rows = [];
    try {
      rows = JSON.parse(body);
    } catch (e) {
      rows = [];
    }

    return res.json(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.error('Leaderboard proxy error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load leaderboard' });
  }
});

app.get('/seed/:gameId', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend .env (or REACT_APP_ fallbacks)',
      });
    }

    const { gameId } = req.params;
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/game_seeds?select=seed_hex&game_id=eq.${encodeURIComponent(gameId)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
        },
      }
    );

    const body = await response.text();
    if (!response.ok) {
      return res.status(response.status).send(body);
    }

    let rows = [];
    try {
      rows = JSON.parse(body);
    } catch (e) {
      rows = [];
    }

    const seedHex = Array.isArray(rows) && rows[0] ? rows[0].seed_hex : null;
    return res.json({ gameId, seedHex });
  } catch (error) {
    console.error('Seed proxy error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load seed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Leaderboard API listening on http://localhost:${PORT}`);
});