"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Buffer } from 'buffer';
import * as solanaWeb3 from '@solana/web3.js'; 
import { 
    Connection, 
    PublicKey, 
    LAMPORTS_PER_SOL,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram 
} from '@solana/web3.js';
import { useWallet, WalletProvider, ConnectionProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { BN } from '@coral-xyz/anchor';
import { sha256 } from 'js-sha256';

// --- MOBILE ADAPTER IMPORTS ---
import { 
    SolanaMobileWalletAdapter, 
    createDefaultAddressSelector, 
    createDefaultAuthorizationResultCache 
} from '@solana-mobile/wallet-adapter-mobile';

import '@solana/wallet-adapter-react-ui/styles.css';

if (typeof window !== "undefined") {
    window.Buffer = window.Buffer || Buffer;
}

const programId = new PublicKey("3pitCpDAFY5jtyYvTUKrUuMHT19GqzA2sea8jhvjJBRq");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=9ebecfca-c573-46b6-bca1-dd74dd15c760";
const DEVNET_WSS = "wss://api.devnet.solana.com";
const COMMISSION_ADDRESS = new PublicKey("3FSdF5cDCjkEsrcLEeCDkNBkLLHtpbSiqpxTbcENnydJ");

const getDiscriminator = (name) => {
    const hash = sha256.digest(`global:${name}`);
    return Array.from(hash.slice(0, 8));
};

const CoinFlipUI = () => {
    const wallet = useWallet();
    const [openGames, setOpenGames] = useState([]);
    const [amount, setAmount] = useState(0.1);
    const [status, setStatus] = useState({ msg: "SYSTEM: INITIALIZING...", type: "info" });
    const [pendingGamePda, setPendingGamePda] = useState(null);
    const [flipState, setFlipState] = useState("idle"); 
    const [lastResult, setLastResult] = useState(null);
    const [balance, setBalance] = useState(0);

    const connection = useMemo(() => new Connection(HELIUS_RPC, {
        commitment: "confirmed",
        wsEndpoint: DEVNET_WSS
    }), []);

    const fetchBalance = useCallback(async () => {
        if (wallet.publicKey) {
            try {
                const balanceInLamports = await connection.getBalance(wallet.publicKey);
                setBalance(balanceInLamports / LAMPORTS_PER_SOL);
            } catch (err) {
                console.error("Balance Fetch Error:", err);
            }
        }
    }, [connection, wallet.publicKey]);

    useEffect(() => {
        fetchBalance();
    }, [fetchBalance, openGames]);

    const getDetailedResult = useCallback(async (signature) => {
        try {
            await new Promise(r => setTimeout(r, 2000)); 
            const tx = await connection.getTransaction(signature, { 
                commitment: "confirmed", 
                maxSupportedTransactionVersion: 0 
            });
            if (!tx?.meta?.logMessages) return null;
            const eventLog = tx.meta.logMessages.find(log => log.startsWith("Program data: "));
            if (!eventLog) return null;
            const rawData = Buffer.from(eventLog.replace("Program data: ", ""), 'base64');
            const winnerPubkey = new PublicKey(rawData.slice(16, 48)).toBase58();
            const sideWon = rawData[rawData.length - 1]; 
            return {
                won: winnerPubkey === wallet.publicKey.toBase58(),
                sideWon: sideWon === 0 ? "HEADS" : "TAILS"
            };
        } catch (e) { return null; }
    }, [connection, wallet.publicKey]);

    const fetchLobby = useCallback(async () => {
        try {
            const accounts = await connection.getProgramAccounts(programId, {
                filters: [{ dataSize: 90 }, { memcmp: { offset: 89, bytes: "1" } }]
            });
            const decoded = accounts.map(acc => {
                const data = acc.account.data;
                return {
                    publicKey: acc.pubkey,
                    playerOne: new PublicKey(data.slice(8, 40)),
                    amount: new BN(data.slice(72, 80), 'le'),
                    side: data[80],
                };
            });
            setOpenGames(decoded);
        } catch (err) { console.error(err); }
    }, [connection]);

    useEffect(() => {
        const subId = connection.onProgramAccountChange(programId, () => fetchLobby(), "confirmed", [{ dataSize: 90 }]);
        return () => { connection.removeProgramAccountChangeListener(subId).catch(() => {}); };
    }, [connection, fetchLobby]);

    useEffect(() => {
        if (!pendingGamePda || !wallet.publicKey) return;
        const subId = connection.onAccountChange(pendingGamePda, async (accountInfo) => {
            if (accountInfo.data[89] === 2) { 
                setFlipState("flipping");
                setTimeout(async () => {
                    const sigs = await connection.getSignaturesForAddress(pendingGamePda, { limit: 1 });
                    const result = await getDetailedResult(sigs[0].signature);
                    if (result) {
                        setFlipState(result.sideWon === "HEADS" ? "land-heads" : "land-tails");
                        setLastResult({ side: result.sideWon, won: result.won });
                        setStatus({ 
                            msg: result.won ? `>> TRANSACTION SUCCESS: RECEIVED 2X REWARD` : `>> TRANSACTION VOID: BET LOST`, 
                            type: result.won ? "success" : "error" 
                        });
                    }
                    setPendingGamePda(null);
                    fetchLobby();
                    fetchBalance();
                }, 3000);
            }
        }, "confirmed");
        return () => { connection.removeAccountChangeListener(subId).catch(() => {}); };
    }, [pendingGamePda, wallet.publicKey, connection, fetchLobby, getDetailedResult, fetchBalance]);

    useEffect(() => { fetchLobby(); }, [fetchLobby]);

    // --- MOBILE OPTIMIZED HELPER ---
 const sendMobileFriendlyTx = async (instructions) => {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet Not Linked");
    
    // 1. Fetch the latest blockhash with 'finalized' commitment for extra time on mobile
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    
    // 2. Compile to a Versioned Message
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            // Add priority fees to ensure it lands during network congestion
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25000 }),
            ...instructions
        ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    
    // 3. Request signature from Phantom
    const signedTx = await wallet.signTransaction(transaction);
    
    // 4. Send the raw signed bytes directly
    // skipPreflight: true is CRITICAL for mobile to prevent premature simulation failures
    const signature = await connection.sendRawTransaction(signedTx.serialize(), { 
        skipPreflight: true, 
        maxRetries: 2 
    });

    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    return signature;
};

    const createGame = async (side) => {
    if (!wallet.publicKey) return;
    try {
        // 1. MATCHING LOGIC: Search for a matching opponent in the lobby
        const targetAmountLamports = amount * LAMPORTS_PER_SOL;
        const opponentSide = side === 0 ? 1 : 0; // If user calls Heads (0), look for Tails (1)

        const matchingGame = openGames.find(game => 
            game.amount.toNumber() === targetAmountLamports && 
            game.side === opponentSide &&
            !game.playerOne.equals(wallet.publicKey) // Don't match with yourself
        );

        // 2. If a match is found, join that game instead of creating a new one
        if (matchingGame) {
            setStatus({ msg: ">> MATCH FOUND! JOINING GAME...", type: "info" });
            await joinAndFlip(matchingGame);
            return; // Exit function
        }

        // 3. If no match found, proceed with existing Create Game logic
        setStatus({ msg: ">> NO MATCH FOUND. REQUESTING WALLET SIGNATURE...", type: "info" });
        setFlipState("idle");

        const gameId = new BN(Math.floor(Math.random() * 1000000));
        const [gamePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("game"), wallet.publicKey.toBuffer(), gameId.toArrayLike(Buffer, "le", 8)],
            programId
        );
        
        const ix = new solanaWeb3.TransactionInstruction({
            keys: [
                { pubkey: gamePda, isSigner: false, isWritable: true },
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId,
            data: Buffer.concat([
                Buffer.from(getDiscriminator("create_game")),
                gameId.toArrayLike(Buffer, "le", 8),
                new BN(targetAmountLamports).toArrayLike(Buffer, "le", 8),
                Buffer.from([side])
            ]),
        });

        await sendMobileFriendlyTx([ix]);
        
        setPendingGamePda(gamePda);
        setStatus({ msg: ">> LOBBY ACTIVE: WAITING FOR PEER", type: "success" });
        fetchLobby();
        fetchBalance();
    } catch (err) { 
        console.error("Game Initiation Error:", err);
        setStatus({ msg: ">> FAILED: CHECK BALANCE OR REJECTED", type: "error" }); 
    }
};

    const joinAndFlip = async (game) => {
    if (!wallet.publicKey) return;
    try {
        setStatus({ msg: ">> REQUESTING WALLET SIGNATURE...", type: "info" });
        
        const data = Buffer.from(getDiscriminator("join_and_flip"));
        
        // Use the same helper, but we define the instructions carefully
        const instructions = [
            // Ensure the program has enough "gas" for the random number generation
            ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }), 
            new solanaWeb3.TransactionInstruction({
                keys: [
                    { pubkey: game.publicKey, isSigner: false, isWritable: true },
                    { pubkey: game.playerOne, isSigner: false, isWritable: true },
                    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                    { pubkey: COMMISSION_ADDRESS, isSigner: false, isWritable: true },
                    { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId,
                data,
            })
        ];

        // This uses the Versioned Transaction logic we added to sendMobileFriendlyTx
        const sig = await sendMobileFriendlyTx(instructions);
        
        setFlipState("flipping");
        setStatus({ msg: ">> BROADCAST SUCCESS: FLIPPING...", type: "info" });

        const result = await getDetailedResult(sig);
        
        setTimeout(() => {
            if (result) {
                setFlipState(result.sideWon === "HEADS" ? "land-heads" : "land-tails");
                setLastResult({ side: result.sideWon, won: result.won });
                setStatus({ 
                    msg: result.won ? `>> SYSTEM: WINNER IDENTIFIED` : `>> SYSTEM: DEFEAT DETECTED`, 
                    type: result.won ? "success" : "error" 
                });
            }
            fetchLobby();
            fetchBalance();
        }, 3000);
        
    } catch (err) { 
        console.error("Join Flip Error:", err);
        setFlipState("idle"); 
        // This will now show the actual error message from the program if available
        const errorMsg = err.message ? err.message.slice(0, 35) : "TRANSACTION FAILED";
        setStatus({ msg: `>> ${errorMsg.toUpperCase()}`, type: "error" });
    }
};

    return (
        <div style={styles.container}>
            <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;500;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
            <style>{`
                @keyframes coin-spin { 0% { transform: rotateY(0); } 100% { transform: rotateY(1800deg); } }
                @keyframes scanline { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
                @keyframes pulse { 0% { opacity: 0.5; } 50% { opacity: 1; } 100% { opacity: 0.5; } }
                .coin-container { width: 140px; height: 140px; margin: 0 auto 30px; perspective: 1000px; filter: drop-shadow(0 0 20px rgba(99, 102, 241, 0.6)); }
                .coin { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; transition: transform 3s cubic-bezier(0.2, 0.8, 0.2, 1); }
                .state-flipping { animation: coin-spin 0.6s infinite linear; }
                .state-land-heads { transform: rotateY(1800deg); }
                .state-land-tails { transform: rotateY(1980deg); }
                .coin-side { position: absolute; width: 100%; height: 100%; border-radius: 50%; backface-visibility: hidden; display: flex; align-items: center; justify-content: center; font-weight: 900; font-family: 'Space Grotesk'; border: 6px solid #818cf8; font-size: 20px; background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); color: #fff; text-shadow: 0 0 10px rgba(255,255,255,0.5); }
                .tails { transform: rotateY(180deg); border-color: #6366f1; }
                .scanline { position: fixed; top: 0; left: 0; width: 100%; height: 10px; background: rgba(129, 140, 248, 0.1); z-index: 10; animation: scanline 4s linear infinite; pointer-events: none; }
                .crypto-button { transition: all 0.2s; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono'; font-weight: 700; }
                .crypto-button:hover { transform: scale(1.05); filter: brightness(1.2); }
                .crypto-button:active { transform: scale(0.95); }
            `}</style>
            <div className="scanline"></div>
            <div style={styles.card}>
                <header style={styles.header}>
                    <div>
                        <h1 style={styles.title}>SOL_FLIP_V1</h1>
                        <p style={styles.subtitle}>DECENTRALIZED_COIN_TOSS</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                        <WalletMultiButton style={styles.walletBtn} />
                        {wallet.connected && (
                            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: '12px', color: '#34d399', background: 'rgba(52, 211, 153, 0.1)', padding: '4px 8px', borderRadius: '2px', border: '1px solid rgba(52, 211, 153, 0.3)' }}>
                                BAL: {balance.toFixed(4)} SOL
                            </div>
                        )}
                    </div>
                </header>
                <div className="coin-container">
                    <div className={`coin state-${flipState}`}>
                        <div className="coin-side heads">HEADS</div>
                        <div className="coin-side tails">TAILS</div>
                    </div>
                </div>
                <div style={{...styles.status, color: status.type === "success" ? "#34d399" : status.type === "error" ? "#f87171" : "#818cf8", borderColor: status.type === "success" ? "#065f46" : status.type === "error" ? "#7f1d1d" : "#312e81" }}>
                    <span style={{animation: 'pulse 1.5s infinite'}}>●</span> {status.msg}
                </div>
                <div style={styles.section}>
                    <h3 style={styles.sectionTitle}>INIT_GAME</h3>
                    <div style={styles.inputArea}>
                        <div style={styles.inputWrapper}>
                            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} style={styles.input} />
                            <span style={styles.solLabel}>SOL</span>
                        </div>
                        <button onClick={() => createGame(0)} className="crypto-button" style={styles.btnHeads}>CALL_HEADS</button>
                        <button onClick={() => createGame(1)} className="crypto-button" style={styles.btnTails}>CALL_TAILS</button>
                    </div>
                </div>
                <div style={styles.section}>
                    <h3 style={styles.sectionTitle}>ACTIVE_LOBBY</h3>
                    <div style={styles.tableContainer}>
                        {openGames.length === 0 ? <p style={styles.emptyMsg}>NO_PEERS_DETECTED...</p> : (
                            <table style={styles.table}>
                                <thead>
                                    <tr style={styles.tHead}>
                                        <th>ORIGIN</th>
                                        <th>WAGER</th>
                                        <th>SIDE</th>
                                        <th>ACTION</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {openGames.map((game, i) => {
                                        const isMine = wallet.publicKey && game.playerOne.equals(wallet.publicKey);
                                        return (
                                            <tr key={i} style={styles.row}>
                                                <td style={styles.cell}>{isMine ? "USER" : `${game.playerOne.toBase58().slice(0,6)}`}</td>
                                                <td style={styles.cell}>{game.amount.toNumber() / LAMPORTS_PER_SOL}</td>
                                                <td style={{...styles.cell, color: game.side === 0 ? '#f59e0b' : '#6366f1'}}>{game.side === 0 ? "H" : "T"}</td>
                                                <td style={styles.cell}>
                                                    <button onClick={() => joinAndFlip(game)} disabled={isMine} className="crypto-button" style={isMine ? styles.btnWait : styles.btnJoin}>
                                                        {isMine ? "WAIT" : "FLIP"}
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const styles = {
    container: { 
        background: '#020617', 
        color: '#f8fafc', 
        minHeight: '100vh', 
        padding: '20px', 
        fontFamily: "'JetBrains Mono', monospace",
        // Deep space background with a subtle purple radial glow
        backgroundImage: 'radial-gradient(circle at 50% 10%, #1e1b4b 0%, #020617 100%)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
    },
    card: { 
        width: '100%',
        maxWidth: '550px', 
        background: 'rgba(7, 10, 25, 0.85)', 
        padding: 'clamp(24px, 5vw, 40px)', 
        borderRadius: '16px', 
        border: '1px solid rgba(99, 102, 241, 0.3)', // Indigo border
        backdropFilter: 'blur(20px)',
        boxShadow: '0 0 40px rgba(0, 0, 0, 0.8), inset 0 0 20px rgba(99, 102, 241, 0.05)',
        position: 'relative'
    },
    title: { 
        fontSize: '26px', 
        margin: 0, 
        fontWeight: 900, 
        color: '#fff', 
        textShadow: '0 0 15px rgba(255, 255, 255, 0.2)' 
    },
    subtitle: { 
        fontSize: '11px', 
        margin: '4px 0 0', 
        color: '#818cf8', // Electric Indigo
        textTransform: 'uppercase',
        letterSpacing: '3px'
    },
    status: { 
        padding: '16px', 
        background: 'rgba(15, 23, 42, 0.9)', 
        borderRadius: '10px', 
        border: '1px solid', 
        marginBottom: '30px', 
        fontSize: '12px', 
        display: 'flex', 
        gap: '12px', 
        alignItems: 'center',
        boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
    },
    sectionTitle: { 
        color: '#6366f1', // Vibrant Indigo
        fontSize: '12px', 
        marginBottom: '15px', 
        fontWeight: 'bold',
        letterSpacing: '1.5px',
        borderLeft: '3px solid #6366f1',
        paddingLeft: '10px'
    },
    input: { 
        background: '#000', 
        border: '1px solid #312e81', 
        color: '#10b981', // Neon Emerald
        padding: '16px', 
        borderRadius: '10px', 
        width: '100%', 
        outline: 'none',
        fontSize: '18px', 
        fontWeight: 'bold', 
        fontFamily: "'JetBrains Mono'",
        boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)'
    },
    solLabel: { position: 'absolute', right: '15px', top: '18px', color: '#6366f1', fontSize: '12px', fontWeight: 'bold' },
    // Color Palette: Amber/Gold for Heads, Royal Purple for Tails
    btnHeads: { 
        background: 'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)', 
        color: '#000', 
        padding: '16px', 
        borderRadius: '10px', 
        boxShadow: '0 0 15px rgba(251, 191, 36, 0.4)' 
    },
    btnTails: { 
        background: 'linear-gradient(135deg, #818cf8 0%, #4f46e5 100%)', 
        color: '#fff', 
        padding: '16px', 
        borderRadius: '10px', 
        boxShadow: '0 0 15px rgba(99, 102, 241, 0.4)' 
    },
    btnJoin: { 
        background: '#10b981', 
        color: '#000', 
        padding: '8px 20px', 
        borderRadius: '6px', 
        fontWeight: 'bold',
        boxShadow: '0 0 10px rgba(16, 185, 129, 0.3)'
    }
};



export default function App() {
    // --- UPDATED WALLETS FOR MOBILE ---
    const wallets = useMemo(() => [
        new SolanaMobileWalletAdapter({
            addressSelector: createDefaultAddressSelector(),
            appIdentity: {
                name: 'SolFlip',
                uri: typeof window !== 'undefined' ? window.location.origin : 'https://solflip.io',
                icon: 'favicon.ico',
            },
            authorizationResultCache: createDefaultAuthorizationResultCache(),
            cluster: 'devnet',
        }),
    ], []);

    return (
        <ConnectionProvider endpoint={HELIUS_RPC}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <CoinFlipUI />
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}