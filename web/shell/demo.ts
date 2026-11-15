// Static "Try it" demo (VITE_DEMO=1): both wings run in the browser with no server. Without the flag nothing changes.
export const DEMO = import.meta.env.VITE_DEMO === '1';
export const DEMO_NOTE = 'needs the full app (run it locally)';
