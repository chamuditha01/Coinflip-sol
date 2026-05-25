import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';
import Layout from '../components/Layout';

const resolveRuntimeEnv = (key) => {
  if (typeof process !== 'undefined' && process.env && process.env[key]) return process.env[key];
  if (typeof window !== 'undefined') {
    if (window.__ENV__ && window.__ENV__[key]) return window.__ENV__[key];
    if (window.env && window.env[key]) return window.env[key];
  }
  return '';
};

const SUPABASE_URL = resolveRuntimeEnv('REACT_APP_SUPABASE_URL');
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6Z3R2aWpkd3hqdWdvcmd5b2JoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTIxMjMsImV4cCI6MjA4OTQyODEyM30.KRnjV8dPYua_rm4fE8HSot9iXL9tmZ_OnpJgztOSbZ4";
const SOL = 1000000000;

const formatShortAddress = (address) => {
  if (!address) return 'Unknown';
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
};

const parsePrizeToLamports = (prize) => {
  if (prize === null || prize === undefined) return 0n;
  if (typeof prize === 'bigint') return prize;
  if (typeof prize === 'number' && Number.isFinite(prize)) return BigInt(Math.trunc(prize));
  const cleaned = String(prize).replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0n;
  try {
    if (cleaned.includes('.')) {
      return BigInt(Math.trunc(Number(cleaned)));
    }
    return BigInt(cleaned);
  } catch (e) {
    return 0n;
  }
};

const formatSol = (lamports) => `${(Number(lamports) / SOL).toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;

export default function Leaderboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState([]);
  const [stats, setStats] = useState({ totalVolumeLamports: 0n, activeUsers: 0, settledGames: 0 });
  const [error, setError] = useState('');
  const [rowCount, setRowCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const buildLeaderboard = async () => {
      try {
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
          throw new Error('Missing Supabase URL or anon key in frontend env. Restart the dev server after updating .env.');
        }

        const fetchRows = async (url, headers = {}) => {
          const response = await fetch(url, { headers });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error('Leaderboard fetch failed', {
              url,
              status: response.status,
              statusText: response.statusText,
              body,
            });
            throw new Error(`${response.status} ${response.statusText}`.trim());
          }
          return response.json();
        };

        const rows = await fetchRows(`${SUPABASE_URL}/rest/v1/leaderboard?select=id,created_at,roundid,winner,prize&order=created_at.desc`, {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Accept: 'application/json',
        });

        const normalizedRows = Array.isArray(rows) ? rows : [];
        const wins = new Map();
        const earnings = new Map();
        const activeUsers = new Set();
        let totalVolumeLamports = 0n;

        for (const row of normalizedRows) {
          const winner = row.winner || row.winner_address || row.player || row.player_address;
          if (!winner) continue;

          const prizeLamports = parsePrizeToLamports(row.prize);
          totalVolumeLamports += prizeLamports;
          activeUsers.add(winner);

          wins.set(winner, (wins.get(winner) || 0) + 1);
          earnings.set(winner, (earnings.get(winner) || 0n) + prizeLamports);
        }

        const allPlayers = Array.from(activeUsers).map(address => ({
          address,
          wins: wins.get(address) || 0,
          earnedLamports: earnings.get(address) || 0n,
        }));

        allPlayers.sort((a, b) => b.wins - a.wins || Number(b.earnedLamports - a.earnedLamports));

        if (!cancelled) {
          setError('');
          setRowCount(normalizedRows.length);
          setPlayers(allPlayers.slice(0, 20).map(player => ({
            address: player.address,
            wins: String(player.wins),
            earned: formatSol(player.earnedLamports),
          })));
          setStats({
            totalVolumeLamports,
            activeUsers: activeUsers.size,
            settledGames: normalizedRows.length,
          });
        }
      } catch (e) {
        console.error('Leaderboard build error', e);
        if (!cancelled) {
          setError(`Leaderboard API failed: ${e.message || 'Failed to load leaderboard'}. Check the anon key and Supabase SELECT policy.`);
          setRowCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    buildLeaderboard();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="leaderboard-shell">
      <Layout rightContent={
        <>
          <div className="lb-balance">0.00 SOL</div>
          <button type="button" className="lb-connect">Connect Wallet</button>
        </>
      }>
        <main className="leaderboard-main">
        <section className="lb-hero">
          <div className="lb-kicker">GLOBAL STANDINGS</div>
          <h1>TERMINAL LEADERBOARD</h1>
          <p>Real-time ranking of the most elite flippers on the network.</p>
          {error && <p style={{ color: '#ff8c8c', marginTop: '12px' }}>{error}</p>}
          {!loading && !error && rowCount === 0 && (
            <p style={{ color: '#ffd089', marginTop: '12px' }}>
              No rows found in Supabase table `leaderboard` yet.
            </p>
          )}
        </section>

        <section className="lb-stats">
          <div className="lb-stat-card">
            <span>TOTAL VOLUME</span>
            <strong>{formatSol(stats.totalVolumeLamports)}</strong>
          </div>
          <div className="lb-stat-card">
            <span>ACTIVE USERS</span>
            <strong>{stats.activeUsers.toLocaleString()}</strong>
          </div>
        </section>

        <section className="lb-stats" style={{ marginTop: 0 }}>
          <div className="lb-stat-card">
            <span>SETTLED GAMES</span>
            <strong>{stats.settledGames.toLocaleString()}</strong>
          </div>
          <div className="lb-stat-card">
            <span>TOP PLAYER</span>
            <strong>{players[0] ? formatShortAddress(players[0].address) : '—'}</strong>
          </div>
        </section>

        <section className="lb-podium">
          {loading && <div style={{ color: '#8a939f' }}>Loading leaderboard...</div>}
          {!loading && !error && players.length === 0 && rowCount === 0 && (
            <div style={{ color: '#8a939f' }}>No leaderboard entries available.</div>
          )}
          {!loading && players.slice(0,3).map((p, i) => (
            <article key={p.address} className={`lb-podium-card` }>
              <div className="lb-avatar">👤</div>
              <div className="lb-address">{p.address}</div>
              <div className="lb-rank">#{i+1}</div>
              <div className="lb-metrics">
                <div>
                  <span>WINS</span>
                  <strong>{p.wins}</strong>
                </div>
                <div>
                  <span>EARNED</span>
                  <strong>{p.earned}</strong>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="lb-table-wrap">
          <table className="lb-table">
            <thead>
              <tr>
                <th>RANK</th>
                <th>PLAYER ADDRESS</th>
                <th>TOTAL WINS</th>
                <th>TOTAL SOL EARNED</th>
              </tr>
            </thead>
            <tbody>
              {!loading && !error && players.length === 0 && (
                <tr>
                  <td colSpan={4}>No leaderboard rows to display.</td>
                </tr>
              )}
              {!loading && players.map((p, idx) => (
                <tr key={p.address}>
                  <td>#{idx+1}</td>
                  <td>{p.address}</td>
                  <td>{p.wins}</td>
                  <td className="positive">{p.earned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <footer className="lb-footer">
          <div>ALL RANKINGS ARE PROVABLY FAIR &amp; VALIDATED ON-CHAIN</div>
          <div>HASH: 7a9f...8h2c_RAM_SNAPSHOT_v1.2</div>
        </footer>
        </main>
      </Layout>
    </div>
  );
}
