import React, { useState } from 'react';
import CryptoJS from 'crypto-js';
import './App.css'; // Reuse your styling

const VerifyGame = () => {
    const [serverSeed, setServerSeed] = useState('');
    const [clientSeedA, setClientSeedA] = useState('');
    const [clientSeedB, setClientSeedB] = useState('');
    const [verificationResult, setVerificationResult] = useState(null);

    const handleVerify = () => {
        if (!serverSeed || !clientSeedA || !clientSeedB) {
            alert("Please fill in all fields.");
            return;
        }

        // 1. Combine the seeds (Order must match your smart contract)
        // Usually: hash(ServerSeed + ClientSeedA + ClientSeedB)
        const combinedString = serverSeed + clientSeedA + clientSeedB;
        
        // 2. Generate SHA-256 Hash
        const hash = CryptoJS.SHA256(combinedString).toString();
        
        // 3. Determine Result (Even = Heads (0), Odd = Tails (1))
        // We take the last character of the hash and check if its hex value is even/odd
        const lastChar = hash.charAt(hash.length - 1);
        const decimalValue = parseInt(lastChar, 16);
        const result = decimalValue % 2 === 0 ? 0 : 1;

        setVerificationResult({
            hash: hash,
            result: result === 0 ? "HEADS" : "TAILS"
        });
    };

    return (
        <div className="app-container" style={{ paddingTop: '50px' }}>
            <div className="glass-panel main-controls" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'left' }}>
                <h1 className="logo-text" style={{ fontSize: '1.5rem', marginBottom: '20px' }}>VERIFY_GAME_RESULT</h1>
                
                <div className="verify-input-group">
                    <label>SERVER REVEALED SEED (HEX)</label>
                    <input 
                        type="text" 
                        className="wager-input" 
                        style={{ width: '100%', textAlign: 'left', marginBottom: '20px' }}
                        value={serverSeed}
                        onChange={(e) => setServerSeed(e.target.value)}
                        placeholder="Paste the revealed server seed..."
                    />

                    <label>CLIENT SEED A (CREATOR)</label>
                    <input 
                        type="text" 
                        className="wager-input" 
                        style={{ width: '100%', textAlign: 'left', marginBottom: '20px' }}
                        value={clientSeedA}
                        onChange={(e) => setClientSeedA(e.target.value)}
                        placeholder="Paste creator seed..."
                    />

                    <label>CLIENT SEED B (JOINER)</label>
                    <input 
                        type="text" 
                        className="wager-input" 
                        style={{ width: '100%', textAlign: 'left', marginBottom: '20px' }}
                        value={clientSeedB}
                        onChange={(e) => setClientSeedB(e.target.value)}
                        placeholder="Paste joiner seed..."
                    />

                    <button className="btn-primary" style={{ width: '100%' }} onClick={handleVerify}>
                        RUN_VERIFICATION
                    </button>
                </div>

                {verificationResult && (
                    <div className="verifiable-box" style={{ marginTop: '30px', border: '1px solid var(--neon)' }}>
                        <p className="verify-title" style={{ fontSize: '14px' }}>VERIFICATION_SUCCESSFUL</p>
                        <div className="verify-row">
                            <span>FINAL_HASH:</span>
                            <code style={{ wordBreak: 'break-all' }}>{verificationResult.hash}</code>
                        </div>
                        <div className="verify-row" style={{ marginTop: '10px' }}>
                            <span>CALCULATED_RESULT:</span>
                            <span style={{ color: 'var(--neon)', fontWeight: 'bold' }}>{verificationResult.result}</span>
                        </div>
                        <p className="verify-note">
                            If this result matches your game outcome, the flip was mathematically fair.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VerifyGame;