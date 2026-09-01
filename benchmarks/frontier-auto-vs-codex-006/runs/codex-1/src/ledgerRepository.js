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
    if (contents === '') return [];

    const hasFinalNewline = contents.endsWith('\n');
    const lines = contents.split('\n');
    if (hasFinalNewline) lines.pop();

    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      try {
        if (line.trim() === '') throw new SyntaxError('empty JSONL record');
        events.push(JSON.parse(line));
      } catch (error) {
        const isIncompleteTail = !hasFinalNewline && index === lines.length - 1;
        if (isIncompleteTail) {
          const validPrefix = lines.slice(0, index).map((item) => `${item}\n`).join('');
          fs.truncateSync(this.filePath, Buffer.byteLength(validPrefix, 'utf8'));
          break;
        }
        const corruption = new SyntaxError(`invalid ledger record at line ${index + 1}`);
        corruption.cause = error;
        throw corruption;
      }
    }
    return events;
  }

  append(event) {
    // Validate the existing stream and discard an interrupted final write before
    // adding another record. A valid final record without a newline is retained.
    this.readAll();
    const contents = fs.readFileSync(this.filePath, 'utf8');
    const separator = contents !== '' && !contents.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(this.filePath, `${separator}${JSON.stringify(event)}\n`, 'utf8');
  }
}

module.exports = { LedgerRepository };
