/**
 * Minimal VT terminal emulator - reconstructs screen buffer from VT escape sequences.
 * Equivalent to ReadConsoleOutputCharacterW: produces a character grid with proper spacing.
 *
 * @param {number} cols - Terminal width
 * @param {number} rows - Terminal height
 */
export class VtScreenBuffer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.buffer = [];
    this.cx = 0;
    this.cy = 0;
    for (let i = 0; i < rows; i++) {
      this.buffer.push(new Array(cols).fill(' '));
    }
  }

  /**
   * Feed VT data into the buffer, processing escape sequences and characters.
   * @param {string} data - Raw VT output from node-pty
   */
  feed(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        i = this._parseEscape(data, i + 1);
      } else if (ch === '\r') {
        this.cx = 0;
        i++;
      } else if (ch === '\n') {
        this.cy = Math.min(this.cy + 1, this.rows - 1);
        i++;
      } else if (ch === '\t') {
        this.cx = Math.min(this.cx + (8 - (this.cx % 8)), this.cols - 1);
        i++;
      } else if (ch === '\x07' || ch === '\x08') {
        // BEL: ignore, BS: move back
        if (ch === '\x08') this.cx = Math.max(0, this.cx - 1);
        i++;
      } else if (ch.charCodeAt(0) < 32) {
        i++; // skip other control chars
      } else {
        // Printable character
        if (this.cx < this.cols && this.cy < this.rows) {
          this.buffer[this.cy][this.cx] = ch;
          this.cx++;
        }
        i++;
      }
    }
  }

  _parseEscape(data, i) {
    if (i >= data.length) return i;
    if (data[i] === '[') {
      return this._parseCSI(data, i + 1);
    } else if (data[i] === ']') {
      return this._skipOSC(data, i + 1);
    }
    return i + 1; // skip single-char escape (e.g., \x1b7, \x1bM)
  }

  _parseCSI(data, i) {
    let params = '';
    while (i < data.length && data[i] >= '\x20' && data[i] <= '\x3f') {
      params += data[i];
      i++;
    }
    if (i < data.length) {
      this._handleCSI(params, data[i]);
      i++;
    }
    return i;
  }

  _skipOSC(data, i) {
    // Skip until BEL (\x07) or ST (\x1b\\)
    while (i < data.length) {
      if (data[i] === '\x07') return i + 1;
      if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') return i + 2;
      i++;
    }
    return i;
  }

  _handleCSI(params, cmd) {
    // Parse semicolon-separated numeric params (e.g., "10;20" → [10, 20])
    const parts = params
      .replace(/\?/g, '')
      .split(';')
      .map((s) => parseInt(s) || 0);
    switch (cmd) {
      case 'A': // cursor up
        this.cy = Math.max(0, this.cy - (parts[0] || 1));
        break;
      case 'B': // cursor down
        this.cy = Math.min(this.rows - 1, this.cy + (parts[0] || 1));
        break;
      case 'C': // cursor forward
        this.cx = Math.min(this.cols - 1, this.cx + (parts[0] || 1));
        break;
      case 'D': // cursor back
        this.cx = Math.max(0, this.cx - (parts[0] || 1));
        break;
      case 'H':
      case 'f': // cursor position (row;col, 1-based)
        this.cy = Math.max(0, Math.min(this.rows - 1, (parts[0] || 1) - 1));
        this.cx = Math.max(0, Math.min(this.cols - 1, (parts[1] || 1) - 1));
        break;
      case 'G': // cursor to column (1-based)
        this.cx = Math.max(0, Math.min(this.cols - 1, (parts[0] || 1) - 1));
        break;
      case 'J': // erase display
        if (parts[0] === 2 || parts[0] === 3) {
          for (let r = 0; r < this.rows; r++) this.buffer[r].fill(' ');
        } else if (parts[0] === 0 || params === '') {
          // Erase from cursor to end
          for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' ';
          for (let r = this.cy + 1; r < this.rows; r++) this.buffer[r].fill(' ');
        }
        break;
      case 'K': // erase line
        if ((parts[0] || 0) === 0) {
          for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' ';
        } else if (parts[0] === 1) {
          for (let c = 0; c <= this.cx; c++) this.buffer[this.cy][c] = ' ';
        } else if (parts[0] === 2) {
          this.buffer[this.cy].fill(' ');
        }
        break;
      // m (SGR/style), h/l (mode set/reset), etc. — ignore
    }
  }

  /**
   * Get the screen content as text lines (trimmed end whitespace).
   * @returns {string} Screen text with newlines
   */
  getText() {
    return this.buffer
      .map((row) => row.join('').trimEnd())
      .filter((line) => line.length > 0)
      .join('\n');
  }
}
