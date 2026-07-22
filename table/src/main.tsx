import { createRoot } from 'react-dom/client';
import { App } from './chrome/App';
import { bootApp } from './app';
import './styles.css';

// No StrictMode: it double-invokes effects in dev, which would spin up two Pixi
// Applications (each with its own canvas + GL context) — wrong for an imperative
// canvas host. React only mounts the chrome here.
bootApp();
createRoot(document.getElementById('root')!).render(<App />);
