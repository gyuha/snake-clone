import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerPwa } from './pwa';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(<App />);
registerPwa();
