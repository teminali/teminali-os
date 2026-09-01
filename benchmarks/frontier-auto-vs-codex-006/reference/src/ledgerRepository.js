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
    const contents = fs.readFileSync(this.filePath, 'utf8');
    const lines = contents.split('\n');
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        const isIncompleteTail = index === lines.length - 1 && !contents.endsWith('\n');
        if (!isIncompleteTail) throw error;
      }
    }
    return events;
  }

  append(event) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  }
}

module.exports = { LedgerRepository };
