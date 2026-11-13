import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ShellBar } from '../shell/ShellBar';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ShellBar wing="witness" /><App /></StrictMode>);
