// Planned state container extraction from public/app.js.
export function createInitialState() {
  return {
    authors: [],
    tickets: [],
    callbacks: [],
    existingMap: {},
    loadedTrackers: [],
    currentView: 'admin',
    dataScope: 'none',
    adminUnlocked: false,
  };
}
