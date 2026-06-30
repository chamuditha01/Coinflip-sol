/**
 * SOLFLIP — Frontend
 *
 * Responsibilities:
 *   1. CreateGame  — player_one signs & funds the PDA
 *   2. JoinGame    — player_two signs & matches the bet
 *   3. Watch       — subscribe to active PDA; when backend settles
 *                    (account wiped to zero), show win/lose from balance diff
 *   4. History     — read on-chain history PDAs (size=280) written by settler
 *
 * The backend settler owns SettleFlip. Frontend never calls it.
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import { Buffer } from 'buffer';
import { useNavigate } from 'react-router-dom';
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import {
  WalletModalProvider,
  WalletMultiButton,
} from '@solana/wallet-adapter-react-ui';

require('@solana/wallet-adapter-react-ui/styles.css');
window.Buffer = Buffer;

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const PROGRAM_ID  = new web3.PublicKey(process.env.REACT_APP_PROGRAM_ID);
const HELIUS_RPC  = process.env.REACT_APP_HELIUS_RPC;
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://2xsol.up.railway.app';
const MIN_BET     = 0.01;   // SOL
const MAX_BET     = 10;     // SOL
const GAME_SIZE   = 200;    // bytes — matches Rust GAME_SIZE
const HISTORY_SIZE = 280;   // bytes — matches Rust HISTORY_SIZE

// ─────────────────────────────────────────────────────────────────────────────
// BORSH — Game PDA  (must match Rust struct field order exactly)
//
//  player_one       Pubkey   [32]
//  player_two       Pubkey   [32]
//  amount           u64        8
//  player_one_side  u8         1
//  status           u8         1   ← 1=Open, 2=Joined
//  padding          [u8;6]     6
//  game_id          u64        8
//  server_hash      [u8;32]   32
//  client_seed_a    [u8;32]   32
//  client_seed_b    [u8;32]   32
//                          ─────
//                           184  (allocated 200 with margin)
// ─────────────────────────────────────────────────────────────────────────────
class GameAccount {
  constructor(f) {
    this.player_one      = new web3.PublicKey(f.player_one);
    this.player_two      = new web3.PublicKey(f.player_two);
    this.amount          = f.amount;
    this.player_one_side = f.player_one_side;
    this.status          = f.status;
    this.padding         = f.padding;
    this.game_id         = f.game_id;
    this.server_hash     = f.server_hash;
    this.client_seed_a   = f.client_seed_a;
    this.client_seed_b   = f.client_seed_b;
  }
}
const gameSchema = new Map([[GameAccount, {
  kind: 'struct',
  fields: [
    ['player_one',      [32]],
    ['player_two',      [32]],
    ['amount',          'u64'],
    ['player_one_side', 'u8'],
    ['status',          'u8'],
    ['padding',         [6]],
    ['game_id',         'u64'],
    ['server_hash',     [32]],
    ['client_seed_a',   [32]],
    ['client_seed_b',   [32]],
  ],
}]]);

// ─────────────────────────────────────────────────────────────────────────────
// BORSH — History PDA  (written by backend settler, read-only here)
// ─────────────────────────────────────────────────────────────────────────────
class GameHistoryAccount {
  constructor(f) {
    this.game_id         = f.game_id;
    this.player_one      = new web3.PublicKey(f.player_one);
    this.player_two      = new web3.PublicKey(f.player_two);
    this.amount          = f.amount;
    this.winner          = new web3.PublicKey(f.winner);
    this.winner_side     = f.winner_side;
    this.player_one_side = f.player_one_side;
    this.padding         = f.padding;
    this.server_seed     = f.server_seed;
    this.server_hash     = f.server_hash;
    this.client_seed_a   = f.client_seed_a;
    this.client_seed_b   = f.client_seed_b;
    this.flip_byte       = f.flip_byte;
    this.padding2        = f.padding2;
    this.timestamp_slot  = f.timestamp_slot;
  }
}
const historySchema = new Map([[GameHistoryAccount, {
  kind: 'struct',
  fields: [
    ['game_id',         'u64'],
    ['player_one',      [32]],
    ['player_two',      [32]],
    ['amount',          'u64'],
    ['winner',          [32]],
    ['winner_side',     'u8'],
    ['player_one_side', 'u8'],
    ['padding',         [6]],
    ['server_seed',     [32]],
    ['server_hash',     [32]],
    ['client_seed_a',   [32]],
    ['client_seed_b',   [32]],
    ['flip_byte',       'u8'],
    ['padding2',        [7]],
    ['timestamp_slot',  'u64'],
  ],
}]]);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const hex    = (bytes) => Buffer.from(bytes).toString('hex');
const short  = (k = '', h = 6, t = 4) => k ? `${k.slice(0, h)}…${k.slice(-t)}` : '?';
const SOL    = (lam) => Number(lam) / web3.LAMPORTS_PER_SOL;

function formatRpcErr(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function extractTxErrorDetail(err) {
  const logs =
    err?.logs ||
    err?.transactionLogs ||
    err?.cause?.logs ||
    err?.error?.logs ||
    [];
  const logLine = Array.isArray(logs)
    ? logs.find((l) => /Program log:|custom program error|failed|Borsh|Invalid/i.test(l))
    : null;
  return logLine || err?.cause?.message || err?.message || 'Unexpected error';
}

async function getTxFailureDetail(connection, signature, fallbackErr) {
  const base = formatRpcErr(fallbackErr);
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages || [];
    const interesting = [...logs].reverse().find((l) =>
      /Program log:|custom program error|failed|Borsh|Invalid/i.test(l)
    );
    return interesting ? `${base} | ${interesting}` : base;
  } catch {
    return base;
  }
}

function tryDeserializeGame(data) {
  try {
    if (!data || data.length < GAME_SIZE || data.every(b => b === 0)) return null;
    return borsh.deserializeUnchecked(gameSchema, GameAccount, data);
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// COINFLIP UI
// ─────────────────────────────────────────────────────────────────────────────
function CoinflipUI() {
  const { connection }                 = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const navigate = useNavigate();

  // ── UI state ──
  const [wager,          setWager]          = useState('0.1');
  const [wagerErr,       setWagerErr]       = useState('');
  const [side,           setSide]           = useState(0);       // 0=Heads 1=Tails
  const [openGames,      setOpenGames]      = useState([]);
  const [gameHistory,    setGameHistory]    = useState([]);
  const [selectedHist,   setSelectedHist]   = useState(null);
  const [copiedKey,      setCopiedKey]      = useState('');
  const [verifyResult,   setVerifyResult]   = useState(null);

  // ── Flow state ──
  // phase: 'idle' | 'creating' | 'waiting' | 'joined' | 'settling' | 'done'
  const [phase,          setPhase]          = useState('idle');
  const [systemMsg,      setSystemMsg]      = useState('LOBBY_READY');
  const [balance,        setBalance]        = useState(0);
  const [resultModal,    setResultModal]    = useState(null);    // 'WON'|'LOST'
  const [resultSide,     setResultSide]     = useState(null);

  // ── Refs (survive re-render without triggering effects) ──
  const activePda         = useRef(null);   // PublicKey of game we're in
  const gameInfoRef       = useRef(null);   // last known game PDA deserialized
  const balBefore         = useRef(0);      // balance snapshot before join/create
  const mySide            = useRef(0);      // side WE picked
  const settledRef        = useRef(false);  // prevent double-fire
  const histInFlight      = useRef(false);
  const histLastAt        = useRef(0);
  const histRetry         = useRef(null);
  const histScrollRef     = useRef(null);
  const gameSubRef        = useRef(null);   // current account subscription id

  // ── Auto-scroll history bar ──
  useEffect(() => {
    if (histScrollRef.current)
      histScrollRef.current.scrollLeft = histScrollRef.current.scrollWidth;
  }, [gameHistory]);

  // ── Cleanup on unmount ──
  useEffect(() => () => {
    if (histRetry.current) clearTimeout(histRetry.current);
    if (gameSubRef.current !== null) connection.removeAccountChangeListener(gameSubRef.current);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // BALANCE
  // ─────────────────────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    const raw = await connection.getBalance(publicKey);
    setBalance(raw / web3.LAMPORTS_PER_SOL);
    return raw / web3.LAMPORTS_PER_SOL;
  }, [publicKey, connection]);

  useEffect(() => { refreshBalance(); }, [publicKey]);

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIVE GAME WATCHER
  // Subscribe to activePda once it's set.
  // Backend will settle (wipe account to zeros). When we see zeros → done.
  // ─────────────────────────────────────────────────────────────────────────
  const unsubGame = useCallback(() => {
    if (gameSubRef.current !== null) {
      connection.removeAccountChangeListener(gameSubRef.current);
      gameSubRef.current = null;
    }
  }, [connection]);

  const onSettled = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    unsubGame();

    setPhase('settling');
    setSystemMsg('VERIFYING_OUTCOME...');
    console.log('settlement started', {
      activePda: activePda.current ? activePda.current.toBase58() : null,
      gameId: gameInfoRef.current ? Number(gameInfoRef.current.game_id) : null,
      mySide: mySide.current,
      balanceBefore: balBefore.current,
    });

    // Wait a beat then read balance diff
    await new Promise(r => setTimeout(r, 2500));

    // Prefer on-chain history record (written by settler) to decide winner.
    // If we can't find the history entry, fall back to balance diff.
    let won = null;
    try {
      const gid = gameInfoRef.current ? Number(gameInfoRef.current.game_id) : null;
      if (gid !== null) {
        const accounts = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: HISTORY_SIZE }] });
        console.log('history accounts fetched for settlement', { gameId: gid, accounts: accounts.length });
        for (const { account } of accounts) {
          try {
            const d = borsh.deserializeUnchecked(historySchema, GameHistoryAccount, account.data);
            if (Number(d.game_id) === gid) {
              const winnerPubkey = d.winner ? new web3.PublicKey(d.winner).toBase58() : null;
              won = winnerPubkey === (publicKey ? publicKey.toBase58() : null);
              console.log('winner selected from history', {
                gameId: gid,
                winnerPubkey,
                myPubkey: publicKey ? publicKey.toBase58() : null,
                winnerSide: d.winner_side,
                playerOneSide: d.player_one_side,
                won,
              });
              break;
            }
          } catch (e) { /* skip malformed */ }
        }
      }
    } catch (e) {
      console.warn('history lookup failed:', e);
    }

    if (won === null) {
      const newBal = await refreshBalance();
      won = newBal > balBefore.current;
      console.log('winner selected from balance fallback', {
        newBal,
        balanceBefore: balBefore.current,
        won,
      });
    }

    const selectedSide = won ? mySide.current : (mySide.current === 0 ? 1 : 0);
    console.log('final winner decision', {
      won,
      selectedSide,
      resultLabel: won ? 'WON' : 'LOST',
    });

    setResultSide(selectedSide);
    setResultModal(won ? 'WON' : 'LOST');
    setSystemMsg(won ? 'SETTLED: YOU WON' : 'SETTLED: YOU LOST');
    setPhase('done');
    activePda.current  = null;
    settledRef.current = false;

    // Fetch history after a short delay so the history PDA is confirmed
    setTimeout(() => fetchHistory(true), 3000);
  }, [refreshBalance, unsubGame]);

  const subscribeToGame = useCallback((pda) => {
    unsubGame(); // clear any old sub
    const id = connection.onAccountChange(
      pda,
      (info) => {
        // Account zeroed = settler closed it after settlement
        if (!info.data || info.data.length === 0 || info.data.every(b => b === 0)) {
          onSettled();
          return;
        }
        const g = tryDeserializeGame(info.data);
        if (!g) { onSettled(); return; }  // can't parse = wiped

        // keep last known game info so we can look up history after settlement
        gameInfoRef.current = g;

        if (g.status === 2) {
          setSystemMsg('OPPONENT_JOINED! AWAITING_SETTLER...');
          setPhase('joined');
        }
        // status=1 means still open — just waiting, do nothing
      },
      'confirmed'
    );
    gameSubRef.current = id;
  }, [connection, onSettled, unsubGame]);

  // ─────────────────────────────────────────────────────────────────────────
  // LOBBY POLLER  (getProgramAccounts filtered to GAME_SIZE)
  // ─────────────────────────────────────────────────────────────────────────
  const fetchGames = useCallback(async () => {
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: GAME_SIZE }],
      });
      const games = accounts
        .map(({ pubkey, account }) => {
          const g = tryDeserializeGame(account.data);
          return g ? { pubkey, ...g } : null;
        })
        .filter(Boolean)
        .filter(g => g.status === 1); // Open only
      setOpenGames(games);
    } catch (e) { console.error('fetchGames:', e); }
  }, [connection]);

  // Poll every 5 s while idle/open-lobby states, stop during tx settlement
  useEffect(() => {
    if (!publicKey) return;
    fetchGames();
    if (phase === 'creating' || phase === 'settling') return; // pause only while tx/settlement is in flight
    const t = setInterval(fetchGames, 5000);
    return () => clearInterval(t);
  }, [publicKey, phase, fetchGames]);

  // ─────────────────────────────────────────────────────────────────────────
  // HISTORY  (read on-chain history PDAs written by settler)
  // ─────────────────────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async (force = false) => {
    const now = Date.now();
    if (histInFlight.current) return;
    if (!force && now - histLastAt.current < 15000) return;
    histInFlight.current = true;
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: HISTORY_SIZE }],
      });
      const items = [];
      for (const { account } of accounts) {
        try {
          const d = borsh.deserializeUnchecked(historySchema, GameHistoryAccount, account.data);
          items.push({
            gameId:     String(d.game_id),
            playerOne:  d.player_one.toBase58(),
            playerTwo:  d.player_two.toBase58(),
            winner:     d.winner.toBase58(),
            winnerSide: d.winner_side === 0 ? 'HEADS' : 'TAILS',
            amount:     SOL(d.amount),
            seedA:      hex(d.client_seed_a),
            seedB:      hex(d.client_seed_b),
            serverSeed: hex(d.server_seed),
            serverHash: hex(d.server_hash),
            flipByte:   d.flip_byte,
            slot:       Number(d.timestamp_slot),
          });
        } catch { /* corrupt/partial — skip */ }
      }
      items.sort((a, b) => Number(b.gameId) - Number(a.gameId));

      setGameHistory(prev => {
        const seen   = new Set(prev.map(x => x.gameId));
        const merged = [...prev];
        for (const item of items) {
          if (!seen.has(item.gameId)) { merged.push(item); seen.add(item.gameId); }
        }
        return merged.sort((a, b) => Number(b.gameId) - Number(a.gameId));
      });

      histLastAt.current = now;
    } catch (e) {
      console.error('fetchHistory:', e);
      if (histRetry.current) clearTimeout(histRetry.current);
      histRetry.current = setTimeout(() => fetchHistory(true), 10000);
    } finally {
      histInFlight.current = false;
    }
  }, [connection]);

  useEffect(() => { if (publicKey) fetchHistory(false); }, [publicKey]);

  // ─────────────────────────────────────────────────────────────────────────
  // CREATE GAME  (player_one)
  // ─────────────────────────────────────────────────────────────────────────
  const createGame = async () => {
    if (!publicKey || phase !== 'idle') return;
    const err = validateWager(wager);
    if (err) { setWagerErr(err); return; }

    setPhase('creating');
    setSystemMsg('REQUESTING_SERVER_HASH...');
    try {
      // 1. Get server hash from backend
      const gameId = Math.floor(Date.now() / 1000);
      const res    = await fetch(`${BACKEND_URL}/generate-game`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ gameId }),
      });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);
      const { serverHash } = await res.json();
      // serverHash is expected as a 32-byte array from backend
      const serverHashBytes = Array.isArray(serverHash) ? serverHash : Array.from(Buffer.from(serverHash, 'hex'));

      // 2. Generate client seed A
      const clientSeedA = Array.from(window.crypto.getRandomValues(new Uint8Array(32)));

      // 3. Derive PDA
      const idBuf = Buffer.alloc(8);
      idBuf.writeBigUInt64LE(BigInt(gameId));
      const [pda] = await web3.PublicKey.findProgramAddress(
        [Buffer.from('game'), publicKey.toBuffer(), idBuf],
        PROGRAM_ID
      );

      // 4. Build instruction
      // Layout: [u8 variant=0][u64 game_id][u64 amount][u8 side][32 server_hash][32 client_seed_a]
      const lamports = BigInt(Math.round(parseFloat(wager) * web3.LAMPORTS_PER_SOL));
      const data     = Buffer.alloc(1 + 8 + 8 + 1 + 32 + 32);
      let off        = 0;
      data.writeUInt8(0, off);                      off += 1;
      data.writeBigUInt64LE(BigInt(gameId), off);   off += 8;
      data.writeBigUInt64LE(lamports, off);         off += 8;
      data.writeUInt8(side, off);                   off += 1;   // 0 or 1 only
      Buffer.from(serverHashBytes).copy(data, off); off += 32;
      Buffer.from(clientSeedA).copy(data, off);

      // Accounts: [game_pda(w), player_one(signer,w), system_program]
      const tx = new web3.Transaction().add(new web3.TransactionInstruction({
        keys: [
          { pubkey: pda,                          isSigner: false, isWritable: true  },
          { pubkey: publicKey,                    isSigner: true,  isWritable: true  },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      }));

      setSystemMsg('SIGN_TRANSACTION...');
      const sig = await sendTransaction(tx, connection);
      setSystemMsg('CONFIRMING...');
      await connection.confirmTransaction(sig, 'confirmed');

      // 5. Snapshot balance AFTER create (bet+rent already deducted)
      balBefore.current  = await refreshBalance();
      mySide.current     = side;
      activePda.current  = pda;
      settledRef.current = false;

      // 6. Subscribe to game PDA
      subscribeToGame(pda);

      setPhase('waiting');
      setSystemMsg('LOBBY_OPEN: WAITING_FOR_OPPONENT...');
      fetchGames();
    } catch (e) {
      console.error('createGame:', e);
      setSystemMsg('ERR: ' + (e.message || 'Unknown error'));
      setPhase('idle');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // JOIN GAME  (player_two)
  // ─────────────────────────────────────────────────────────────────────────
  const joinGame = async (game) => {
    console.log('joinGame called', { gamePubkey: game?.pubkey?.toBase58?.(), publicKey: publicKey ? publicKey.toBase58() : null, phase });
    if (!publicKey || phase !== 'idle') {
      if (!publicKey) setSystemMsg('ERR: Connect wallet to join');
      else setSystemMsg('ERR: Busy — cannot join right now');
      console.warn('joinGame aborted', { publicKey: !!publicKey, phase });
      return;
    }
    if (game.player_one.equals(publicKey)) {
      console.warn('joinGame prevented: attempting to join own lobby', { player_one: game.player_one.toBase58(), you: publicKey.toBase58() });
      setSystemMsg('ERR: Cannot join your own lobby');
      return;
    }

    setPhase('creating');
    setSystemMsg('JOINING_MATCH...');
    try {
      // Client seed B
      const clientSeedB = Array.from(window.crypto.getRandomValues(new Uint8Array(32)));

      // Layout: [u8 variant=1][32 client_seed_b]
      const data = Buffer.alloc(1 + 32);
      data.writeUInt8(1, 0);
      Buffer.from(clientSeedB).copy(data, 1);

      // Accounts: [game_pda(w), player_two(signer,w), system_program]
      const tx = new web3.Transaction().add(new web3.TransactionInstruction({
        keys: [
          { pubkey: game.pubkey,                  isSigner: false, isWritable: true  },
          { pubkey: publicKey,                    isSigner: true,  isWritable: true  },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      }));

      const latest = await connection.getLatestBlockhash('confirmed');
      tx.feePayer = publicKey;
      tx.recentBlockhash = latest.blockhash;

      setSystemMsg('SIGN_TRANSACTION...');
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      setSystemMsg('CONFIRMING...');
      const confirmation = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );
      if (confirmation.value.err) {
        const detail = await getTxFailureDetail(connection, sig, confirmation.value.err);
        throw new Error(detail);
      }

      // Snapshot balance AFTER join (bet deducted)
      balBefore.current  = await refreshBalance();
      mySide.current     = game.player_one_side === 0 ? 1 : 0; // opposite of p1
      activePda.current  = game.pubkey;
      settledRef.current = false;

      subscribeToGame(game.pubkey);

      setPhase('joined');
      setSystemMsg('MATCH_LIVE: AWAITING_SETTLER...');
      fetchGames();
    } catch (e) {
      console.error('joinGame:', e);
      setSystemMsg('ERR JOIN: ' + extractTxErrorDetail(e).slice(0, 170));
      setPhase('idle');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // CANCEL GAME  (player_one only, status=1 only)
  // ─────────────────────────────────────────────────────────────────────────
  const cancelGame = async (game) => {
    if (!publicKey || !game.player_one.equals(publicKey)) return;
    setSystemMsg('CANCELLING...');
    try {
      // Layout: [u8 variant=3]
      const data = Buffer.alloc(1);
      data.writeUInt8(3, 0);

      const tx = new web3.Transaction().add(new web3.TransactionInstruction({
        keys: [
          { pubkey: game.pubkey, isSigner: false, isWritable: true },
          { pubkey: publicKey,   isSigner: true,  isWritable: true },
        ],
        programId: PROGRAM_ID,
        data,
      }));

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      setSystemMsg('LOBBY_CANCELLED: REFUNDED');
      unsubGame();
      activePda.current = null;
      setPhase('idle');
      refreshBalance();
      fetchGames();
    } catch (e) {
      setSystemMsg('ERR: ' + (e.message || 'Unknown error'));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  const validateWager = (v) => {
    const n = parseFloat(v);
    if (isNaN(n) || n < MIN_BET) return `Min bet is ${MIN_BET} SOL`;
    if (n > MAX_BET)             return `Max bet is ${MAX_BET} SOL`;
    return '';
  };

  const handleWagerChange = (e) => {
    setWager(e.target.value);
    setWagerErr(validateWager(e.target.value));
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const verifyFair = async (h) => {
    if (!h.serverSeed || h.serverSeed === 'N/A') { setVerifyResult('NO_SEED'); return; }
    setVerifyResult('checking…');
    try {
      const seedBytes    = Buffer.from(h.serverSeed, 'hex');
      const hashBuf      = await crypto.subtle.digest('SHA-256', seedBytes);
      const computedHash = Buffer.from(hashBuf).toString('hex');
      setVerifyResult(computedHash === h.serverHash ? '✓ VERIFIED FAIR' : '✗ HASH MISMATCH');
    } catch { setVerifyResult('ERROR'); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DERIVED
  // ─────────────────────────────────────────────────────────────────────────
  const inGame   = phase !== 'idle' && phase !== 'done';
  const busy     = phase === 'creating';

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>

      {/* ── WIN / LOSS MODAL ─────────────────────────────────────────────── */}
      {resultModal && (
        <div className="cf-overlay" onClick={() => { setResultModal(null); setPhase('idle'); fetchGames(); }}>
          <div className={`cf-result-card ${resultModal === 'WON' ? 'r-won' : 'r-lost'}`}
               onClick={e => e.stopPropagation()}>
            <div className={`r-badge ${resultSide === 0 ? 'rb-heads' : 'rb-tails'}`}>
              {resultSide === 0 ? 'H' : 'T'}
            </div>
            <div className="r-side">{resultSide === 0 ? 'HEADS' : 'TAILS'}</div>
            <div className="r-verdict">{resultModal === 'WON' ? '🏆 YOU WON' : '💀 YOU LOST'}</div>
            <div className="r-sub">
              {resultModal === 'WON' ? 'SOL credited to your wallet.' : 'Better luck next flip.'}
            </div>
            <button className="cf-btn" style={{ marginTop: 24 }}
                    onClick={() => { setResultModal(null); setPhase('idle'); fetchGames(); }}>
              BACK TO LOBBY
            </button>
          </div>
        </div>
      )}

      {/* ── HISTORY DETAIL MODAL ─────────────────────────────────────────── */}
      {selectedHist && (
        <div className="cf-overlay" onClick={() => { setSelectedHist(null); setVerifyResult(null); }}>
          <div className="cf-hist-modal" onClick={e => e.stopPropagation()}>
            <div className="hm-header">
              <span className="hm-label">⚖ PROVABLY FAIR</span>
              <span className="hm-gid">#{selectedHist.gameId}</span>
            </div>

            <div className={`hm-outcome ${selectedHist.winnerSide === 'HEADS' ? 'hm-heads' : 'hm-tails'}`}>
              {selectedHist.winnerSide}
            </div>

            <div className="hm-rows">
              {selectedHist.amount && <Row label="AMOUNT"    val={`${selectedHist.amount} SOL`} />}
              {selectedHist.playerOne && <Row label="PLAYER 1" val={short(selectedHist.playerOne, 12, 6)} mono />}
              {selectedHist.playerTwo && <Row label="PLAYER 2" val={short(selectedHist.playerTwo, 12, 6)} mono />}
              {selectedHist.winner    && <Row label="WINNER"   val={short(selectedHist.winner, 12, 6)} mono />}
            </div>

            {[
              { label: 'SERVER HASH (COMMIT)', key: 'sh',  val: selectedHist.serverHash },
              { label: 'SERVER SEED (REVEAL)', key: 'ss',  val: selectedHist.serverSeed },
              { label: 'CLIENT SEED A',        key: 'sa',  val: selectedHist.seedA },
              { label: 'CLIENT SEED B',        key: 'sb',  val: selectedHist.seedB },
            ].map(({ label, key, val }) => (
              <div className="hm-seed-row" key={key}>
                <div className="hm-slabel">{label}</div>
                <div className="hm-copybox" onClick={() => copyText(val, key)}>
                  <span className="hm-sval">{val || 'N/A'}</span>
                  <span className="hm-icon">{copiedKey === key ? '✓' : '⧉'}</span>
                </div>
              </div>
            ))}

            <div className="hm-verify-row">
              <button className="cf-btn-outline" onClick={() => verifyFair(selectedHist)}>
                VERIFY HASH
              </button>
              {verifyResult && (
                <span className={`vr ${verifyResult.startsWith('✓') ? 'vr-ok' : verifyResult === 'checking…' ? 'vr-wait' : 'vr-fail'}`}>
                  {verifyResult}
                </span>
              )}
            </div>

            <button className="cf-btn" style={{ width: '100%', marginTop: 14 }}
                    onClick={() => { setSelectedHist(null); setVerifyResult(null); }}>
              CLOSE
            </button>
          </div>
        </div>
      )}

      {/* ── APP SHELL ────────────────────────────────────────────────────── */}
      <div className="cf-root">

        {/* HEADER */}
        <header className="cf-header">
          <div className="cf-logo">
            <span className="logo-mark">◈</span>
            <span className="logo-name">SOLFLIP</span>
          </div>
          <div className="cf-hright">
            <div className="cf-nav">
              <button type="button" className="cf-nav-btn" onClick={() => navigate('/verify-game')}>
                VERIFY
              </button>
              <button type="button" className="cf-nav-btn" onClick={() => navigate('/leaderboard')}>
                LEADERBOARD
              </button>
            </div>
            {publicKey && (
              <div className="cf-bal">
                <span className="bal-l">BAL</span>
                <span className="bal-v">{balance.toFixed(4)} SOL</span>
              </div>
            )}
            <WalletMultiButton />
          </div>
        </header>

        <main className="cf-main">

          {/* ── HERO COIN ── */}
          <section className="cf-hero">
            <div className={`cf-coin ${inGame ? 'cf-coin--spin' : ''}`}>
              <div className="coin-h">H</div>
              <div className="coin-t">T</div>
            </div>
            <div className="cf-status">
              <span className="cf-cursor">›</span>
              <span className="cf-smsg">{systemMsg}</span>
            </div>
          </section>

          {/* ── CONTROLS ── */}
          <section className="glass cf-controls">
            <div className="ctrl-grid">

              {/* Wager */}
              <div className="cf-field">
                <label className="cf-lbl">WAGER (SOL)</label>
                <input
                  type="number" step="0.01"
                  min={MIN_BET} max={MAX_BET}
                  className={`cf-input${wagerErr ? ' cf-input--err' : ''}`}
                  value={wager}
                  onChange={handleWagerChange}
                  disabled={inGame}
                />
                {wagerErr && <div className="cf-err">{wagerErr}</div>}
                <div className="quick-bets">
                  {[0.05, 0.1, 0.5, 1].map(v => (
                    <button key={v} className="qb" onClick={() => { setWager(String(v)); setWagerErr(''); }} disabled={inGame}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side */}
              <div className="cf-field">
                <label className="cf-lbl">PICK SIDE</label>
                <div className="side-toggle">
                  <button className={`side-btn${side === 0 ? ' side-h' : ''}`}
                          onClick={() => setSide(0)} disabled={inGame}>
                    ◈ HEADS
                  </button>
                  <button className={`side-btn${side === 1 ? ' side-t' : ''}`}
                          onClick={() => setSide(1)} disabled={inGame}>
                    ◇ TAILS
                  </button>
                </div>
              </div>

              {/* Create */}
              <div className="cf-field cf-field--cta">
                {!publicKey
                  ? <div className="cf-err" style={{ textAlign: 'center' }}>Connect wallet to play</div>
                  : (
                    <button className="cf-btn cf-btn--big"
                            onClick={createGame}
                            disabled={busy || inGame || !!wagerErr}>
                      {busy ? '◌ SIGNING…' : inGame ? systemMsg : '+ CREATE LOBBY'}
                    </button>
                  )
                }
              </div>

            </div>
          </section>

          {/* ── ACTIVE LOBBIES ── */}
          <section className="cf-section">
            <div className="sec-head">
              <h2 className="sec-title">ACTIVE LOBBIES</h2>
              <span className="sec-badge">{openGames.length}</span>
              <button className="cf-icon-btn" onClick={fetchGames} title="Refresh">↻</button>
            </div>

            {openGames.length === 0
              ? <div className="cf-empty">No open lobbies. Create one above.</div>
              : (
                <div className="lobby-grid">
                  {openGames.map(g => {
                    const own = publicKey && g.player_one.equals(publicKey);
                    return (
                      <div key={g.pubkey.toBase58()} className={`glass lobby-card${own ? ' lobby-own' : ''}`}>
                        <div className="lc-top">
                          <span className="lc-amt">{SOL(g.amount)} SOL</span>
                          <span className={`lc-chip ${g.player_one_side === 0 ? 'chip-h' : 'chip-t'}`}>
                            {g.player_one_side === 0 ? 'HEADS' : 'TAILS'}
                          </span>
                        </div>
                        <div className="lc-meta">
                          <span>PDA: {short(g.pubkey.toBase58())}</span>
                          <span>BY: {short(g.player_one.toBase58())}</span>
                        </div>
                        <div className="lc-actions">
                          {own ? (
                            <>
                              <span className="lc-mine">YOUR LOBBY</span>
                              <button className="cf-btn-danger"
                                      onClick={() => cancelGame(g)}
                                      disabled={inGame}>
                                CANCEL
                              </button>
                            </>
                          ) : (
                            <button className="cf-btn lc-join"
                                    onClick={() => joinGame(g)}
                                    disabled={!publicKey || inGame}>
                              JOIN {SOL(g.amount)} SOL
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            }
          </section>

          {/* ── HISTORY ── */}
          <section className="cf-section">
            <div className="sec-head">
              <h2 className="sec-title">FLIP HISTORY</h2>
              <span className="sec-badge">{gameHistory.length}</span>
              <button className="cf-icon-btn" onClick={() => fetchHistory(true)} title="Refresh">↻</button>
            </div>

            {/* Pill bar */}
            <div className="pill-bar" ref={histScrollRef}>
              {[...gameHistory].reverse().map((h, i) => (
                <button
                  key={h.gameId || i}
                  className={`pill ${h.winnerSide === 'HEADS' ? 'pill-h' : 'pill-t'}${i === 0 ? ' pill-new' : ''}`}
                  onClick={() => { setSelectedHist(h); setVerifyResult(null); }}
                  title={`#${h.gameId} — ${h.winnerSide}`}
                >
                  {h.winnerSide === 'HEADS' ? 'H' : 'T'}
                </button>
              ))}
              {gameHistory.length === 0 && <div className="cf-empty">No history yet.</div>}
            </div>

            {/* Table */}
            {gameHistory.length > 0 && (
              <div className="hist-table-wrap">
                <table className="hist-table">
                  <thead>
                    <tr>
                      <th>GAME ID</th>
                      <th>RESULT</th>
                      <th>AMOUNT</th>
                      <th>SLOT</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {gameHistory.slice(0, 30).map((h, i) => (
                      <tr key={h.gameId || i}
                          onClick={() => { setSelectedHist(h); setVerifyResult(null); }}>
                        <td className="mono">#{h.gameId}</td>
                        <td>
                          <span className={`chip-s ${h.winnerSide === 'HEADS' ? 'chip-h' : 'chip-t'}`}>
                            {h.winnerSide}
                          </span>
                        </td>
                        <td>{h.amount ? `${h.amount} SOL` : '—'}</td>
                        <td className="mono">{h.slot || '—'}</td>
                        <td className="arr">›</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

        </main>

        <footer className="cf-footer">
          <span>SOLFLIP · Provably Fair · On-Chain Settlement</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {short(PROGRAM_ID.toBase58(), 10, 6)}
          </span>
        </footer>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL PRESENTATIONAL COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function Row({ label, val, mono }) {
  return (
    <div className="hm-row">
      <span className="hm-rl">{label}</span>
      <span className={`hm-rv${mono ? ' mono' : ''}`}>{val}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg: #050814;
  --bg-2: #09111f;
  --bg-3: #0d1728;
  --panel: rgba(11, 18, 31, 0.84);
  --panel-strong: rgba(12, 21, 37, 0.96);
  --line: rgba(160, 193, 255, 0.14);
  --line-strong: rgba(160, 193, 255, 0.28);
  --text: #e9f0ff;
  --dim: #8ca0c4;
  --cyan: #37e6ff;
  --mint: #19fb9b;
  --violet: #a663ff;
  --violet-deep: #6d29d6;
  --amber: #ffcc66;
  --err: #ff5f7d;
  --shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  --shadow-strong: 0 32px 90px rgba(0, 0, 0, 0.62);
  --r: 16px;
  --fmono: 'Share Tech Mono', monospace;
  --fui: 'Rajdhani', sans-serif;
  --fdisplay: 'Orbitron', sans-serif;
}

html, body, #root {
  min-height: 100%;
}

body {
  margin: 0;
  color: var(--text);
  font-family: var(--fui);
  background:
    radial-gradient(circle at 12% 18%, rgba(166, 99, 255, 0.20), transparent 20%),
    radial-gradient(circle at 86% 12%, rgba(55, 230, 255, 0.16), transparent 18%),
    radial-gradient(circle at 50% 82%, rgba(25, 251, 155, 0.10), transparent 22%),
    linear-gradient(180deg, #03050d 0%, #050814 48%, #07101c 100%);
  overflow-x: hidden;
}

body::before,
body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
}

body::before {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 72px 72px;
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.14));
  opacity: 0.55;
}

body::after {
  background:
    radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.08), transparent 36%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 20%, transparent 80%, rgba(0, 0, 0, 0.22));
  mix-blend-mode: screen;
}

.mono {
  font-family: var(--fmono);
}

/* layout */
.cf-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
  isolation: isolate;
}

.cf-root::before,
.cf-root::after {
  content: '';
  position: fixed;
  inset: auto;
  pointer-events: none;
  z-index: -1;
  filter: blur(18px);
}

.cf-root::before {
  width: 24rem;
  height: 24rem;
  left: -6rem;
  top: 8rem;
  background: radial-gradient(circle, rgba(166, 99, 255, 0.18), transparent 68%);
}

.cf-root::after {
  width: 28rem;
  height: 28rem;
  right: -8rem;
  bottom: 4rem;
  background: radial-gradient(circle, rgba(25, 251, 155, 0.14), transparent 68%);
}

.cf-main {
  width: min(1140px, calc(100% - 32px));
  margin: 0 auto;
  padding: 0 0 72px;
  flex: 1;
}

/* header */
.cf-header {
  width: min(1140px, calc(100% - 32px));
  margin: 18px auto 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid rgba(160, 193, 255, 0.16);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(11, 18, 31, 0.94), rgba(8, 13, 24, 0.86));
  box-shadow: var(--shadow);
  backdrop-filter: blur(18px) saturate(1.1);
  position: sticky;
  top: 16px;
  z-index: 100;
}

.cf-logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-mark {
  font-size: 24px;
  color: var(--mint);
  text-shadow: 0 0 18px rgba(25, 251, 155, 0.4);
}

.logo-name {
  font-family: var(--fdisplay);
  font-size: 21px;
  font-weight: 800;
  letter-spacing: 4px;
  color: #ffffff;
  text-shadow: 0 0 18px rgba(55, 230, 255, 0.12);
}

.cf-hright {
  display: flex;
  align-items: center;
  gap: 14px;
}

.cf-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.cf-nav-btn {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(160, 193, 255, 0.12);
  color: #d6e3ff;
  padding: 9px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-family: var(--fdisplay);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.4px;
  transition: transform 0.15s, border-color 0.15s, background 0.15s, color 0.15s;
}

.cf-nav-btn:hover {
  transform: translateY(-1px);
  border-color: rgba(55, 230, 255, 0.5);
  background: rgba(55, 230, 255, 0.06);
  color: var(--cyan);
}

.cf-bal {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 110px;
  padding: 8px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.bal-l {
  font-size: 10px;
  color: var(--dim);
  letter-spacing: 2px;
}

.bal-v {
  font-family: var(--fmono);
  font-size: 14px;
  color: var(--mint);
}

/* glass */
.glass {
  background: linear-gradient(180deg, rgba(12, 21, 37, 0.90), rgba(8, 13, 24, 0.88));
  border: 1px solid rgba(160, 193, 255, 0.12);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px) saturate(1.1);
}

/* hero */
.cf-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 54px 0 38px;
  gap: 26px;
  position: relative;
}

.cf-hero::before {
  content: '';
  position: absolute;
  width: min(620px, 92vw);
  height: 18px;
  bottom: 20px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(55, 230, 255, 0.32), rgba(55, 230, 255, 0.04) 42%, transparent 72%);
  filter: blur(10px);
}

/* coin */
.cf-coin {
  width: 122px;
  height: 122px;
  position: relative;
  transform-style: preserve-3d;
  filter: drop-shadow(0 0 24px rgba(25, 251, 155, 0.18));
}

.cf-coin::before,
.cf-coin::after {
  content: '';
  position: absolute;
  inset: -16px;
  border-radius: 50%;
  pointer-events: none;
}

.cf-coin::before {
  background: radial-gradient(circle, rgba(55, 230, 255, 0.20), transparent 68%);
  transform: scale(0.92);
}

.cf-coin::after {
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
}

.cf-coin--spin {
  animation: cspin 1.18s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
}

@keyframes cspin {
  0% {
    transform: perspective(500px) rotateY(0deg) rotateZ(0deg);
  }
  50% {
    transform: perspective(500px) rotateY(90deg) rotateZ(6deg) scale(1.06);
  }
  100% {
    transform: perspective(500px) rotateY(180deg) rotateZ(0deg);
  }
}

.coin-h,
.coin-t {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  font-weight: 800;
  font-family: var(--fdisplay);
  letter-spacing: 2px;
  backface-visibility: hidden;
  border: 1px solid rgba(255, 255, 255, 0.16);
}

.coin-h {
  background:
    radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0) 22%),
    radial-gradient(circle at 35% 35%, #35ffb1, #0a7a50 58%, #0a5537 100%);
  box-shadow: 0 0 34px rgba(25, 251, 155, 0.45), inset 0 2px 10px rgba(255, 255, 255, 0.16);
  color: #052012;
}

.coin-t {
  background:
    radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0) 22%),
    radial-gradient(circle at 35% 35%, #d286ff, #7e2cff 58%, #5013ad 100%);
  box-shadow: 0 0 34px rgba(166, 99, 255, 0.45), inset 0 2px 10px rgba(255, 255, 255, 0.16);
  color: #1c093f;
  transform: rotateY(180deg);
}

/* status */
.cf-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-family: var(--fmono);
  font-size: 13px;
}

.cf-cursor {
  color: var(--cyan);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.cf-smsg {
  color: var(--dim);
  letter-spacing: 1.4px;
}

/* controls */
.cf-controls {
  padding: 22px;
  margin-bottom: 28px;
  position: relative;
  overflow: hidden;
}

.cf-controls::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, rgba(55, 230, 255, 0.05), transparent 30%, rgba(166, 99, 255, 0.06));
  pointer-events: none;
}

.ctrl-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 18px;
  position: relative;
  z-index: 1;
}

@media (max-width: 720px) {
  .ctrl-grid {
    grid-template-columns: 1fr;
  }

  .cf-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .cf-hright {
    width: 100%;
    justify-content: space-between;
  }

  .cf-nav {
    width: 100%;
  }

  .cf-bal {
    align-items: flex-start;
  }
}

.cf-field {
  display: flex;
  flex-direction: column;
}

.cf-field--cta {
  justify-content: flex-end;
}

.cf-lbl {
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--dim);
  margin-bottom: 8px;
}

.cf-input {
  background: rgba(3, 7, 16, 0.92);
  border: 1px solid rgba(160, 193, 255, 0.12);
  color: var(--text);
  padding: 12px 14px;
  font-family: var(--fmono);
  font-size: 16px;
  border-radius: 14px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

.cf-input:focus {
  border-color: rgba(55, 230, 255, 0.65);
  box-shadow: 0 0 0 3px rgba(55, 230, 255, 0.12);
  transform: translateY(-1px);
}

.cf-input--err {
  border-color: var(--err) !important;
}

.cf-err {
  font-size: 11px;
  color: var(--err);
  margin-top: 5px;
}

.quick-bets {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.qb {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(160, 193, 255, 0.10);
  color: var(--dim);
  padding: 6px 12px;
  font-family: var(--fmono);
  font-size: 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}

.qb:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(55, 230, 255, 0.55);
  color: var(--cyan);
  background: rgba(55, 230, 255, 0.07);
}

.qb:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.side-toggle {
  display: flex;
  gap: 10px;
  padding: 6px;
  background: rgba(3, 7, 16, 0.78);
  border: 1px solid rgba(160, 193, 255, 0.10);
  border-radius: 18px;
}

.side-btn {
  flex: 1;
  padding: 12px 14px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dim);
  font-family: var(--fdisplay);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1.6px;
  border-radius: 14px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}

.side-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.side-h {
  background: linear-gradient(180deg, rgba(25, 251, 155, 0.20), rgba(9, 48, 29, 0.80));
  border-color: rgba(25, 251, 155, 0.55);
  color: var(--mint);
  box-shadow: 0 0 22px rgba(25, 251, 155, 0.16);
}

.side-t {
  background: linear-gradient(180deg, rgba(166, 99, 255, 0.20), rgba(35, 11, 76, 0.86));
  border-color: rgba(166, 99, 255, 0.55);
  color: #cfa9ff;
  box-shadow: 0 0 22px rgba(166, 99, 255, 0.18);
}

.side-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* buttons */
.cf-btn {
  background: linear-gradient(135deg, var(--mint), #05d27d);
  color: #03120c;
  border: none;
  padding: 12px 22px;
  font-family: var(--fdisplay);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 2px;
  border-radius: 14px;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.15s, box-shadow 0.15s, filter 0.15s;
  white-space: nowrap;
}

.cf-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px rgba(25, 251, 155, 0.18), 0 0 28px rgba(25, 251, 155, 0.22);
  filter: brightness(1.04);
}

.cf-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.cf-btn--big {
  width: 100%;
  padding: 15px 18px;
  font-size: 15px;
}

.cf-btn-outline {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(166, 99, 255, 0.55);
  color: #d7b9ff;
  padding: 10px 18px;
  font-family: var(--fdisplay);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1.4px;
  border-radius: 14px;
  cursor: pointer;
  transition: transform 0.15s, background 0.15s, border-color 0.15s;
}

.cf-btn-outline:hover {
  transform: translateY(-1px);
  background: rgba(166, 99, 255, 0.10);
  border-color: rgba(166, 99, 255, 0.9);
}

.cf-btn-danger {
  background: rgba(255, 95, 125, 0.05);
  border: 1px solid rgba(255, 95, 125, 0.6);
  color: #ff8da2;
  padding: 10px 16px;
  font-family: var(--fdisplay);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1.4px;
  border-radius: 14px;
  cursor: pointer;
  transition: transform 0.15s, background 0.15s, border-color 0.15s;
}

.cf-btn-danger:hover:not(:disabled) {
  transform: translateY(-1px);
  background: rgba(255, 95, 125, 0.10);
  border-color: rgba(255, 95, 125, 0.92);
}

.cf-btn-danger:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.cf-icon-btn {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(160, 193, 255, 0.10);
  color: var(--dim);
  width: 34px;
  height: 34px;
  border-radius: 999px;
  font-size: 16px;
  cursor: pointer;
  margin-left: auto;
  transition: transform 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}

.cf-icon-btn:hover {
  transform: translateY(-1px) rotate(20deg);
  color: var(--cyan);
  border-color: rgba(55, 230, 255, 0.45);
  background: rgba(55, 230, 255, 0.06);
}

/* section */
.cf-section {
  margin-bottom: 38px;
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.sec-title {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 4px;
  color: var(--dim);
  text-transform: uppercase;
}

.sec-badge {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(160, 193, 255, 0.10);
  color: #d6e3ff;
  padding: 3px 10px;
  border-radius: 999px;
  font-family: var(--fmono);
  font-size: 11px;
}

.cf-empty {
  color: var(--dim);
  font-size: 13px;
  font-family: var(--fmono);
  padding: 20px 0;
}

/* lobby grid */
.lobby-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 14px;
}

.lobby-card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
  position: relative;
  overflow: hidden;
}

.lobby-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(130deg, rgba(55, 230, 255, 0.06), transparent 30%, rgba(166, 99, 255, 0.08));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}

.lobby-card:hover {
  transform: translateY(-3px);
  border-color: rgba(55, 230, 255, 0.24);
  box-shadow: var(--shadow-strong);
}

.lobby-card:hover::before {
  opacity: 1;
}

.lobby-own {
  border-color: rgba(25, 251, 155, 0.6) !important;
  box-shadow: 0 0 0 1px rgba(25, 251, 155, 0.08), var(--shadow);
}

.lc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lc-amt {
  font-family: var(--fdisplay);
  font-size: 20px;
  font-weight: 800;
  color: #ffffff;
  text-shadow: 0 0 18px rgba(255, 255, 255, 0.08);
}

.lc-chip {
  font-size: 11px;
  letter-spacing: 1px;
  padding: 4px 10px;
  border-radius: 999px;
  font-weight: 700;
  border: 1px solid transparent;
}

.chip-h {
  background: rgba(25, 251, 155, 0.10);
  color: var(--mint);
  border-color: rgba(25, 251, 155, 0.18);
}

.chip-t {
  background: rgba(166, 99, 255, 0.12);
  color: #d6b3ff;
  border-color: rgba(166, 99, 255, 0.18);
}

.lc-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: var(--fmono);
  font-size: 11px;
  color: var(--dim);
  word-break: break-word;
}

.lc-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.lc-mine {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--mint);
  font-weight: 700;
}

.lc-join {
  flex: 1;
}

/* pill bar */
.pill-bar {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 2px 12px;
  margin-bottom: 16px;
  scrollbar-width: thin;
  scrollbar-color: rgba(160, 193, 255, 0.28) transparent;
}

.pill {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-family: var(--fdisplay);
  font-size: 12px;
  font-weight: 800;
  transition: transform 0.15s, box-shadow 0.15s, filter 0.15s;
}

.pill:hover {
  transform: translateY(-2px) scale(1.1);
  filter: brightness(1.06);
}

.pill-h {
  background: linear-gradient(180deg, #65ffcc, #19fb9b);
  color: #052012;
}

.pill-t {
  background: linear-gradient(180deg, #d7a7ff, #a663ff);
  color: #1c093f;
}

.pill-new {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.72), 0 0 16px currentColor;
  transform: scale(1.08);
}

/* history table */
.hist-table-wrap {
  overflow-x: auto;
  border-radius: 16px;
  border: 1px solid rgba(160, 193, 255, 0.10);
  background: rgba(255, 255, 255, 0.02);
}

.hist-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--fmono);
  font-size: 13px;
}

.hist-table thead {
  background: rgba(255, 255, 255, 0.03);
}

.hist-table th {
  text-align: left;
  font-family: var(--fdisplay);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--dim);
  padding: 10px 12px;
  border-bottom: 1px solid rgba(160, 193, 255, 0.08);
}

.hist-table td {
  padding: 12px;
  border-bottom: 1px solid rgba(160, 193, 255, 0.06);
  cursor: pointer;
}

.hist-table tr:hover td {
  background: rgba(255, 255, 255, 0.03);
}

.chip-s {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--fdisplay);
}

.arr {
  color: var(--dim);
  font-size: 18px;
}

/* overlays */
.cf-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(2, 5, 12, 0.82);
  backdrop-filter: blur(10px) saturate(1.1);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

/* result card */
.cf-result-card {
  background: linear-gradient(180deg, rgba(12, 21, 37, 0.98), rgba(8, 13, 24, 0.94));
  border: 1px solid rgba(160, 193, 255, 0.12);
  border-radius: 22px;
  padding: 42px 36px;
  text-align: center;
  max-width: 360px;
  width: 100%;
  box-shadow: var(--shadow-strong);
  animation: popIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
  position: relative;
  overflow: hidden;
}

.cf-result-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(145deg, rgba(55, 230, 255, 0.06), transparent 30%, rgba(166, 99, 255, 0.08));
  pointer-events: none;
}

@keyframes popIn {
  from {
    transform: scale(0.7);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.r-won {
  border-color: rgba(25, 251, 155, 0.55);
  box-shadow: 0 0 0 1px rgba(25, 251, 155, 0.10), 0 0 60px rgba(25, 251, 155, 0.18);
}

.r-lost {
  border-color: rgba(255, 95, 125, 0.55);
  box-shadow: 0 0 0 1px rgba(255, 95, 125, 0.10), 0 0 60px rgba(255, 95, 125, 0.16);
}

.r-badge {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 800;
  font-family: var(--fdisplay);
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.rb-heads {
  background: radial-gradient(circle at 32% 30%, #90ffe0, #19fb9b 68%, #048057 100%);
  color: #052012;
  box-shadow: 0 0 30px rgba(25, 251, 155, 0.40);
}

.rb-tails {
  background: radial-gradient(circle at 32% 30%, #e1c2ff, #a663ff 68%, #5b23c0 100%);
  color: #1c093f;
  box-shadow: 0 0 30px rgba(166, 99, 255, 0.40);
}

.r-side {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 4px;
  color: #fff;
  position: relative;
  z-index: 1;
}

.r-verdict {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 2px;
  margin-top: 10px;
  position: relative;
  z-index: 1;
}

.r-sub {
  color: var(--dim);
  font-size: 13px;
  margin-top: 8px;
  position: relative;
  z-index: 1;
}

/* history modal */
.cf-hist-modal {
  background: linear-gradient(180deg, rgba(12, 21, 37, 0.98), rgba(8, 13, 24, 0.96));
  border: 1px solid rgba(160, 193, 255, 0.14);
  border-radius: 22px;
  padding: 28px;
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-strong);
  animation: popIn 0.25s ease;
}

.hm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.hm-label {
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--dim);
}

.hm-gid {
  font-family: var(--fmono);
  font-size: 13px;
  color: var(--cyan);
}

.hm-outcome {
  text-align: center;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid;
  font-family: var(--fdisplay);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 4px;
  margin-bottom: 16px;
}

.hm-heads {
  background: rgba(25, 251, 155, 0.08);
  border-color: rgba(25, 251, 155, 0.55);
  color: var(--mint);
}

.hm-tails {
  background: rgba(166, 99, 255, 0.10);
  border-color: rgba(166, 99, 255, 0.55);
  color: #d6b3ff;
}

.hm-rows {
  margin-bottom: 12px;
}

.hm-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(160, 193, 255, 0.06);
}

.hm-rl {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--dim);
}

.hm-rv {
  font-family: var(--fmono);
  font-size: 13px;
  text-align: right;
}

.hm-seed-row {
  margin-top: 12px;
}

.hm-slabel {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--dim);
  margin-bottom: 5px;
}

.hm-copybox {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(160, 193, 255, 0.10);
  border-radius: 14px;
  padding: 9px 12px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
  overflow: hidden;
}

.hm-copybox:hover {
  transform: translateY(-1px);
  border-color: rgba(55, 230, 255, 0.45);
  background: rgba(55, 230, 255, 0.05);
}

.hm-sval {
  font-family: var(--fmono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hm-icon {
  flex-shrink: 0;
  margin-left: 10px;
  color: var(--dim);
}

.hm-verify-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.vr {
  font-family: var(--fmono);
  font-size: 13px;
}

.vr-ok {
  color: var(--mint);
}

.vr-fail {
  color: var(--err);
}

.vr-wait {
  color: var(--dim);
}

/* footer */
.cf-footer {
  width: min(1140px, calc(100% - 32px));
  margin: 0 auto;
  border-top: 1px solid rgba(160, 193, 255, 0.10);
  padding: 16px 2px 26px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--fmono);
  font-size: 11px;
  color: var(--dim);
  gap: 12px;
}

@media (max-width: 720px) {
  .cf-footer {
    flex-direction: column;
    align-items: flex-start;
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={HELIUS_RPC}>
      <WalletProvider wallets={wallets} autoConnect={true}>
        <WalletModalProvider>
          <CoinflipUI />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
