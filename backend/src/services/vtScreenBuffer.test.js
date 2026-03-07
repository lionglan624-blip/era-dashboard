import { describe, it, expect } from 'vitest';
import { VtScreenBuffer } from './vtScreenBuffer.js';

describe('VtScreenBuffer', () => {
  it('renders plain text at cursor position', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hello');
    expect(screen.getText()).toContain('Hello');
  });

  it('handles cursor positioning (CSI H)', () => {
    const screen = new VtScreenBuffer(40, 5);
    screen.feed('\x1b[1;10HWorld');
    const text = screen.getText();
    expect(text).toMatch(/\s{9}World/);
  });

  it('handles cursor forward (CSI C) as spacing', () => {
    const screen = new VtScreenBuffer(40, 5);
    screen.feed('Hello\x1b[3CWorld');
    const text = screen.getText();
    expect(text).toContain('Hello   World');
  });

  it('normal mode erases text on CSI J', () => {
    const screen = new VtScreenBuffer(40, 5);
    screen.feed('Some text');
    screen.feed('\x1b[2J');
    const text = screen.getText();
    expect(text).toBe('');
  });

  it('handles cursor up (CSI A)', () => {
    const screen = new VtScreenBuffer(40, 10);
    screen.feed('Line1\nLine2');
    screen.feed('\x1b[1A');
    expect(screen.cy).toBe(0);
  });

  it('handles cursor down (CSI B)', () => {
    const screen = new VtScreenBuffer(40, 10);
    screen.cy = 2;
    screen.feed('\x1b[2B');
    expect(screen.cy).toBe(4);
  });

  it('handles cursor back (CSI D)', () => {
    const screen = new VtScreenBuffer(40, 10);
    screen.cx = 5;
    screen.feed('\x1b[3D');
    expect(screen.cx).toBe(2);
  });

  it('handles cursor to column (CSI G)', () => {
    const screen = new VtScreenBuffer(40, 10);
    screen.feed('\x1b[10G');
    expect(screen.cx).toBe(9);
  });

  it('handles erase to end of line (CSI K with no param)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hello World');
    screen.feed('\x1b[5G');
    screen.feed('\x1b[K');
    const text = screen.getText();
    expect(text).toMatch(/^Hell\s*$/);
  });

  it('handles erase from start of line (CSI 1K)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hello World');
    screen.cx = 5;
    screen.feed('\x1b[1K');
    const row = screen.buffer[0];
    expect(row[0]).toBe(' ');
    expect(row[1]).toBe(' ');
    expect(row[2]).toBe(' ');
    expect(row[3]).toBe(' ');
    expect(row[4]).toBe(' ');
  });

  it('handles erase entire line (CSI 2K)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hello World');
    screen.feed('\x1b[2K');
    expect(screen.buffer[0].every((c) => c === ' ')).toBe(true);
  });

  it('handles erase from cursor to end of screen (CSI 0J)', () => {
    const screen = new VtScreenBuffer(10, 3);
    screen.feed('ABC\r\nDEF\r\nGHI');
    screen.cy = 1;
    screen.cx = 1;
    screen.feed('\x1b[J');
    expect(screen.buffer[1][0]).toBe('D');
    expect(screen.buffer[1][1]).toBe(' ');
    expect(screen.buffer[2].every((c) => c === ' ')).toBe(true);
  });

  it('handles BEL (ignored) and BS (backspace)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hi\x07');
    expect(screen.cx).toBe(2);
    screen.feed('\x08');
    expect(screen.cx).toBe(1);
  });

  it('handles tab character advancing to next tab stop', () => {
    const screen = new VtScreenBuffer(40, 5);
    screen.feed('Hi\t!');
    const text = screen.getText();
    expect(text).toContain('Hi');
    expect(text).toContain('!');
    expect(screen.cx).toBe(9);
  });

  it('handles OSC escape (title sequences)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('\x1b]0;some title\x07Hello');
    const text = screen.getText();
    expect(text).toContain('Hello');
  });

  it('handles single-char escape sequences (\\x1b7 style)', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hi\x1b7');
    expect(screen.getText()).toContain('Hi');
  });

  it('clamps cursor position at boundaries', () => {
    const screen = new VtScreenBuffer(10, 5);
    screen.feed('\x1b[99A');
    expect(screen.cy).toBe(0);
    screen.cy = 4;
    screen.feed('\x1b[99B');
    expect(screen.cy).toBe(4);
  });

  it('getText filters out empty lines', () => {
    const screen = new VtScreenBuffer(20, 5);
    screen.feed('Hello');
    const text = screen.getText();
    expect(text).toBe('Hello');
  });
});
