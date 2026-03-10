import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import { Buffer } from 'buffer';

// Solana Wallet Adapter Imports
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';

// Default styles for the wallet modal
require('@solana/wallet-adapter-react-ui/styles.css');

// Fix for Buffer in Browser
window.Buffer = Buffer;

// --- 1. PROGRAM CONSTANTS ---
const PROGRAM_ID = new web3.PublicKey("9Rh2RbZNVZBAjX4cp2KUaDix5wGR3MsQhPhM7LtbGg9Q");
const COMMISSION_ADDRESS = new web3.PublicKey("3FSdF5cDCjkEsrcLEeCDkNBkLLHtpbSiqpxTbcENnydJ");
const SLOT_HASHES_SYSVAR = new web3.PublicKey("SysvarS1otHashes111111111111111111111111111");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=3d1eb615-02f9-4796-ac88-be5f07f93ba5";

// --- 2. BORSH SCHEMAS ---
class GameAccount {
    constructor(fields) {
        this.player_one = new web3.PublicKey(fields.player_one);
        this.player_two = new web3.PublicKey(fields.player_two);
        this.amount = fields.amount;
        this.player_one_side = fields.player_one_side;
        this.game_id = fields.game_id;
        this.status = fields.status;
    }
}

const gameSchema = new Map([
    [GameAccount, {
        kind: 'struct',
        fields: [
            ['player_one', [32]],
            ['player_two', [32]],
            ['amount', 'u64'],
            ['player_one_side', 'u8'],
            ['game_id', 'u64'],
            ['status', 'u8'],
        ]
    }]
]);

class CoinflipInstruction {
    constructor(fields) {
        this.instruction = fields.instruction;
        this.game_id = fields.game_id;
        this.amount = fields.amount;
        this.side = fields.side;
    }
}

const instructionSchema = new Map([
    [CoinflipInstruction, {
        kind: 'struct',
        fields: [
            ['instruction', 'u8'],
            ['game_id', 'u64'],
            ['amount', 'u64'],
            ['side', 'u8'],
        ]
    }]
]);

// --- 3. ANIMATION CSS ---
const animationStyles = `
@keyframes flipHeads {
  from { transform: rotateY(0); }
  to { transform: rotateY(1800deg); }
}
@keyframes flipTails {
  from { transform: rotateY(0); }
  to { transform: rotateY(1980deg); }
}
.flipping-0 { animation: flipHeads 2s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
.flipping-1 { animation: flipTails 2s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
`;

// --- 4. MAIN GAME COMPONENT ---
function CoinflipUI() {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    
    const [balance, setBalance] = useState(0);
    const [selectedSide, setSelectedSide] = useState(0); 
    const [wager, setWager] = useState("0.1");
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(false);
    const [systemMsg, setSystemMsg] = useState("SYSTEM: INITIALIZING...");
    
    const [isFlipping, setIsFlipping] = useState(false);
    const [animationResult, setAnimationResult] = useState(null); 
    const [outcome, setOutcome] = useState(null); 
    
    const isFetching = useRef(false);
    const myCreatedGamesRef = useRef([]); 

    const getDeterministicResult = (gameId) => Number(BigInt(gameId) % 2n);

    // --- WALLET BALANCE LOGIC ---
    const fetchBalance = async () => {
        if (publicKey) {
            try {
                const bal = await connection.getBalance(publicKey);
                setBalance(bal / web3.LAMPORTS_PER_SOL);
            } catch (e) {
                console.error("Balance fetch error", e);
            }
        }
    };

    const triggerFlipAnimation = (result, userSide) => {
        setAnimationResult(result);
        setIsFlipping(true);
        setOutcome(null);

        setTimeout(() => {
            setIsFlipping(false);
            const didIWin = result === userSide;
            setOutcome(didIWin ? "WON" : "LOST");
            setSystemMsg(`SYSTEM: GAME RESOLVED. YOU ${didIWin ? "WON" : "LOST"}.`);
            fetchBalance(); // Refresh balance after result
        }, 2000);
    };

    const fetchGames = async () => {
        if (isFetching.current) return;
        isFetching.current = true;
        try {
            const accounts = await connection.getProgramAccounts(PROGRAM_ID);
            const allGames = accounts.map(({ pubkey, account }) => {
                try {
                    const decoded = borsh.deserialize(gameSchema, GameAccount, account.data);
                    return { pubkey, ...decoded };
                } catch (e) { return null; }
            }).filter(g => g !== null);

            const lobby = allGames.filter(g => g.status === 1);
            setOpenGames(lobby);

            if (publicKey) {
                myCreatedGamesRef.current.forEach(oldGame => {
                    const found = allGames.find(g => g.pubkey.equals(oldGame.pubkey));
                    if (found && found.status === 2) {
                        const result = getDeterministicResult(found.game_id);
                        triggerFlipAnimation(result, oldGame.player_one_side);
                    }
                });
                myCreatedGamesRef.current = lobby.filter(g => g.player_one.equals(publicKey));
            }

            setSystemMsg(publicKey ? "SYSTEM: LOBBY ACTIVE" : "SYSTEM: CONNECT WALLET");
        } catch (err) {
            if(err.message.includes("429")) setSystemMsg("SYSTEM: RPC_LIMIT_REACHED.");
        } finally {
            isFetching.current = false;
        }
    };

    useEffect(() => { 
        fetchGames();
        fetchBalance();

        // --- WEBSOCKET SUBSCRIPTION ---
        // Listen for any account changes belonging to our Program ID
        const subscriptionId = connection.onProgramAccountChange(
            PROGRAM_ID,
            () => {
                fetchGames();
                fetchBalance();
            },
            'confirmed'
        );

        return () => {
            connection.removeProgramAccountChangeListener(subscriptionId);
        };
    }, [connection, publicKey]);

    const getGamePda = async (userPubkey, id) => {
        const idBuffer = Buffer.alloc(8);
        idBuffer.writeBigUInt64LE(BigInt(id));
        const [pda] = await web3.PublicKey.findProgramAddress(
            [Buffer.from("game"), userPubkey.toBuffer(), idBuffer],
            PROGRAM_ID
        );
        return pda;
    };

    const createGame = async () => {
        if (!publicKey) return alert("Connect wallet!");
        
        const amountInLamports = BigInt(Math.floor(parseFloat(wager) * web3.LAMPORTS_PER_SOL));
        
        // --- AUTO-MATCH LOGIC ---
        // Look for a game with the same amount and the opposite side
        const match = openGames.find(g => 
            BigInt(g.amount) === amountInLamports && 
            g.player_one_side !== selectedSide &&
            !g.player_one.equals(publicKey) // Don't match against yourself
        );

        if (match) {
            setSystemMsg(`SYSTEM: MATCH FOUND! JOINING GAME...`);
            // Redirect to join logic
            return await joinAndFlip(
                match.pubkey, 
                match.player_one, 
                match.player_one_side, 
                match.game_id
            );
        }
        // --- END AUTO-MATCH LOGIC ---

        setLoading(true);
        setOutcome(null);
        setSystemMsg("SYSTEM: NO MATCH FOUND. INITIALIZING NEW LOBBY...");
        
        try {
            const gameId = Math.floor(Math.random() * 10000000);
            const pda = await getGamePda(publicKey, gameId);

            const instData = new CoinflipInstruction({ 
                instruction: 0, 
                game_id: BigInt(gameId), 
                amount: amountInLamports, 
                side: selectedSide 
            });
            const data = Buffer.from(borsh.serialize(instructionSchema, instData));

            const transaction = new web3.Transaction().add(
                new web3.TransactionInstruction({
                    keys: [
                        { pubkey: pda, isSigner: false, isWritable: true },
                        { pubkey: publicKey, isSigner: true, isWritable: true },
                        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                    ],
                    programId: PROGRAM_ID,
                    data,
                })
            );

            const signature = await sendTransaction(transaction, connection);
            await connection.confirmTransaction(signature, 'processed');
            setSystemMsg("SYSTEM: LOBBY CREATED.");
            fetchGames();
            fetchBalance();
        } catch (err) {
            console.error(err);
            setSystemMsg(`SYSTEM_ERROR: TRANSACTION FAILED`);
        } finally {
            setLoading(false);
        }
    };1

    const joinAndFlip = async (gamePda, playerOnePubkey, playerOneSide, gameId) => {
        if (!publicKey) return alert("Connect wallet!");
        setLoading(true);
        setOutcome(null);
        setSystemMsg("SYSTEM: EXECUTING FLIP...");
        
        try {
            const transaction = new web3.Transaction().add(
                new web3.TransactionInstruction({
                    keys: [
                        { pubkey: gamePda, isSigner: false, isWritable: true },
                        { pubkey: playerOnePubkey, isSigner: false, isWritable: true }, 
                        { pubkey: publicKey, isSigner: true, isWritable: true },
                        { pubkey: COMMISSION_ADDRESS, isSigner: false, isWritable: true },
                        { pubkey: SLOT_HASHES_SYSVAR, isSigner: false, isWritable: false },
                        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                    ],
                    programId: PROGRAM_ID,
                    data: Buffer.from([1]),
                })
            );

            const signature = await sendTransaction(transaction, connection);
            await connection.confirmTransaction(signature, 'confirmed');

            const result = getDeterministicResult(gameId);
            const mySide = playerOneSide === 0 ? 1 : 0;
            
            triggerFlipAnimation(result, mySide);
            setLoading(false);
            fetchGames();
            fetchBalance();

        } catch (err) {
            setSystemMsg("SYSTEM_ERROR: TRANSACTION FAILED.");
            setLoading(false);
        }
    };

    return (
        <div style={styles.container}>
            <style>{animationStyles}</style>
            
            <div style={styles.header}>
                <div>
                    <h1 style={styles.logo}>SOL_FLIP_V1</h1>
                    <div style={styles.subLogo}>SOLANA_WEBSOCKET_ENABLED</div>
                </div>
                <div style={styles.walletArea}>
                    {publicKey && (
                        <div style={styles.balanceDisplay}>
                            <span style={styles.balanceLabel}>WALLET_BAL:</span> {balance.toFixed(4)} SOL
                        </div>
                    )}
                    <WalletMultiButton />
                </div>
            </div>

            <div style={styles.coinContainer}>
                <div 
                    className={isFlipping ? `flipping-${animationResult}` : ''}
                    style={{
                        ...styles.coin, 
                        borderColor: outcome === "WON" ? "#00ff41" : outcome === "LOST" ? "#ff3e3e" : "#4e44ce",
                        boxShadow: outcome === "WON" ? "0 0 30px #00ff4144" : "0 0 30px rgba(78, 68, 206, 0.2)"
                    }}
                >
                    <div style={{ transform: isFlipping ? 'rotateY(0deg)' : 'none' }}>
                        {isFlipping ? "?" : (outcome ? (animationResult === 0 ? "HEADS" : "TAILS") : (selectedSide === 0 ? "HEADS" : "TAILS"))}
                    </div>
                </div>
                {outcome && (
                    <div style={{...styles.outcomeText, color: outcome === "WON" ? "#00ff41" : "#ff3e3e"}}>
                        {outcome === "WON" ? ">> DEPLOYMENT_SUCCESS: YOU_WIN" : ">> DEPLOYMENT_FAILURE: YOU_LOSE"}
                    </div>
                )}
            </div>

            <div style={styles.systemBox}>
                <span style={styles.dot}>•</span> {systemMsg}
            </div>

            <div style={styles.controlLabel}>INIT_GAME</div>
            <div style={styles.controls}>
                <div style={styles.inputWrapper}>
                    <input 
                        type="number" 
                        value={wager}
                        onChange={(e) => setWager(e.target.value)}
                        style={styles.input}
                    />
                    <span style={styles.inputUnit}>SOL</span>
                </div>
                <button 
                    onClick={() => {setSelectedSide(0); setOutcome(null);}} 
                    style={{...styles.sideBtn, backgroundColor: selectedSide === 0 ? '#ff9f1c' : '#1e2030', color: selectedSide === 0 ? '#000' : '#fff'}}
                >
                    CALL_HEADS
                </button>
                <button 
                    onClick={() => {setSelectedSide(1); setOutcome(null);}} 
                    style={{...styles.sideBtn, backgroundColor: selectedSide === 1 ? '#4e44ce' : '#1e2030'}}
                >
                    CALL_TAILS
                </button>
            </div>
            
            <button onClick={createGame} disabled={loading || isFlipping} style={styles.initBtn}>
                {loading ? "TRANSACTING..." : "INITIALIZE TRANSACTION"}
            </button>

            <div style={styles.controlLabel}>ACTIVE_LOBBY</div>
            <table style={styles.table}>
                <thead>
                    <tr style={styles.tableHeader}>
                        <th>ORIGIN</th>
                        <th>WAGER</th>
                        <th>SIDE</th>
                        <th>ACTION</th>
                    </tr>
                </thead>
                <tbody>
    {openGames.map((game) => {
        const isOwner = publicKey && game.player_one.equals(publicKey);
        const opponentSide = game.player_one_side === 0 ? "TAILS" : "HEADS";

        return (
            <tr key={game.pubkey.toBase58()} style={styles.tableRow}>
                <td>{game.player_one.toBase58().slice(0, 4)}...{game.player_one.toBase58().slice(-4)}</td>
                <td>{(Number(game.amount) / web3.LAMPORTS_PER_SOL).toFixed(2)}</td>
                <td style={{ color: game.player_one_side === 0 ? '#ff9f1c' : '#4e44ce' }}>
                    {game.player_one_side === 0 ? 'H' : 'T'}
                </td>
                <td>
                    {isOwner ? (
                        <div style={{ ...styles.joinBtn, backgroundColor: 'transparent', border: '1px solid #1e2030', color: '#6d70ad', textAlign: 'center' }}>
                            WAITING...
                        </div>
                    ) : (
                        <button 
                            onClick={() => joinAndFlip(game.pubkey, game.player_one, game.player_one_side, game.game_id)}
                            disabled={loading || isFlipping}
                            style={{ 
                                ...styles.joinBtn, 
                                backgroundColor: opponentSide === "TAILS" ? "#4e44ce" : "#ff9f1c" 
                            }}
                        >
                            CALL_{opponentSide}
                        </button>
                    )}
                </td>
            </tr>
        );
    })}
</tbody>
            </table>
        </div>
    );
}

// --- 5. STYLES ---
const styles = {
    container: { backgroundColor: '#0a0b14', minHeight: '100vh', padding: '40px', color: '#fff', fontFamily: '"Courier New", Courier, monospace' },
    header: { display: 'flex', justifyContent: 'space-between', marginBottom: '20px', alignItems: 'flex-start' },
    logo: { fontSize: '32px', margin: 0, letterSpacing: '4px' },
    subLogo: { color: '#4a4d6d', fontSize: '12px', marginTop: '4px' },
    walletArea: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' },
    balanceDisplay: { color: '#00ff41', fontSize: '14px', fontWeight: 'bold', border: '1px solid #00ff4133', padding: '5px 10px', background: '#00ff410a' },
    balanceLabel: { color: '#4a4d6d', marginRight: '5px' },
    coinContainer: { display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '40px 0', perspective: '1000px' },
    coin: { width: '160px', height: '160px', borderRadius: '50%', border: '4px solid #4e44ce', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px', fontWeight: 'bold', transition: 'all 0.4s ease', transformStyle: 'preserve-3d', backgroundColor: '#05060b' },
    outcomeText: { marginTop: '20px', fontSize: '18px', fontWeight: 'bold', letterSpacing: '1px' },
    systemBox: { border: '1px solid #1e2030', padding: '15px', color: '#6d70ad', fontSize: '14px', marginBottom: '40px' },
    dot: { color: '#4e44ce', marginRight: '10px' },
    controlLabel: { color: '#3d3f5e', fontSize: '12px', marginBottom: '10px', borderBottom: '1px solid #1e2030', paddingBottom: '5px' },
    controls: { display: 'flex', gap: '10px', marginBottom: '10px' },
    inputWrapper: { position: 'relative', flex: 2 },
    input: { width: '100%', padding: '15px', background: '#05060b', border: '1px solid #1e2030', color: '#fff', boxSizing: 'border-box', outline: 'none', fontSize: '18px' },
    inputUnit: { position: 'absolute', right: '15px', top: '18px', color: '#3d3f5e' },
    sideBtn: { flex: 1, border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', color: '#fff', transition: '0.2s' },
    initBtn: { width: '100%', padding: '12px', background: 'transparent', border: '1px solid #4e44ce', color: '#4e44ce', cursor: 'pointer', marginBottom: '40px', fontWeight: 'bold' },
    table: { width: '100%', borderCollapse: 'collapse' },
    tableHeader: { textAlign: 'left', color: '#3d3f5e', fontSize: '12px' },
    tableRow: { borderBottom: '1px solid #1e2030' },
    joinBtn: { background: '#4e44ce', border: 'none', color: '#fff', padding: '8px 20px', cursor: 'pointer', margin: '10px 0', fontWeight: 'bold' }
};

// --- 6. EXPORT ---
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