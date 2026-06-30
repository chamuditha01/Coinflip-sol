import React from 'react';
import { BrowserRouter,Route,Routes } from 'react-router-dom';
import App from './GamePage';
import VerifyGame from './VerifyGame';
import Leaderboard from './Leaderboard';

const app = () => {

  return (
    <div>
        <BrowserRouter>
            <Routes>
                <Route path='/' element={<App />} />
          <Route path='/game' element={<App />} />
                <Route path='/verify' element={<VerifyGame />} />
            <Route path='/verify-game' element={<VerifyGame />} />
            <Route path='/leaderboard' element={<Leaderboard />} />
            <Route path='/leaderpage' element={<Leaderboard />} />
            </Routes>
        </BrowserRouter>
    </div>
  );
}   
export default app;