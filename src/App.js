import React, { useState, useMemo, useEffect } from 'react';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import { Buffer } from 'buffer';

// Solana Wallet Adapter
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';

require('@solana/wallet-adapter-react-ui/styles.css');
window.Buffer = Buffer;

// --- CONFIGURATION ---
const PROGRAM_ID = new web3.PublicKey("7B7qKQtG16Gf3qiYY5R5P1ym1AMm6dqffJbbYuyptZwk");
const COMMISSION_ADDRESS = new web3.PublicKey("3FSdF5cDCjkEsrcLEeCDkNBkLLHtpbSiqpxTbcENnydJ");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=3d1eb615-02f9-4796-ac88-be5f07f93ba5";

// --- SCHEMA ---
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
        ['player_one', [32]],
        ['player_two', [32]],
        ['amount', 'u64'],
        ['player_one_side', 'u8'],
        ['game_id', 'u64'],
        ['status', 'u8'],
        ['server_hash', [32]],
        ['client_seed_a', [32]],
        ['client_seed_b', [32]],
        ['padding', [2]], 
    ]
}]]);

const generate32ByteSeed = () => {
    return Array.from(window.crypto.getRandomValues(new Uint8Array(32)));
};

function CoinflipUI() {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [wager, setWager] = useState("0.1");
    const [selectedSide, setSelectedSide] = useState(0); // 0: Heads, 1: Tails
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(false);
    const [systemMsg, setSystemMsg] = useState("SYSTEM: PROVABLY FAIR MODE ACTIVE");

    const fetchGames = async () => {
        try {
            const accounts = await connection.getProgramAccounts(PROGRAM_ID);
            const all = accounts.map(({ pubkey, account }) => {
                try { 
                    const decoded = borsh.deserialize(gameSchema, GameAccount, account.data);
                    return { pubkey, ...decoded }; 
                } catch (e) { return null; }
            }).filter(g => g !== null && g.status === 1);
            setOpenGames(all);
        } catch (e) { console.error("Fetch Error:", e); }
    };

    useEffect(() => { 
        fetchGames();
        const interval = setInterval(fetchGames, 5000);
        return () => clearInterval(interval);
    }, [publicKey]);

    const createGame = async () => {
        if (!publicKey) return;
        setLoading(true);
        setSystemMsg("SYNCING WITH HOUSE SERVER...");

        try {
            const gameId = Math.floor(Date.now() / 1000);
            const response = await fetch('http://localhost:3001/generate-game', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameId: gameId })
            });

            if (!response.ok) throw new Error("House server failed");
            const { serverHash } = await response.json();
            const clientSeedA = generate32ByteSeed();
            
            const idBuffer = Buffer.alloc(8);
            idBuffer.writeBigUInt64LE(BigInt(gameId));
            
            const [pda] = await web3.PublicKey.findProgramAddress(
                [Buffer.from("game"), publicKey.toBuffer(), idBuffer], 
                PROGRAM_ID
            );

            // Build Instruction Data
            const data = Buffer.alloc(1 + 8 + 8 + 1 + 32 + 32);
            let offset = 0;
            data.writeUInt8(0, offset); offset += 1; // Discriminator CreateGame
            data.writeBigUInt64LE(BigInt(gameId), offset); offset += 8;
            data.writeBigUInt64LE(BigInt(parseFloat(wager) * web3.LAMPORTS_PER_SOL), offset); offset += 8;
            data.writeUInt8(selectedSide, offset); offset += 1; // USER SELECTED SIDE
            Buffer.from(serverHash).copy(data, offset); offset += 32;
            Buffer.from(clientSeedA).copy(data, offset); offset += 32;

            const tx = new web3.Transaction().add(
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

            const sig = await sendTransaction(tx, connection);
            setSystemMsg("LOBBY CREATED! WAITING FOR OPPONENT...");
            await connection.confirmTransaction(sig, 'confirmed');
            fetchGames(); 
        } catch (e) { 
            setSystemMsg("ERROR: " + e.message); 
        } finally { setLoading(false); }
    };

    const joinGame = async (game) => {
        if (!publicKey) return;
        setLoading(true);
        setSystemMsg("JOINING & FLIPPING...");

        try {
            const clientSeedB = generate32ByteSeed();
            const data = Buffer.alloc(1 + 32);
            data.writeUInt8(1, 0); // JoinGame
            Buffer.from(clientSeedB).copy(data, 1);

            const tx = new web3.Transaction().add(
                new web3.TransactionInstruction({
                    keys: [
                        { pubkey: game.pubkey, isSigner: false, isWritable: true },
                        { pubkey: publicKey, isSigner: true, isWritable: true },
                        { pubkey: game.player_one, isSigner: false, isWritable: true },
                        { pubkey: COMMISSION_ADDRESS, isSigner: false, isWritable: true },
                        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                    ],
                    programId: PROGRAM_ID,
                    data,
                })
            );

            const sig = await sendTransaction(tx, connection);
            setSystemMsg("FLIP COMPLETE! CONFIRMING...");
            await connection.confirmTransaction(sig, 'confirmed');
            setSystemMsg("GAME SETTLED!");
            fetchGames();
        } catch (e) { setSystemMsg("ERROR: " + e.message); } 
        finally { setLoading(false); }
    };

    const cancelGame = async (gamePda) => {
        if (!publicKey) return;
        setLoading(true);
        try {
            const tx = new web3.Transaction().add(
                new web3.TransactionInstruction({
                    keys: [
                        { pubkey: gamePda, isSigner: false, isWritable: true },
                        { pubkey: publicKey, isSigner: true, isWritable: true },
                    ],
                    programId: PROGRAM_ID,
                    data: Buffer.from([3]), // CancelGame
                })
            );
            const sig = await sendTransaction(tx, connection);
            await connection.confirmTransaction(sig, 'confirmed');
            setSystemMsg("REFUND SUCCESSFUL");
            fetchGames();
        } catch (e) { setSystemMsg("CANCEL ERROR: " + e.message); }
        finally { setLoading(false); }
    }

    return (
        <div style={{ backgroundColor: '#000', color: '#0f0', padding: '50px', fontFamily: 'monospace', minHeight: '100vh' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <h1>SOL_FLIP_PROVABLY_FAIR</h1>
                <WalletMultiButton />
            </div>

            <div style={{ margin: '20px 0', border: '1px solid #0f0', padding: '15px', backgroundColor: '#051105' }}>
                <strong>STATUS:</strong> {systemMsg}
            </div>

            <div style={{ marginBottom: '30px', display: 'flex', gap: '20px', alignItems: 'center' }}>
                <div>
                    <label>WAGER: </label>
                    <input type="number" value={wager} onChange={e => setWager(e.target.value)} 
                           style={{ background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '10px', width: '80px' }} />
                </div>

                {/* SIDE SELECTION */}
                <div style={{ border: '1px solid #0f0', padding: '5px' }}>
                    <button onClick={() => setSelectedSide(0)} 
                            style={{ padding: '5px 15px', cursor: 'pointer', background: selectedSide === 0 ? '#0f0' : '#000', color: selectedSide === 0 ? '#000' : '#0f0', border: 'none' }}>
                        HEADS
                    </button>
                    <button onClick={() => setSelectedSide(1)} 
                            style={{ padding: '5px 15px', cursor: 'pointer', background: selectedSide === 1 ? '#0f0' : '#000', color: selectedSide === 1 ? '#000' : '#0f0', border: 'none' }}>
                        TAILS
                    </button>
                </div>

                <button onClick={createGame} disabled={loading || !publicKey} 
                        style={{ padding: '10px 20px', backgroundColor: '#0f0', color: '#000', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>
                    {loading ? "..." : "CREATE LOBBY"}
                </button>
            </div>
            
            <hr style={{ borderColor: '#333' }} />
            
            <h3>ACTIVE LOBBIES</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
                {openGames.map(g => (
                    <div key={g.pubkey.toBase58()} style={{ padding: '15px', border: '1px solid #333', borderRadius: '5px' }}>
                        <div>
                            <strong>Wager:</strong> {Number(g.amount)/1e9} SOL<br/>
                            <strong>Creator:</strong> {g.player_one.toBase58().slice(0,4)}...<br/>
                            <strong>Picking:</strong> {g.player_one_side === 0 ? "HEADS" : "TAILS"}
                        </div>
                        <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                            {publicKey && g.player_one.equals(publicKey) ? (
                                <button onClick={() => cancelGame(g.pubkey)} style={{ flex: 1, color: 'red', cursor: 'pointer', background: 'none', border: '1px solid red' }}>CANCEL</button>
                            ) : (
                                <button onClick={() => joinGame(g)} disabled={loading} style={{ flex: 1, padding: '8px', cursor: 'pointer', backgroundColor: '#0f0', border: 'none' }}>JOIN & FLIP</button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ... (App export remains same)

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