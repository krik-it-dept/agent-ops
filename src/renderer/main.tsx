import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';
import { openingHash } from './routes';
import { loadPreference } from './preferences';
import { allowFixtureMode } from './client';

const normalized = openingHash(
  window.location.hash,
  loadPreference('wb-ui', {}),
);
if (normalized !== window.location.hash)
  history.replaceState(null, '', normalized);
try {
  const prefs: unknown = JSON.parse(localStorage.getItem('wb-prefs') || '{}');
  if (
    prefs &&
    typeof prefs === 'object' &&
    'theme' in prefs &&
    ['system', 'light', 'dark'].includes(String(prefs.theme))
  )
    document.documentElement.dataset.theme = String(prefs.theme);
} catch {
  /* Theme falls back to system when optional browser preferences are unavailable. */
}

function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
// Only main can authorize sample mode; a query string alone cannot switch a release to fake data.
void window.agentOps.app
  .getInfo({})
  .then(
    (result) => {
      allowFixtureMode(result.ok && result.value.sampleModeAllowed === true);
    },
    () => {},
  )
  .finally(mount);
