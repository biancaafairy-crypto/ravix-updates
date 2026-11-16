const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../public/watch.html');
const dst = path.resolve(__dirname, '../watch.html');

if (fs.existsSync(src)) {
  fs.copyFileSync(src, dst);
  console.log('[RAVIX Build] ✓ watch.html sincronizado para a raiz do repositório (GitHub Pages).');
} else {
  console.warn('[RAVIX Build] ⚠ public/watch.html não encontrado.');
}
