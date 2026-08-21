const fs = require('fs');

const files = ['app.js', 'functions/index.js'];
files.forEach(f => {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const match = l.match(/collection\(['"]([a-zA-Z0-9_]+)['"]\)/);
    if (match) {
      console.log(`${f}:${i+1} -> collection('${match[1]}') | ${l.trim()}`);
    }
  });
});
