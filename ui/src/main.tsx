import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import './styles.css';
import { App } from './App';
import { keepNames, startI18n } from './lib/i18n';
import { useApp } from './lib/store';

void startI18n();
// Bot names are the user's own words: never translate them (set before the list re-renders).
useApp.subscribe((s, prev) => s.agents !== prev.agents && keepNames(s.agents.map((a) => a.name)));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
