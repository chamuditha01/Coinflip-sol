import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import { Buffer } from 'buffer';
import './App.css';
import { useNavigate } from 'react-router-dom';

// Solana Wallet Adapter
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';

require('@solana/wallet-adapter-react-ui/styles.css');
window.Buffer = Buffer;

const PROGRAM_ID = new web3.PublicKey("7B7qKQtG16Gf3qiYY5R5P1ym1AMm6dqffJbbYuyptZwk");
const COMMISSION_ADDRESS = new web3.PublicKey("3FSdF5cDCjkEsrcLEeCDkNBkLLHtpbSiqpxTbcENnydJ");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=3d1eb615-02f9-4796-ac88-be5f07f93ba5";

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


// Helper to parse the Rust log format: [1, 2, 3...] into Hex
const parseLogArray = (str) => {
    if (!str) return "N/A";
    const bytes = str.replace(/[\[\]]/g, '').split(',').map(Number);
    return Buffer.from(bytes).toString('hex');
};


useEffect(() => {
    if (!connection || !publicKey) return;

    // Lobby Listener
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
                    }
                } catch (e) {
                    // This block runs when the account is closed (Settled on-chain)
                    handleSettlement();
                    
                    // --- AUTO UPDATE HISTORY HERE ---
                    // Since the backend just finished, we fetch the new logs
                    setTimeout(() => fetchHistory(), 2000); 
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
    if (historyScrollRef.current) {
        historyScrollRef.current.scrollLeft = historyScrollRef.current.scrollWidth;
    }
    console.log("Current History Array:", gameHistory);
}, [gameHistory]); // Every time a new game is added, scroll to the end

const fetchHistory = async () => {
    try {
        // 1. Get transaction signatures involving your Program ID
        const signatures = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 10 });
        const parsedHistory = [];

        for (let sig of signatures) {
            // 2. Fetch the detailed transaction info
            const tx = await connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
            });

            if (tx && tx.meta && tx.meta.logMessages) {
                // 3. Find the specific "FLIP_RESULT" log we created in Rust
                const resultLog = tx.meta.logMessages.find(log => log.includes("FLIP_RESULT"));
                
                if (resultLog) {
                    // Extract data using Regex
                    const gameId = resultLog.match(/game_id=(\d+)/)?.[1];
                    const seedA = resultLog.match(/seed_a=\[(.*?)\]/)?.[1];
                    const seedB = resultLog.match(/seed_b=\[(.*?)\]/)?.[1];
                    const sSeed = resultLog.match(/server_seed=\[(.*?)\]/)?.[1];
                    const sHash = resultLog.match(/server_hash=\[(.*?)\]/)?.[1];
                    const winner = resultLog.match(/winner_side=(\d+)/)?.[1];

                    parsedHistory.push({
                        gameId,
                        seedA: parseLogArray(seedA),
                        seedB: parseLogArray(seedB),
                        serverSeed: parseLogArray(sSeed),
                        serverHash: parseLogArray(sHash),
                        winner: winner === "0" ? "HEADS" : "TAILS",
                        sig: sig.signature,
                        time: new Date(sig.blockTime * 1000).toLocaleTimeString()
                    });
                }
            }
        }
        setGameHistory(parsedHistory);
    } catch (e) {
        console.error("History fetch error:", e);
    }
};

// Call this in a useEffect or after a game settles
useEffect(() => {
    if (publicKey) fetchHistory();
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

    const handleSettlement = async () => {
        setSystemMsg("VERIFYING_OUTCOME...");
        setTimeout(async () => {
            const currentBalRaw = await connection.getBalance(publicKey);
            const currentBal = currentBalRaw / web3.LAMPORTS_PER_SOL;
            
            let won = currentBal > balanceBeforeFlip.current;
            const result = won ? selectedSide : (selectedSide === 0 ? 1 : 0);
            
            setFlippedResult(result);
            setResultModal(won ? 'WON' : 'LOST');
            setSystemMsg(won ? "LOBBY_SETTLED: WINNER" : "LOBBY_SETTLED: LOSER");
            
            setBalance(currentBal);
            setFlipping(false);
            setLoading(false);
            activePdaRef.current = null;
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
                        }
                    } catch (e) {
                        handleSettlement();
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

            <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
                <div className="header-row">
                    <h1 className="logo-text">SOL_FLIP_v2</h1>
                    <div className="wallet-info">
                        <div className="glass-panel balance-box">⚡ {balance.toFixed(3)} SOL</div>
                        <WalletMultiButton />
                        <div className="glass-panel balance-box">
                        <button 
      onClick={() => navigate('/verify')} // Change this path to your target route
      style={{
        padding: '10px 20px',
        backgroundColor: '#512da8', // Standard Solana purple
        color: 'white',
        border: 'none',
        borderRadius: '8px',
        width: '100%',
        height:'100%',
        cursor: 'pointer',
        fontWeight: 'bold',
        marginTop:'10px'
      }}
    >
      Verify Game
    </button></div>
                    </div>
                    
                </div>
{/* --- POPUP MODAL FOR HISTORY DETAILS --- */}
{selectedHistory && (
    <div 
        className="result-overlay" 
        style={{ 
            position: 'fixed', // Pins to the window, not the container
            top: 0, 
            left: 0, 
            width: '100vw', 
            height: '100vh', 
            zIndex: 9999,      // Ensures it is above everything
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)'
        }}
        onClick={() => setSelectedHistory(null)} // Close when clicking outside
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
            onClick={(e) => e.stopPropagation()} // Prevents closing when clicking inside
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
                    background: '#9945FF', // Matching your purple button
                    boxShadow: '0 0 15px rgba(153, 69, 255, 0.4)'
                }} 
                onClick={() => setSelectedHistory(null)}
            >
                CLOSE
            </button>
        </div>
    </div>
)}



    <div 
    className="history-bar-container" 
    ref={historyScrollRef}
    style={{ 
        display: 'flex', 
        flexDirection: 'row',         // Standard flow
       justifyContent: 'safe flex-end',  // Pushes all content to the right side
        alignItems: 'center',
        gap: '8px', 
        padding: '10px', 
        background: 'rgba(0,0,0,0.3)', 
        borderRadius: '10px',
        overflowX: 'auto',
        minHeight: '40px',
        width: '100%',                // Ensure container spans full width
        boxSizing: 'border-box'
    }}
>
    {/* We slice().reverse() so index 0 (newest) appears at the end of the row (right) */}
    {[...gameHistory].reverse().map((h, i) => {
        // Since we reversed, the newest game is now the last index in the map
        const isNewest = i === gameHistory.length - 1; 

        return (
            <div 
                key={i} 
                className="history-pill"
                onClick={() => setSelectedHistory(h)}
                style={{
                    height: '24px',
                    width: '12px',
                    borderRadius: '10px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    flexShrink: 0,
                    backgroundColor: h.winner === 'HEADS' ? '#14F195' : '#9945FF',
                    boxShadow: isNewest ? `0 0 12px ${h.winner === 'HEADS' ? '#14F195' : '#9945FF'}` : 'none',
                    border: isNewest ? '1px solid white' : 'none',
                    opacity: isNewest ? 1 : 0.7
                }}
            />
        );
    })}
</div>

                <div className="coin-container">
                    <div className={`coin ${flipping ? 'flipping' : ''}`}>
                        <div className="coin-front">H</div>
                        <div className="coin-back">T</div>
                    </div>
                </div>

                <div className="glass-panel main-controls">
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

                <h2 className="section-title">ACTIVE_LOBBIES</h2>
                <div className="lobby-grid">
                    {openGames.map(g => (
                        <div key={g.pubkey.toBase58()} className="glass-panel lobby-card">
                            <p className="lobby-amount">{Number(g.amount)/1e9} SOL</p>
                            <p className="lobby-creator">BY: {g.player_one.toBase58().slice(0,8)}...</p>
                            <p className="lobby-side">CREATOR PICKED: {g.player_one_side === 0 ? "HEADS" : "TAILS"}</p>
                            <button className="btn-primary join-btn" onClick={() => joinGame(g)} disabled={loading || flipping}>
                                {publicKey && g.player_one.equals(publicKey) ? "YOUR LOBBY" : "JOIN & FLIP"}
                            </button>
                        </div>
                    ))}
                    {openGames.length === 0 && <p className="no-lobbies">No active lobbies found...</p>}
                </div>

                
            </div>
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