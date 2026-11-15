import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ShellBar } from '../../../../web/shell/ShellBar.tsx';
import './styles.css';
import { installCspSafeStyles } from '../../../../web/shell/cspStyles.ts';
import { DEMO } from '../../../../web/shell/demo.ts';

if (DEMO) installCspSafeStyles();
createRoot(document.getElementById('root')!).render(<><ShellBar wing="compiler" /><App /></>);
