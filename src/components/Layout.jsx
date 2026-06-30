import React from 'react';
import { useNavigate } from 'react-router-dom';
import './Layout.css';

export default function Layout({ children, rightContent }) {
  const navigate = useNavigate();

  return (
    <div className="shell-layout">
      <aside className="sidebar-shell">
        <div className="brand-block">
          <div className="brand-title">SOL_FLIP_v2</div>
          <div className="brand-subtitle">SOL_FLIP_TERMINAL</div>
          <div className="brand-meta">V2.0.4-STABLE</div>
        </div>

        <nav className="side-nav">
          <button className="side-nav-item" onClick={() => navigate('/')}>Flip</button>
          <button className="side-nav-item" onClick={() => navigate('/game')}>Join Active Game</button>
         
          <button className="side-nav-item" onClick={() => navigate('/leaderboard')}>Leaderboard</button>
        </nav>

        <button className="verify-cta" onClick={() => navigate('/verify')}>VERIFY GAME</button>
      </aside>

      <main className="main-shell">
        <header className="topbar-shell">
          <div className="topbar-left">
            <div className="shell-badge">NETWORK_STATUS</div>
            <div className="shell-dot-group">
              <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
          </div>

          <div className="topbar-right">
            {rightContent}
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}
