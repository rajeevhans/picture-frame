// Minimal preload (keeps window isolated from Node.js).
// You can expose safe APIs here later if needed.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('pictureFrame', {
  version: '1.0',
});


