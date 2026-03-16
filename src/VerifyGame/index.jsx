import React, { useState } from 'react';
import CryptoJS from 'crypto-js';
import './App.css';

const VerifyGame = () => {
    const [activeTab, setActiveTab] = useState('js');
    
    // UI State
    const [serverHash, setServerHash] = useState('');
    const [serverSeed, setServerSeed] = useState('');
    const [clientSeedA, setClientSeedA] = useState('');
    const [clientSeedB, setClientSeedB] = useState('');
    const [verificationResult, setVerificationResult] = useState(null);
    const [copySuccess, setCopySuccess] = useState('');

const handleCopy = async () => {
    try {
        await navigator.clipboard.writeText(codeFiles[activeTab]);
        setCopySuccess('COPIED!');
        setTimeout(() => setCopySuccess(''), 2000);
    } catch (err) {
        setCopySuccess('FAILED');
    }
};

   function handleVerify() {
    // 1. Grab values from the 4 inputs
    const sHash = document.getElementById('sHash').value.trim();
    const sSeed = document.getElementById('sSeed').value.trim();
    const cA = document.getElementById('cA').value.trim();
    const cB = document.getElementById('cB').value.trim();
    const resultArea = document.getElementById('resultArea');

    if (!sHash || !sSeed || !cA || !cB) {
        alert("All 4 fields are required for verification.");
        return;
    }

    try {
        // 2. Verify Commitment (Does the seed match the hash?)
        const calculatedHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(sSeed)).toString();
        const isHashValid = calculatedHash.toLowerCase() === sHash.toLowerCase();

        // 3. Verify Outcome (Match Rust logic)
        const combinedHex = sSeed + cA + cB;
        const finalHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(combinedHex)).toString();
        
        // Take first byte (first 2 hex chars) and modulo 2
        const firstByte = parseInt(finalHash.substring(0, 2), 16);
        const outcome = (firstByte % 2 === 0) ? "HEADS" : "TAILS";

        // 4. Update UI
        resultArea.innerHTML = `
            <div class="result-box" style="border-left: 4px solid ${isHashValid ? '#14F195' : '#ff4b4b'}">
                <div style="margin-bottom: 8px;">
                    STATUS: <b>${isHashValid ? '✓ VERIFIED' : '✗ HASH MISMATCH'}</b>
                </div>
                <div>
                    OUTCOME: <span style="color: #14F195; font-weight: bold;">${outcome}</span>
                </div>
            </div>
        `;
    } catch (e) {
        alert("Verification Error: Check if your hex strings are valid.");
    }
}

    const codeFiles = {
        "index.html": `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Provably Fair Verifier</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <link rel="stylesheet" href="style.css">
</head>
<body>

    <div class="glass-card">
        <div class="card-header">
            <div class="status-dot"></div>
            <span>PROVABLY_FAIR_REVEAL_v2</span>
        </div>

        <div class="v-input-box">
            <label>COMMIT_HASH</label>
            <input type="text" id="sHash" placeholder="0x...">
        </div>

        <div class="v-input-box">
            <label>REVEAL_SEED</label>
            <input type="text" id="sSeed" placeholder="hex_value">
        </div>

        <div class="v-grid-2">
            <div class="v-input-box">
                <label>CLIENT_A</label>
                <input type="text" id="cA">
            </div>
            <div class="v-input-box">
                <label>CLIENT_B</label>
                <input type="text" id="cB">
            </div>
        </div>

        <button class="v-execute-btn" id="mainButton">EXECUTE_VALIDATION</button>

        <div id="resultArea"></div>
    </div>

    <script src="verify.js"></script>
</body>
</html>`,
        "verify.js": `document.getElementById('mainButton').addEventListener('click', function() {
    const sHash = document.getElementById('sHash').value.trim();
    const sSeed = document.getElementById('sSeed').value.trim();
    const cA = document.getElementById('cA').value.trim();
    const cB = document.getElementById('cB').value.trim();
    const resultArea = document.getElementById('resultArea');

    if (!sHash || !sSeed || !cA || !cB) {
        alert("Please fill all fields.");
        return;
    }

    try {
        // 1. Commitment Check
        const calculatedHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(sSeed)).toString();
        const isHashValid = calculatedHash.toLowerCase() === sHash.toLowerCase();

        // 2. Outcome Check
        const combinedHex = sSeed + cA + cB;
        const finalHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(combinedHex)).toString();
        
        const firstByteDecimal = parseInt(finalHash.substring(0, 2), 16);
        const outcome = (firstByteDecimal % 2 === 0) ? "HEADS" : "TAILS";

        // 3. Render
        resultArea.innerHTML = \`
            <div class="result-box" style="border-left: 4px solid \${isHashValid ? '#14F195' : '#ff4b4b'}">
                <div style="margin-bottom: 5px;">
                    TRUST: <b>\${isHashValid ? 'VERIFIED' : 'FAILED'}</b>
                </div>
                <div>
                    RESULT: <span style="color: #14F195; font-weight: bold;">\${outcome}</span>
                </div>
            </div>
        \`;
    } catch (e) {
        alert("Error: Check your hex strings.");
    }
});`,
        "style.css": `:root {
    --neon: #14F195;
    --bg: #0c0f14;
    --card: #141a21;
    --border: #242d38;
    --text: #8a939f;
}

body {
    background: var(--bg);
    margin: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    font-family: sans-serif;
}

.glass-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 30px;
    width: 450px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
}

.card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--text);
    margin-bottom: 25px;
    text-transform: uppercase;
}

.status-dot {
    width: 8px;
    height: 8px;
    background: var(--neon);
    border-radius: 50%;
    box-shadow: 0 0 10px var(--neon);
}

.v-input-box {
    margin-bottom: 20px;
    text-align: left;
}

.v-input-box label {
    display: block;
    font-size: 10px;
    color: var(--text);
    margin-bottom: 8px;
}

.v-input-box input {
    width: 100%;
    background: #090c11;
    border: 1px solid #1c232d;
    border-radius: 8px;
    padding: 12px;
    color: #fff;
    box-sizing: border-box;
    outline: none;
}

.v-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 15px;
}

.v-execute-btn {
    width: 100%;
    background: var(--neon);
    color: #000;
    border: none;
    border-radius: 8px;
    padding: 15px;
    font-weight: 800;
    cursor: pointer;
}

.result-box {
    margin-top: 20px;
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(0,0,0,0.2);
    color: #fff;
    text-align: left;
}`
    };

    return (
        <div className="v-split-container">
            {/* LEFT: CODE PANEL */}
            <div className="v-editor">
                <div className="v-tabs" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: '15px' }}>
    <div>
        {['html', 'js', 'css'].map(tab => (
            <button 
                key={tab}
                className={activeTab === (tab === 'html' ? 'index.html' : tab === 'js' ? 'verify.js' : 'style.css') ? 'active' : ''} 
                onClick={() => {
                    if (tab === 'html') setActiveTab('index.html');
                    else if (tab === 'js') setActiveTab('verify.js');
                    else setActiveTab('style.css');
                }}
            >
                {tab.toUpperCase()}
            </button>
        ))}
    </div>
    <button 
        onClick={handleCopy} 
        style={{
            background: 'transparent',
            border: '1px solid #14F195',
            color: '#14F195',
            padding: '5px 12px',
            fontSize: '10px',
            cursor: 'pointer',
            borderRadius: '4px',
            fontWeight: 'bold'
        }}
    >
        {copySuccess ? copySuccess : 'COPY CODE'}
    </button>
</div>
                <div className="v-code">
                    <pre><code>{codeFiles[activeTab] || codeFiles['verify.js']}</code></pre>
                </div>
            </div>

            {/* RIGHT: LIVE UI */}
            <div className="v-preview">
                <div className="glass-card">
                    <div className="card-header">
                        <div className="status-dot"></div>
                        <span>PROVABLY_FAIR_REVEAL_v2</span>
                    </div>

                    <div className="v-input-box">
                        <label>COMMIT_HASH</label>
                        <input 
                            type="text" 
                            id="sHash"
                            value={serverHash} 
                            onChange={e => setServerHash(e.target.value)} 
                            placeholder="0x..." 
                        />
                    </div>

                    <div className="v-input-box">
                        <label>REVEAL_SEED</label>
                        <input 
                            type="text" 
                            id="sSeed"
                            value={serverSeed} 
                            onChange={e => setServerSeed(e.target.value)} 
                            placeholder="hex_value" 
                        />
                    </div>

                    <div className="v-grid-2">
                        <div className="v-input-box">
                            <label>CLIENT_A</label>
                            <input type="text" id="cA" value={clientSeedA} onChange={e => setClientSeedA(e.target.value)} />
                        </div>
                        <div className="v-input-box">
                            <label>CLIENT_B</label>
                            <input type="text" id="cB" value={clientSeedB} onChange={e => setClientSeedB(e.target.value)} />
                        </div>
                    </div>

                    <button className="v-execute-btn" onClick={handleVerify}>
                        EXECUTE_VALIDATION
                    </button>

                    <div id="resultArea"></div>
                </div>
            </div>
        </div>
    );
};

export default VerifyGame;