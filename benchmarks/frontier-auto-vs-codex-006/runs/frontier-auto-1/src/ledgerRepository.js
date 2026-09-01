'use strict';

const fs = require('node:fs');
const path = require('node:path');

class LedgerRepository {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
  }

  readAll() {
    return fs.readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  append(event) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

module.exports = { LedgerRepository };
