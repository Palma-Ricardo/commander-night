import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

// No <StrictMode>: its dev double-mount would open two sockets and double-record
// the trace. From C1 the socket FSM owns the connection outside React and the
// wrapper comes back.
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<App />);
