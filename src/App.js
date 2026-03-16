import React from 'react';
import { BrowserRouter,Route,Routes } from 'react-router-dom';
import App from './GamePage';
import VerifyGame from './VerifyGame';

const app = () => {

  return (
    <div>
        <BrowserRouter>
            <Routes>
                <Route path='/' element={<App />} />
                <Route path='/verify' element={<VerifyGame />} />
            </Routes>
        </BrowserRouter>
    </div>
  );
}   
export default app;