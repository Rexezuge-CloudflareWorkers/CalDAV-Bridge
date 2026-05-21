import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SpaApp from './SpaApp';
import './style.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <SpaApp />
  </StrictMode>,
);
