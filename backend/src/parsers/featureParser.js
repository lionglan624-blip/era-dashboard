import fs from 'fs';
import path from 'path';

/**
 * Parse individual feature-{ID}.md files into structured JSON.
 * Section-based: split on ## headers, then parse tables within each section.
 */
export class FeatureParser {
  parse(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseContent(content, filePath);
  }

  parseContent(content, filePath = '') {
    const id = this.extractId(filePath || '');
    const sections = this.splitSections(content);
    const firstLine = content.split('\n')[0] || '';

    return {
      id,
      title: this.extractTitle(firstLine),
      status: this.extractStatus(content),
      type: this.extractField(content, 'Type'),
      created: this.extractField(content, 'Created'),
      summary: this.getSectionText(sections, 'Summary'),
      background: this.parseBackground(sections),
      acceptanceCriteria: this.parseACTable(sections),
      tasks: this.parseTaskTable(sections),
      dependencies: this.parseDependencyTable(sections),
      executionLog: this.parseExecutionLog(sections),
      reviewNotes: this.getSectionText(sections, 'Review Notes'),
    };
  }

  extractId(filePath) {
    const match = path.basename(filePath).match(/feature-(\d+)/);
    return match ? match[1] : '';
  }

  extractTitle(firstLine) {
    const match = firstLine.match(/^#\s+Feature\s+\d+:\s*(.*)/);
    return match ? match[1].trim() : firstLine.replace(/^#+\s*/, '').trim();
  }

  extractStatus(content) {
    const match = content.match(/## Status:\s*\[(\w+)\]/);
    return match ? `[${match[1]}]` : '[UNKNOWN]';
  }

  extractField(content, field) {
    const regex = new RegExp(`^##?\\s*${field}:\\s*(.+)`, 'm');
    const match = content.match(regex);
    return match ? match[1].trim() : '';
  }

  splitSections(content) {
    const sections = {};
    let currentKey = '_header';
    sections[currentKey] = [];

    for (const line of content.split('\n')) {
      if (line.startsWith('## ')) {
        currentKey = line
          .replace(/^##\s*/, '')
          .replace(/:\s*.*/, '')
          .trim();
        sections[currentKey] = [];
      } else {
        if (!sections[currentKey]) sections[currentKey] = [];
        sections[currentKey].push(line);
      }
    }
    return sections;
  }

  getSectionText(sections, key) {
    const lines = this.findSection(sections, key);
    return lines ? lines.filter((l) => l.trim()).join('\n') : '';
  }

  findSection(sections, key) {
    // Exact match first
    if (sections[key]) return sections[key];
    // Case-insensitive search
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(sections)) {
      if (k.toLowerCase().includes(lowerKey)) return v;
    }
    return null;
  }

  parseBackground(sections) {
    const lines = this.findSection(sections, 'Background');
    if (!lines) return {};

    const result = {};
    let currentField = null;

    for (const line of lines) {
      const fieldMatch = line.match(/^\*\*(\w+)\*\*[:\s]*(.*)/);
      if (fieldMatch) {
        currentField = fieldMatch[1].toLowerCase();
        result[currentField] = fieldMatch[2].trim();
      } else if (currentField && line.trim()) {
        result[currentField] += ' ' + line.trim();
      }
    }
    return result;
  }

  parseACTable(sections) {
    const lines = this.findSection(sections, 'Acceptance Criteria');
    if (!lines) return [];

    // Find the AC Definition Table (header contains "AC#")
    // There may be other tables before it (e.g., Philosophy Derivation)
    const acHeaderIdx = lines.findIndex((l) => l.trim().startsWith('|') && l.includes('AC#'));
    if (acHeaderIdx === -1) return [];

    const acLines = lines.slice(acHeaderIdx);
    return this.parseTable(acLines, (cols) => {
      const acNum = parseInt(cols[0]);
      if (isNaN(acNum)) return null;

      // Status is the last column, check for [x] or [ ]
      const statusCol = cols[cols.length - 1];
      const completed = /\[x\]/i.test(statusCol);

      return {
        ac: acNum,
        description: cols[1] || '',
        type: cols[2] || '',
        matcher: cols.length > 4 ? cols[3] : '',
        expected: cols.length > 5 ? cols[4] : '',
        completed,
      };
    });
  }

  parseTaskTable(sections) {
    const lines = this.findSection(sections, 'Tasks');
    if (!lines) return [];

    // Find the table with Task# header
    const taskHeaderIdx = lines.findIndex((l) => l.trim().startsWith('|') && l.includes('Task#'));
    if (taskHeaderIdx === -1) {
      // Fallback: try any table
      return this.parseTable(lines, this._taskRowMapper.bind(this));
    }
    return this.parseTable(lines.slice(taskHeaderIdx), this._taskRowMapper.bind(this));
  }

  _taskRowMapper(cols) {
    const taskNum = parseInt(cols[0]);
    if (isNaN(taskNum)) return null;

    const statusCol = cols[cols.length - 1];
    const completed = /\[x\]/i.test(statusCol);

    return {
      task: taskNum,
      ac: cols[1] || '',
      description: cols[2] || '',
      completed,
    };
  }

  parseDependencyTable(sections) {
    const lines = this.findSection(sections, 'Dependencies');
    if (!lines) return [];
    return this.parseTable(lines, (cols) => {
      if (!cols[0] || cols[0].match(/^\d+$/)) return null;
      return {
        type: cols[0],
        id: cols[1] || '',
        description: cols[2] || '',
        status: cols[3] || '',
      };
    });
  }

  parseExecutionLog(sections) {
    const lines = this.findSection(sections, 'Execution Log');
    if (!lines) return [];
    return this.parseTable(lines, (cols) => ({
      timestamp: cols[0] || '',
      event: cols[1] || '',
      agent: cols[2] || '',
      action: cols[3] || '',
      result: cols[4] || '',
    }));
  }

  parseTable(lines, rowMapper) {
    const results = [];
    let inTable = false;
    let headerPassed = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) {
        if (inTable && headerPassed) break; // End of table (only after data rows started)
        continue;
      }

      // Separator row (e.g., |:---:|-----|)
      if (trimmed.match(/^\|[\s:|-]+\|$/) || trimmed.match(/^\|[\s:-]+\|/)) {
        if (inTable) headerPassed = true;
        continue;
      }

      // Header row (first | row we encounter)
      if (!inTable) {
        inTable = true;
        continue;
      }

      if (!headerPassed) continue;

      const cols = trimmed
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const parsed = rowMapper(cols);
      if (parsed) results.push(parsed);
    }

    return results;
  }
}
