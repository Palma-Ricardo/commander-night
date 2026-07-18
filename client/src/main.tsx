import { createRoot } from 'react-dom/client';
import { bootApp } from './app';
import { App } from './ui/App';
import './styles.css';

// The socket lives outside React (app.ts owns it) — components only read stores.
bootApp();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<App />);
