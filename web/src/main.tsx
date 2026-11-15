import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ShellBar } from '../shell/ShellBar';
import './styles.css';
import { installCspSafeStyles } from '../shell/cspStyles.ts';
import { DEMO } from '../shell/demo.ts';

if (DEMO) installCspSafeStyles();

createRoot(document.getElementById('root')!).render(<StrictMode><ShellBar wing="witness" /><App /></StrictMode>);
