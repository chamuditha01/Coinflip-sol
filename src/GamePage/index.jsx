import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import './App.css';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';

require('@solana/wallet-adapter-react-ui/styles.css');
window.Buffer = Buffer;

const PROGRAM_ID = new web3.PublicKey(process.env.REACT_APP_PROGRAM_ID);
const COMMISSION_ADDRESS = new web3.PublicKey(process.env.REACT_APP_COMMISSION_ADDRESS);
const HELIUS_RPC = process.env.REACT_APP_HELIUS_RPC;

class GameAccount {
    constructor(fields) {
        this.player_one = new web3.PublicKey(fields.player_one);
        this.player_two = new web3.PublicKey(fields.player_two);
        this.amount = fields.amount;
        this.player_one_side = fields.player_one_side;
        this.game_id = fields.game_id;
        this.status = fields.status;
        this.server_hash = fields.server_hash;
        this.client_seed_a = fields.client_seed_a;
        this.client_seed_b = fields.client_seed_b;
    }
}

const gameSchema = new Map([[GameAccount, {
    kind: 'struct',
    fields: [
        ['player_one', [32]], ['player_two', [32]], ['amount', 'u64'],
        ['player_one_side', 'u8'], ['game_id', 'u64'], ['status', 'u8'],
        ['server_hash', [32]], ['client_seed_a', [32]], ['client_seed_b', [32]],
        ['padding', [2]], 
    ]
}]]);

function CoinflipUI() {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    
    const [wager, setWager] = useState("0.1");
    const [selectedSide, setSelectedSide] = useState(0); 
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(false);
    const [flipping, setFlipping] = useState(false);
    const [systemMsg, setSystemMsg] = useState("LOBBY_READY");
    const [balance, setBalance] = useState(0);
    const [resultModal, setResultModal] = useState(null); 
    const [flippedResult, setFlippedResult] = useState(null); 
    const navigate = useNavigate();
    const [gameHistory, setGameHistory] = useState([]);
    const [selectedHistory, setSelectedHistory] = useState(null);
// Add this line with your other state declarations
const historyScrollRef = useRef(null);
    const settlementHandledRef = useRef(false);
    const historyRetryRef = useRef(null);
    const historyFetchInFlightRef = useRef(false);
    const historyLastFetchAtRef = useRef(0);


// Helper to parse the Rust log format: [1, 2, 3...] into Hex
const parseLogArray = (str) => {
    if (!str) return "N/A";
    const bytes = str.replace(/[\[\]]/g, '').split(',').map(Number);
    return Buffer.from(bytes).toString('hex');
};

const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex');

const readU64LE = (bytes, offset) => {
    const view = new DataView(Uint8Array.from(bytes).buffer);
    return Number(view.getBigUint64(offset, true));
};

const decodeInstructionData = (data) => {
    try {
        return bs58.decode(data);
    } catch (e) {
        return null;
    }
};

const toKeyString = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value.pubkey) return value.pubkey.toString();
    if (value.toBase58) return value.toBase58();
    if (value.toString) return value.toString();
    return null;
};

const getInstructionProgramId = (instruction, accountKeys) => {
    if (!instruction) return null;
    if (typeof instruction.programIdIndex === 'number') {
        return accountKeys[instruction.programIdIndex] || null;
    }
    return toKeyString(instruction.programId);
};

const getInstructionAccounts = (instruction, accountKeys) => {
    const rawIndexes = instruction?.accounts || [];
    return rawIndexes.map(index => accountKeys[index]).filter(Boolean);
};

useEffect(() => {
    if (historyScrollRef.current) {
        historyScrollRef.current.scrollLeft = Math.max(0, historyScrollRef.current.scrollWidth - historyScrollRef.current.clientWidth);
    }
    console.log("Current History Array:", gameHistory);
}, [gameHistory]); // Every time a new game is added, scroll to the end

const fetchParsedTransactionsInBatches = async (signatures, commitment = 'finalized', concurrency = 4) => {
    const txMap = new Map();
    for (let i = 0; i < signatures.length; i += concurrency) {
        const chunk = signatures.slice(i, i + concurrency);
        const promises = chunk.map(s => connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }, commitment)
            .then(tx => ({ sig: s.signature, tx }))
            .catch(err => ({ sig: s.signature, tx: null })));

        const resolved = await Promise.all(promises);
        for (const r of resolved) if (r.tx) txMap.set(r.sig, r.tx);
        // gentle pause to avoid hitting rate limits
        await new Promise(res => setTimeout(res, 120));
    }
    return txMap;
};

const fetchHistory = async (attempt = 0, commitment = 'confirmed', force = false) => {
    try {
        const now = Date.now();
        if (historyFetchInFlightRef.current) return;
        if (!force && now - historyLastFetchAtRef.current < 15000) return;
        historyFetchInFlightRef.current = true;
        console.debug(`fetchHistory: attempt=${attempt}`);
        const parsedHistory = [];
        const seenSignatures = new Set();
        let before = undefined;
        let pageCount = 0;
        const allSigs = [];
        const createByGameId = new Map();
        const createByPda = new Map();
        const joinByPda = new Map();

        // Walk multiple signature pages collecting signatures only
        while (pageCount < 3) {
            const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, {
                limit: 1000,
                ...(before ? { before } : {}),
            }, commitment);

            console.debug(`fetchHistory: collected page ${pageCount + 1} sigs=${sigs.length} before=${before}`,
                sigs.length ? [sigs[0].signature, sigs[sigs.length - 1].signature] : []);

            if (!sigs.length) break;
            before = sigs[sigs.length - 1].signature;
            pageCount += 1;

            for (const s of sigs) {
                if (!seenSignatures.has(s.signature)) {
                    seenSignatures.add(s.signature);
                    allSigs.push(s);
                }
            }
        }

        if (!allSigs.length) {
            // no signatures found - schedule retry
            if (attempt < 2) {
                if (historyRetryRef.current) clearTimeout(historyRetryRef.current);
                historyRetryRef.current = setTimeout(() => fetchHistory(attempt + 1, 'finalized', true), 6000);
            }
            return;
        }

        // Fetch parsed transactions in parallel batches
        const txMap = await fetchParsedTransactionsInBatches(allSigs, attempt === 0 ? commitment : 'finalized', 4);

        // PASS 1: Build create/join maps first (oldest to newest)
        const allSigsReversed = [...allSigs].reverse();
        for (const s of allSigsReversed) {
            const tx = txMap.get(s.signature);
            if (!tx) continue;

            const message = tx.transaction?.message;
            const accountKeys = message?.accountKeys?.map(toKeyString) || [];
            const instruction = message?.instructions?.find(ix => getInstructionProgramId(ix, accountKeys) === PROGRAM_ID.toBase58());
            const decoded = decodeInstructionData(instruction?.data);
            const accounts = getInstructionAccounts(instruction, accountKeys);

            if (decoded && decoded.length) {
                const variant = decoded[0];

                if (variant === 0) {
                    const gamePda = accounts[0];
                    const playerOne = accounts[1];
                    const gameId = readU64LE(decoded, 1);
                    const amountLamports = readU64LE(decoded, 9);
                    const playerOneSide = decoded[17];
                    const serverHash = bytesToHex(decoded.slice(18, 50));
                    const seedA = bytesToHex(decoded.slice(50, 82));

                    if (gamePda && gameId !== null && gameId !== undefined) {
                        const existing = createByGameId.get(String(gameId)) || {};
                        const next = {
                            ...existing,
                            gamePda,
                            gameId: String(gameId),
                            playerOne,
                            amountLamports,
                            playerOneSide,
                            seedA,
                            serverHash,
                        };
                        createByGameId.set(String(gameId), next);
                        createByPda.set(gamePda, next);
                    }
                }

                if (variant === 1) {
                    const gamePda = accounts[0];
                    const existing = gamePda ? (createByPda.get(gamePda) || {}) : {};
                    if (gamePda) {
                        joinByPda.set(gamePda, {
                            ...existing,
                            playerTwo: accounts[1] || existing.playerTwo || null,
                            seedB: bytesToHex(decoded.slice(1, 33)),
                        });
                    }
                }
            }
        }

        // PASS 2: Process settle logs with fully populated maps
        for (const s of allSigs) {
            const tx = txMap.get(s.signature);
            if (!tx) continue;

            const message = tx.transaction?.message;
            const accountKeys = message?.accountKeys?.map(toKeyString) || [];
            const instruction = message?.instructions?.find(ix => getInstructionProgramId(ix, accountKeys) === PROGRAM_ID.toBase58());
            const accounts = getInstructionAccounts(instruction, accountKeys);

            if (tx.meta && tx.meta.logMessages) {
                const detailedLog = tx.meta.logMessages.find(log => log.includes("FLIP_RESULT"));
                const simpleLog = tx.meta.logMessages.find(log => /RESULT: Side \d+ wins\./.test(log));

                if (detailedLog || simpleLog) {
                    const settleGamePda = accounts[1];
                    const fallbackGame = settleGamePda ? (createByPda.get(settleGamePda) || {}) : {};
                    const fallbackJoin = fallbackGame.gamePda ? (joinByPda.get(fallbackGame.gamePda) || {}) : {};

                    const gameId = detailedLog
                        ? detailedLog.match(/game_id=(\d+)/)?.[1]
                        : (fallbackGame.gameId || (s.blockTime ? String(s.blockTime) : s.signature.slice(0, 12)));

                    const seedA = detailedLog ? detailedLog.match(/seed_a=\[(.*?)\]/)?.[1] : null;
                    const seedB = detailedLog ? detailedLog.match(/seed_b=\[(.*?)\]/)?.[1] : null;
                    const sSeed = detailedLog ? detailedLog.match(/server_seed=\[(.*?)\]/)?.[1] : null;
                    const sHash = detailedLog ? detailedLog.match(/server_hash=\[(.*?)\]/)?.[1] : null;

                    const winnerRaw = detailedLog
                        ? detailedLog.match(/winner_side=(\d+)/)?.[1]
                        : simpleLog.match(/RESULT: Side (\d+) wins\./)?.[1];

                    parsedHistory.push({
                        gameId,
                        seedA: seedA ? parseLogArray(seedA) : (fallbackGame.seedA || 'N/A'),
                        seedB: seedB ? parseLogArray(seedB) : (fallbackJoin.seedB || 'N/A'),
                        serverSeed: sSeed ? parseLogArray(sSeed) : 'N/A',
                        serverHash: sHash ? parseLogArray(sHash) : (fallbackGame.serverHash || 'N/A'),
                        winner: winnerRaw === "0" ? "HEADS" : "TAILS",
                        sig: s.signature,
                        time: s.blockTime ? new Date(s.blockTime * 1000).toLocaleTimeString() : 'N/A'
                    });
                }
            }
        }

        parsedHistory.sort((a, b) => (Number(b.gameId) || 0) - (Number(a.gameId) || 0));

        setGameHistory(prevHistory => {
            const beforeLen = prevHistory.length;
            const merged = [...prevHistory];
            const seen = new Set(prevHistory.map(item => item.sig));

            for (const item of parsedHistory) {
                if (!seen.has(item.sig)) {
                    merged.push(item);
                    seen.add(item.sig);
                    console.debug('fetchHistory: merging new item', item.sig, item.gameId);
                }
            }

            merged.sort((a, b) => (Number(b.gameId) || 0) - (Number(a.gameId) || 0));
            console.debug(`fetchHistory: merged history size before=${beforeLen} after=${merged.length}`);
            return merged;
        });

        historyLastFetchAtRef.current = now;

        // If nothing parsed on the fast 'confirmed' pass, retry once with 'finalized'
        if (parsedHistory.length === 0 && attempt === 0) {
            if (historyRetryRef.current) clearTimeout(historyRetryRef.current);
            historyRetryRef.current = setTimeout(() => fetchHistory(attempt + 1, 'finalized', true), 7000);
        } else if (parsedHistory.length === 0 && attempt < 2) {
            if (historyRetryRef.current) clearTimeout(historyRetryRef.current);
            historyRetryRef.current = setTimeout(() => fetchHistory(attempt + 1, 'finalized', true), 9000);
        }
    } catch (e) {
        console.error("History fetch error:", e);
        if (attempt < 2) {
            if (historyRetryRef.current) clearTimeout(historyRetryRef.current);
            historyRetryRef.current = setTimeout(() => fetchHistory(attempt + 1, 'finalized', true), 9000);
        }
    } finally {
        historyFetchInFlightRef.current = false;
    }
};

// Call this in a useEffect or after a game settles
useEffect(() => {
    if (publicKey) fetchHistory(0, 'confirmed', false);
}, [publicKey]);
    
    const balanceBeforeFlip = useRef(0);
    const activePdaRef = useRef(null);

    const fetchBalance = async () => {
        if (!publicKey) return;
        const bal = await connection.getBalance(publicKey);
        setBalance(bal / web3.LAMPORTS_PER_SOL);
    };

    const fetchGames = async () => {
        try {
            const accounts = await connection.getProgramAccounts(PROGRAM_ID);
            const all = accounts.map(({ pubkey, account }) => {
                try { 
                    const decoded = borsh.deserialize(gameSchema, GameAccount, account.data);
                    return { pubkey, ...decoded }; 
                } catch (e) { return null; }
            }).filter(g => g !== null);

            setOpenGames(all.filter(g => g.status === 1));
        } catch (e) { console.error("Fetch Error:", e); }
    };

    const finalizeSettlement = async () => {
        if (settlementHandledRef.current) return;
        settlementHandledRef.current = true;

        if (historyRetryRef.current) {
            clearTimeout(historyRetryRef.current);
            historyRetryRef.current = null;
        }

        setSystemMsg("VERIFYING_OUTCOME...");
        setTimeout(async () => {
            try {
                const currentBalRaw = await connection.getBalance(publicKey);
                const currentBal = currentBalRaw / web3.LAMPORTS_PER_SOL;

                const won = currentBal > balanceBeforeFlip.current;
                const result = won ? selectedSide : (selectedSide === 0 ? 1 : 0);

                setFlippedResult(result);
                setResultModal(won ? 'WON' : 'LOST');
                setSystemMsg(won ? "LOBBY_SETTLED: WINNER" : "LOBBY_SETTLED: LOSER");
                setBalance(currentBal);
            } finally {
                setFlipping(false);
                setLoading(false);
                activePdaRef.current = null;
                settlementHandledRef.current = false;
                fetchHistory(0, 'finalized', true);
            }
        }, 4000);
    };

    useEffect(() => {
        if (!connection || !publicKey) return;

        const lobbySub = connection.onProgramAccountChange(
            PROGRAM_ID,
            () => fetchGames(),
            'confirmed'
        );

        let gameSub = null;
        if (activePdaRef.current && flipping) {
            gameSub = connection.onAccountChange(
                activePdaRef.current,
                (accountInfo) => {
                    try {
                        const data = borsh.deserialize(gameSchema, GameAccount, accountInfo.data);
                        if (data.status === 2) {
                            setSystemMsg("OPPONENT_FOUND! FLIPPING...");
                        } else if (data.status === 0 || data.status === 3) {
                            finalizeSettlement();
                        }
                    } catch (e) {
                        finalizeSettlement();
                    }
                },
                'confirmed'
            );
        }

        return () => {
            connection.removeAccountChangeListener(lobbySub);
            if (gameSub) connection.removeAccountChangeListener(gameSub);
        };
    }, [connection, publicKey, flipping]);

    useEffect(() => {
        fetchGames();
        fetchBalance();
    }, [publicKey]);

    useEffect(() => {
        return () => {
            if (historyRetryRef.current) clearTimeout(historyRetryRef.current);
        };
    }, []);

    const createGame = async () => {
        if (!publicKey) return;
        setLoading(true);
        setSystemMsg("INITIALIZING_HANDSHAKE...");
        try {
            const gameId = Math.floor(Date.now() / 1000);
            const response = await fetch('http://localhost:3001/generate-game', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameId })
            });
            const { serverHash } = await response.json();
            const clientSeedA = Array.from(window.crypto.getRandomValues(new Uint8Array(32)));
            
            const idBuffer = Buffer.alloc(8);
            idBuffer.writeBigUInt64LE(BigInt(gameId));
            const [pda] = await web3.PublicKey.findProgramAddress(
                [Buffer.from("game"), publicKey.toBuffer(), idBuffer], 
                PROGRAM_ID
            );

            const data = Buffer.alloc(1 + 8 + 8 + 1 + 32 + 32);
            let offset = 0;
            data.writeUInt8(0, offset); offset += 1;
            data.writeBigUInt64LE(BigInt(gameId), offset); offset += 8;
            data.writeBigUInt64LE(BigInt(Math.floor(parseFloat(wager) * web3.LAMPORTS_PER_SOL)), offset); offset += 8;
            data.writeUInt8(selectedSide, offset); offset += 1;
            Buffer.from(serverHash).copy(data, offset); offset += 32;
            Buffer.from(clientSeedA).copy(data, offset); offset += 32;

            const tx = new web3.Transaction().add(new web3.TransactionInstruction({
                keys: [
                    { pubkey: pda, isSigner: false, isWritable: true }, 
                    { pubkey: publicKey, isSigner: true, isWritable: true }, 
                    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }
                ],
                programId: PROGRAM_ID, data,
            }));

            await sendTransaction(tx, connection);
            
            balanceBeforeFlip.current = balance; 
            activePdaRef.current = pda;
            settlementHandledRef.current = false;
            setFlipping(true);
            setSystemMsg("LOBBY_OPEN: WAITING_FOR_OPPONENT");
            fetchGames();
        } catch (e) { 
            setSystemMsg("ERR: " + e.message); 
            setLoading(false); 
        } 
    };

    const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    // Optional: Add a toast notification or simple alert here
   // alert("Seed copied to clipboard!"); 
};

    const joinGame = async (game) => {
        if (!publicKey) return;
        const mySide = game.player_one_side === 0 ? 1 : 0;
        setSelectedSide(mySide);

        setLoading(true);
        setSystemMsg("JOINING_MATCH...");
        
        try {
            balanceBeforeFlip.current = balance;
            const clientSeedB = Array.from(window.crypto.getRandomValues(new Uint8Array(32)));
            const data = Buffer.alloc(1 + 32);
            data.writeUInt8(1, 0); 
            Buffer.from(clientSeedB).copy(data, 1);

            const tx = new web3.Transaction().add(new web3.TransactionInstruction({
                keys: [
                    { pubkey: game.pubkey, isSigner: false, isWritable: true },
                    { pubkey: publicKey, isSigner: true, isWritable: true },
                    { pubkey: game.player_one, isSigner: false, isWritable: true },
                    { pubkey: COMMISSION_ADDRESS, isSigner: false, isWritable: true },
                    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: PROGRAM_ID, data,
            }));

            const signature = await sendTransaction(tx, connection);
            setSystemMsg("CONFIRMING...");
            await connection.confirmTransaction(signature, 'confirmed');
            
            activePdaRef.current = game.pubkey;
            settlementHandledRef.current = false;
            setFlipping(true);
            setSystemMsg("MATCH_LIVE: FLIPPING...");
        } catch (e) { 
            setLoading(false);
            setSystemMsg("ERR: " + e.message); 
        }
    };

    return (
        <div className="app-container">
            {resultModal && (
                <div className="result-overlay">
                    <div className={`result-card ${resultModal === 'WON' ? 'glow-green' : 'glow-red'}`}>
                        <div className="result-coin-icon">
                            {flippedResult === 0 ? 'H' : 'T'}
                        </div>
                        <h2>{flippedResult === 0 ? 'HEADS' : 'TAILS'}</h2>
                        <h3 style={{ marginTop: '10px' }}>{resultModal === 'WON' ? '🏆 YOU WON!' : '💀 YOU LOST'}</h3>
                        <p>{resultModal === 'WON' ? 'SOL transferred to your wallet.' : 'The pot was taken by the opponent.'}</p>
                        <button className="btn-primary" style={{marginTop: '20px'}} onClick={() => {
                            setResultModal(null);
                            setFlippedResult(null);
                        }}>BACK TO LOBBY</button>
                    </div>
                </div>
            )}

            <Layout rightContent={
                <>
                    <div className="wallet-balance">{balance.toFixed(3)} SOL</div>
                    <WalletMultiButton />
                </>
            }>
                    <section className="hero-stage">
                        <div className={`hero-coin ${flipping ? 'flipping' : ''}`}>
                            <div className="coin-face coin-heads">H</div>
                            <div className="coin-face coin-tails">T</div>
                        </div>

                        <div className="control-panel glass-panel main-controls">
                            <p className="status-msg">{'>'} {systemMsg}</p>
                            <div className="input-group">
                                <input type="number" value={wager} onChange={e => setWager(e.target.value)} className="wager-input" disabled={flipping} />

                                <div className="side-toggle">
                                    <button 
                                        onClick={() => setSelectedSide(0)} 
                                        className={`side-btn ${selectedSide === 0 ? 'active' : ''}`}
                                    >
                                        HEADS
                                    </button>
                                    <button 
                                        onClick={() => setSelectedSide(1)} 
                                        className={`side-btn ${selectedSide === 1 ? 'active' : ''}`}
                                    >
                                        TAILS
                                    </button>
                                </div>

                                <button className="btn-primary create-btn" onClick={createGame} disabled={loading || flipping}>
                                    {loading && !flipping ? "SIGNING..." : "CREATE LOBBY"}
                                </button>
                            </div>
                        </div>
                    </section>

                    <section className="section-block">
                        <div className="section-head">
                            <h2 className="section-title">ACTIVE_LOBBIES</h2>
                            <div className="section-count">{openGames.length} TOTAL</div>
                        </div>

                        <div className="lobby-grid">
                            {openGames.map(g => (
                                <div key={g.pubkey.toBase58()} className="glass-panel lobby-card">
                                    <div className="lobby-card-top">
                                        <p className="lobby-amount">{Number(g.amount)/1e9} SOL</p>
                                        <span className="lobby-chip">{g.player_one_side === 0 ? 'HEADS' : 'TAILS'}</span>
                                    </div>
                                    <p className="lobby-id">ID: {g.pubkey.toBase58().slice(0, 6)}...{g.pubkey.toBase58().slice(-4)}</p>
                                    <p className="lobby-creator">CREATOR: {g.player_one.toBase58().slice(0,8)}...</p>
                                    <button className="btn-primary join-btn" onClick={() => joinGame(g)} disabled={loading || flipping}>
                                        {publicKey && g.player_one.equals(publicKey) ? "YOUR LOBBY" : "JOIN MATCH"}
                                    </button>
                                </div>
                            ))}

                            {openGames.length === 0 && <p className="no-lobbies">No active lobbies found...</p>}
                        </div>
                    </section>

                    <section className="section-block history-shell">
                        <div className="section-head">
                            <h2 className="section-title">HISTORY</h2>
                            <div className="section-count">LIVE FEED</div>
                        </div>

                        <div
                            className="history-bar-container"
                            ref={historyScrollRef}
                        >
                            {[...gameHistory].reverse().map((h, i) => {
                                const isNewest = i === gameHistory.length - 1;
                                return (
                                    <div 
                                        key={i}
                                        className="history-pill"
                                        onClick={() => setSelectedHistory(h)}
                                        title={`Game ${h.gameId}`}
                                        style={{
                                            backgroundColor: h.winner === 'HEADS' ? '#14F195' : '#9945FF',
                                            boxShadow: isNewest ? `0 0 12px ${h.winner === 'HEADS' ? '#14F195' : '#9945FF'}` : 'none',
                                            border: isNewest ? '1px solid rgba(255,255,255,0.8)' : '1px solid rgba(255,255,255,0.05)',
                                            opacity: isNewest ? 1 : 0.72
                                        }}
                                    />
                                );
                            })}
                        </div>
                    </section>

                </Layout>

{/* --- POPUP MODAL FOR HISTORY DETAILS --- */}
{selectedHistory && (
    <div 
        className="result-overlay" 
        style={{ 
            position: 'fixed',
            top: 0, 
            left: 0, 
            width: '100vw', 
            height: '100vh', 
            zIndex: 9999,
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)'
        }}
        onClick={() => setSelectedHistory(null)}
    >
        <div 
            className="glass-panel" 
            style={{ 
                width: '100%',
                maxWidth: '480px', 
                padding: '30px', 
                border: '1px solid #242d38',
                background: '#141a21',
                boxShadow: '0 20px 50px rgba(0,0,0,0.5)'
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="card-header" style={{ marginBottom: '25px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div className="status-dot"></div>
                <span style={{ fontSize: '12px', color: '#8a939f', fontWeight: 'bold' }}>⚖️ PROVABLY FAIR VERIFICATION</span>
            </div>

            <div className="v-input-box">
                <label>ROUND ID (GAME ID)</label>
                <div className="copy-box" onClick={() => copyToClipboard(selectedHistory.gameId)}>
                    <input readOnly value={selectedHistory.gameId} className="modal-input" />
                </div>
            </div>

            <div className="v-input-box">
                <label>PRIVATE HASH (SERVER COMMIT)</label>
                <div className="copy-box" onClick={() => copyToClipboard(selectedHistory.serverHash)}>
                    <input readOnly value={selectedHistory.serverHash} className="modal-input" />
                </div>
            </div>

            <div className="v-input-box">
                <label>PRIVATE SEED (SERVER REVEAL)</label>
                <div className="copy-box" onClick={() => copyToClipboard(selectedHistory.serverSeed)}>
                    <input readOnly value={selectedHistory.serverSeed} className="modal-input" />
                </div>
            </div>

            <div className="v-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div className="v-input-box">
                    <label>PUBLIC SEED A</label>
                    <input readOnly value={selectedHistory.seedA} className="modal-input" />
                </div>
                <div className="v-input-box">
                    <label>PUBLIC SEED B</label>
                    <input readOnly value={selectedHistory.seedB} className="modal-input" />
                </div>
            </div>

            <div className="v-input-box" style={{ marginTop: '10px' }}>
                <label>OUTCOME</label>
                <div style={{ 
                    padding: '14px', 
                    background: '#090c11', 
                    borderRadius: '8px', 
                    textAlign: 'center',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    color: selectedHistory.winner === 'HEADS' ? '#14F195' : '#9945FF',
                    border: `1px solid ${selectedHistory.winner === 'HEADS' ? '#14F19533' : '#9945FF33'}`
                }}>
                    {selectedHistory.winner}
                </div>
            </div>

            <button 
                className="btn-primary" 
                style={{ 
                    width: '100%', 
                    marginTop: '25px', 
                    padding: '16px',
                    background: '#9945FF',
                    boxShadow: '0 0 15px rgba(153, 69, 255, 0.4)'
                }} 
                onClick={() => setSelectedHistory(null)}
            >
                CLOSE
            </button>
        </div>
    </div>
)}

    </div>
    );
}

export default function App() {
    const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
    return (
        <ConnectionProvider endpoint={HELIUS_RPC}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider><CoinflipUI /></WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}