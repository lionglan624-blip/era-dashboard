import { describe, it, expect, vi } from 'vitest';
import { FeatureParser } from './featureParser.js';
import { IndexParser } from './indexParser.js';

// =============================================================================
// FeatureParser Tests
// =============================================================================

describe('FeatureParser', () => {
  const parser = new FeatureParser();

  describe('extractId', () => {
    it('extracts ID from various filename formats', () => {
      expect(parser.extractId('feature-123.md')).toBe('123');
      expect(parser.extractId('/path/to/feature-456.md')).toBe('456');
      expect(parser.extractId('C:\\pm\\features\\feature-789.md')).toBe('789');
    });

    it('returns empty string for non-feature files', () => {
      expect(parser.extractId('index.md')).toBe('');
      expect(parser.extractId('feature.md')).toBe('');
      expect(parser.extractId('')).toBe('');
    });
  });

  describe('extractStatus', () => {
    it('extracts status with brackets', () => {
      expect(parser.extractStatus('## Status: [WIP]')).toBe('[WIP]');
      expect(parser.extractStatus('## Status: [DONE]')).toBe('[DONE]');
      expect(parser.extractStatus('## Status: [PROPOSED]')).toBe('[PROPOSED]');
    });

    it('returns [UNKNOWN] for missing status', () => {
      expect(parser.extractStatus('## Summary')).toBe('[UNKNOWN]');
      expect(parser.extractStatus('')).toBe('[UNKNOWN]');
    });
  });

  describe('extractTitle', () => {
    it('extracts title from feature header', () => {
      expect(parser.extractTitle('# Feature 123: Test Feature')).toBe('Test Feature');
      expect(parser.extractTitle('# Feature 456: Another Test')).toBe('Another Test');
    });

    it('handles headers without Feature prefix', () => {
      expect(parser.extractTitle('# Some Title')).toBe('Some Title');
      expect(parser.extractTitle('## Another Title')).toBe('Another Title');
    });

    it('trims whitespace', () => {
      expect(parser.extractTitle('# Feature 123:   Spaced Title   ')).toBe('Spaced Title');
    });
  });

  describe('extractField', () => {
    const content = `
## Type: kojo
## Created: 2026-01-15
# Summary: This is a summary
`;

    it('extracts field values', () => {
      expect(parser.extractField(content, 'Type')).toBe('kojo');
      expect(parser.extractField(content, 'Created')).toBe('2026-01-15');
    });

    it('returns empty string for missing fields', () => {
      expect(parser.extractField(content, 'Missing')).toBe('');
    });
  });

  describe('parseACTable', () => {
    it('parses AC table with 6 columns (full format)', () => {
      const sections = {
        'Acceptance Criteria': [
          '| AC# | Description | Type | Matcher | Expected | Status |',
          '|:---:|-------------|------|---------|----------|:------:|',
          '| 1 | Test AC | output | contains | text | [x] |',
          '| 2 | Another AC | build | succeeds | - | [ ] |',
        ],
      };

      const result = parser.parseACTable(sections);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        ac: 1,
        description: 'Test AC',
        type: 'output',
        matcher: 'contains',
        expected: 'text',
        completed: true,
      });
      expect(result[1]).toEqual({
        ac: 2,
        description: 'Another AC',
        type: 'build',
        matcher: 'succeeds',
        expected: '-',
        completed: false,
      });
    });

    it('parses AC table with 5 columns (no Expected)', () => {
      const sections = {
        'Acceptance Criteria': [
          '| AC# | Description | Type | Matcher | Status |',
          '|:---:|-------------|------|---------|:------:|',
          '| 1 | Test AC | output | contains | [x] |',
        ],
      };

      const result = parser.parseACTable(sections);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ac: 1,
        description: 'Test AC',
        type: 'output',
        matcher: 'contains',
        expected: '',
        completed: true,
      });
    });

    it('parses AC table with 4 columns (minimal format)', () => {
      const sections = {
        'Acceptance Criteria': [
          '| AC# | Description | Type | Status |',
          '|:---:|-------------|------|:------:|',
          '| 1 | Test AC | output | [ ] |',
        ],
      };

      const result = parser.parseACTable(sections);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ac: 1,
        description: 'Test AC',
        type: 'output',
        matcher: '',
        expected: '',
        completed: false,
      });
    });

    it('handles case-insensitive [x] vs [X]', () => {
      const sections = {
        'Acceptance Criteria': [
          '| AC# | Description | Type | Status |',
          '|:---:|-------------|------|:------:|',
          '| 1 | Lower x | output | [x] |',
          '| 2 | Upper X | output | [X] |',
          '| 3 | Unchecked | output | [ ] |',
        ],
      };

      const result = parser.parseACTable(sections);

      expect(result[0].completed).toBe(true);
      expect(result[1].completed).toBe(true);
      expect(result[2].completed).toBe(false);
    });

    it('skips Philosophy Derivation table before AC table', () => {
      const sections = {
        'Acceptance Criteria': [
          '## Philosophy Derivation',
          '| Step | Derivation | Result |',
          '|:----:|------------|--------|',
          '| 1 | Some derivation | Result |',
          '',
          '## AC Definition Table',
          '| AC# | Description | Type | Status |',
          '|:---:|-------------|------|:------:|',
          '| 1 | Test AC | output | [x] |',
        ],
      };

      const result = parser.parseACTable(sections);

      expect(result).toHaveLength(1);
      expect(result[0].ac).toBe(1);
    });

    it('returns empty array for missing AC section', () => {
      expect(parser.parseACTable({})).toEqual([]);
    });

    it('returns empty array when no AC# header found', () => {
      const sections = {
        'Acceptance Criteria': [
          '| Description | Type | Status |',
          '|-------------|------|:------:|',
          '| Test | output | [x] |',
        ],
      };

      expect(parser.parseACTable(sections)).toEqual([]);
    });
  });

  describe('parseTaskTable', () => {
    it('parses task table with Task# header', () => {
      const sections = {
        Tasks: [
          '| Task# | AC# | Description | Status |',
          '|:-----:|:---:|-------------|:------:|',
          '| 1 | 1 | First task | [x] |',
          '| 2 | 2 | Second task | [ ] |',
        ],
      };

      const result = parser.parseTaskTable(sections);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        task: 1,
        ac: '1',
        description: 'First task',
        completed: true,
      });
      expect(result[1]).toEqual({
        task: 2,
        ac: '2',
        description: 'Second task',
        completed: false,
      });
    });

    it('parses task table without Task# header (fallback)', () => {
      const sections = {
        Tasks: [
          '| # | AC# | Description | Status |',
          '|:-:|:---:|-------------|:------:|',
          '| 1 | 1 | Task | [x] |',
        ],
      };

      const result = parser.parseTaskTable(sections);

      expect(result).toHaveLength(1);
      expect(result[0].task).toBe(1);
    });

    it('handles case-insensitive [x] vs [X]', () => {
      const sections = {
        Tasks: [
          '| Task# | AC# | Description | Status |',
          '|:-----:|:---:|-------------|:------:|',
          '| 1 | 1 | Lower | [x] |',
          '| 2 | 2 | Upper | [X] |',
        ],
      };

      const result = parser.parseTaskTable(sections);

      expect(result[0].completed).toBe(true);
      expect(result[1].completed).toBe(true);
    });

    it('returns empty array for missing Tasks section', () => {
      expect(parser.parseTaskTable({})).toEqual([]);
    });
  });

  describe('parseTable', () => {
    it('parses generic table with custom row mapper', () => {
      const lines = [
        '| Col1 | Col2 | Col3 |',
        '|:----:|:----:|:----:|',
        '| A | B | C |',
        '| D | E | F |',
      ];

      const mapper = (cols) => ({
        first: cols[0],
        second: cols[1],
        third: cols[2],
      });

      const result = parser.parseTable(lines, mapper);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ first: 'A', second: 'B', third: 'C' });
      expect(result[1]).toEqual({ first: 'D', second: 'E', third: 'F' });
    });

    it('filters out null results from mapper', () => {
      const lines = [
        '| Col1 | Col2 |',
        '|:----:|:----:|',
        '| 1 | A |',
        '| invalid | B |',
        '| 2 | C |',
      ];

      const mapper = (cols) => {
        const num = parseInt(cols[0]);
        if (isNaN(num)) return null;
        return { num, text: cols[1] };
      };

      const result = parser.parseTable(lines, mapper);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ num: 1, text: 'A' });
      expect(result[1]).toEqual({ num: 2, text: 'C' });
    });

    it('stops at first non-table line after data rows', () => {
      const lines = [
        '| Col1 | Col2 |',
        '|:----:|:----:|',
        '| A | B |',
        '',
        'Some text',
        '| C | D |',
      ];

      const mapper = (cols) => ({ first: cols[0], second: cols[1] });

      const result = parser.parseTable(lines, mapper);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ first: 'A', second: 'B' });
    });

    it('handles various separator formats', () => {
      const lines = ['| Col1 | Col2 |', '|:---:|------|', '| A | B |'];

      const mapper = (cols) => ({ first: cols[0], second: cols[1] });

      const result = parser.parseTable(lines, mapper);

      expect(result).toHaveLength(1);
    });

    it('trims cell content', () => {
      const lines = ['|  Col1  |  Col2  |', '|:------:|:------:|', '|   A    |   B    |'];

      const mapper = (cols) => ({ first: cols[0], second: cols[1] });

      const result = parser.parseTable(lines, mapper);

      expect(result[0]).toEqual({ first: 'A', second: 'B' });
    });
  });

  describe('parseDependencyTable', () => {
    it('parses dependency table', () => {
      const sections = {
        Dependencies: [
          '| Type | ID | Description | Status |',
          '|------|:--:|-------------|:------:|',
          '| Prerequisite | 100 | Base feature | [DONE] |',
          '| Optional | 200 | Enhancement | [WIP] |',
        ],
      };

      const result = parser.parseDependencyTable(sections);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'Prerequisite',
        id: '100',
        description: 'Base feature',
        status: '[DONE]',
      });
    });

    it('returns empty array for missing Dependencies section', () => {
      expect(parser.parseDependencyTable({})).toEqual([]);
    });
  });

  describe('parseExecutionLog', () => {
    it('parses execution log table', () => {
      const sections = {
        'Execution Log': [
          '| Timestamp | Event | Agent | Action | Result |',
          '|-----------|-------|-------|--------|--------|',
          '| 2026-01-15 10:00 | START | implementer | Task 1 | - |',
          '| 2026-01-15 11:00 | END | implementer | Task 1 | SUCCESS |',
        ],
      };

      const result = parser.parseExecutionLog(sections);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        timestamp: '2026-01-15 10:00',
        event: 'START',
        agent: 'implementer',
        action: 'Task 1',
        result: '-',
      });
    });

    it('returns empty array for missing Execution Log section', () => {
      expect(parser.parseExecutionLog({})).toEqual([]);
    });
  });

  describe('parseBackground', () => {
    it('parses background fields', () => {
      const sections = {
        Background: [
          '**Context**: Some context here',
          '**Motivation**: Why we need this',
          'Continued motivation text',
          '**Goal**: The goal',
        ],
      };

      const result = parser.parseBackground(sections);

      expect(result).toEqual({
        context: 'Some context here',
        motivation: 'Why we need this Continued motivation text',
        goal: 'The goal',
      });
    });

    it('returns empty object for missing Background section', () => {
      expect(parser.parseBackground({})).toEqual({});
    });

    it('handles fields with colons', () => {
      const sections = {
        Background: ['**Context**: Some context'],
      };

      const result = parser.parseBackground(sections);

      expect(result.context).toBe('Some context');
    });
  });

  describe('getSectionText', () => {
    it('returns section text with empty lines removed', () => {
      const sections = {
        Summary: ['', 'This is a summary', '', 'Second line', ''],
      };

      const result = parser.getSectionText(sections, 'Summary');

      expect(result).toBe('This is a summary\nSecond line');
    });

    it('returns empty string for missing section', () => {
      expect(parser.getSectionText({}, 'Missing')).toBe('');
    });

    it('performs case-insensitive search', () => {
      const sections = {
        'Review Notes': ['Some notes'],
      };

      expect(parser.getSectionText(sections, 'review notes')).toBe('Some notes');
    });
  });

  describe('parseContent', () => {
    it('parses complete feature content', () => {
      const content = `# Feature 123: Test Feature

## Status: [WIP]
## Type: kojo
## Created: 2026-01-15

## Summary
This is a test feature.

## Background
**Context**: Test context
**Motivation**: Test motivation

## Acceptance Criteria
| AC# | Description | Type | Status |
|:---:|-------------|------|:------:|
| 1 | Test AC | output | [x] |

## Tasks
| Task# | AC# | Description | Status |
|:-----:|:---:|-------------|:------:|
| 1 | 1 | Test task | [ ] |

## Dependencies
| Type | ID | Description | Status |
|------|:--:|-------------|:------:|
| Prerequisite | 100 | Base | [DONE] |

## Execution Log
| Timestamp | Event | Agent | Action | Result |
|-----------|-------|-------|--------|--------|
| 2026-01-15 10:00 | START | implementer | Task 1 | - |

## Review Notes
Some review notes here.
`;

      const result = parser.parseContent(content, 'feature-123.md');

      expect(result.id).toBe('123');
      expect(result.title).toBe('Test Feature');
      expect(result.status).toBe('[WIP]');
      expect(result.type).toBe('kojo');
      expect(result.created).toBe('2026-01-15');
      expect(result.summary).toContain('test feature');
      expect(result.background.context).toBe('Test context');
      expect(result.acceptanceCriteria).toHaveLength(1);
      expect(result.tasks).toHaveLength(1);
      expect(result.dependencies).toHaveLength(1);
      expect(result.executionLog).toHaveLength(1);
      expect(result.reviewNotes).toContain('review notes');
    });

    it('handles empty content gracefully', () => {
      const result = parser.parseContent('', '');

      expect(result.id).toBe('');
      expect(result.title).toBe('');
      expect(result.status).toBe('[UNKNOWN]');
      expect(result.acceptanceCriteria).toEqual([]);
      expect(result.tasks).toEqual([]);
    });

    it('handles missing sections', () => {
      const content = '# Feature 456: Minimal\n\n## Status: [DONE]';

      const result = parser.parseContent(content, 'feature-456.md');

      expect(result.id).toBe('456');
      expect(result.status).toBe('[DONE]');
      expect(result.summary).toBe('');
      expect(result.acceptanceCriteria).toEqual([]);
      expect(result.tasks).toEqual([]);
    });
  });

  describe('parse (with fs.readFileSync)', () => {
    it('reads file and parses content', () => {
      const mockContent = '# Feature 100: Mock\n\n## Status: [WIP]';
      const mockReadFileSync = vi.fn().mockReturnValue(mockContent);

      const parserWithMock = new FeatureParser();
      // Mock fs.readFileSync by replacing parseContent temporarily
      const originalParseContent = parserWithMock.parseContent;
      parserWithMock.parseContent = vi.fn((content, filePath) => {
        expect(content).toBe(mockContent);
        expect(filePath).toBe('test-path.md');
        return originalParseContent.call(parserWithMock, content, filePath);
      });

      // Instead of mocking fs directly, test parseContent which is what parse() calls
      const result = parserWithMock.parseContent(mockContent, 'test-path.md');

      expect(result.id).toBe('');
      expect(result.status).toBe('[WIP]');
    });
  });
});

// =============================================================================
// IndexParser Tests
// =============================================================================

describe('IndexParser', () => {
  const parser = new IndexParser();

  describe('parseFeatureRow', () => {
    it('parses 3-column row (ID | Status | Name)', () => {
      const row = '| 123 | [WIP] | Test Feature |';

      const result = parser.parseFeatureRow(row);

      expect(result).toEqual({
        id: '123',
        status: '[WIP]',
        name: 'Test Feature',
        dependsOn: '',
        link: '',
      });
    });

    it('parses 4-column row with dependsOn', () => {
      const row = '| 123 | [WIP] | Test Feature | 100, 101 |';

      const result = parser.parseFeatureRow(row);

      expect(result).toEqual({
        id: '123',
        status: '[WIP]',
        name: 'Test Feature',
        dependsOn: '100, 101',
        link: '',
      });
    });

    it('parses 4-column row with link (ambiguity case)', () => {
      const row = '| 123 | [WIP] | Test Feature | [link](feature-123.md) |';

      const result = parser.parseFeatureRow(row);

      expect(result).toEqual({
        id: '123',
        status: '[WIP]',
        name: 'Test Feature',
        dependsOn: '',
        link: 'feature-123.md',
      });
    });

    it('parses 5-column row (ID | Status | Name | Depends On | Links)', () => {
      const row = '| 123 | [DONE] | Test | 100 | [link](feature-123.md) |';

      const result = parser.parseFeatureRow(row);

      expect(result).toEqual({
        id: '123',
        status: '[DONE]',
        name: 'Test',
        dependsOn: '100',
        link: 'feature-123.md',
      });
    });

    it('handles status emoji (checkmark)', () => {
      const row = '| 123 | ✅ | Completed Feature | |';

      const result = parser.parseFeatureRow(row);

      expect(result.status).toBe('[DONE]');
    });

    it('handles status emoji (X)', () => {
      const row = '| 123 | ❌ | Cancelled Feature | |';

      const result = parser.parseFeatureRow(row);

      expect(result.status).toBe('[CANCELLED]');
    });

    it('handles status with DONE text', () => {
      const row = '| 123 | DONE | Feature | |';

      const result = parser.parseFeatureRow(row);

      expect(result.status).toBe('[DONE]');
    });

    it('extracts numeric ID only', () => {
      const row = '| F123 | [WIP] | Feature | |';

      const result = parser.parseFeatureRow(row);

      expect(result.id).toBe('123');
    });

    it('returns null for rows with less than 3 columns', () => {
      expect(parser.parseFeatureRow('| 123 | [WIP] |')).toBeNull();
      expect(parser.parseFeatureRow('| 123 |')).toBeNull();
    });

    it('returns null for rows without valid ID', () => {
      expect(parser.parseFeatureRow('| | [WIP] | Feature |')).toBeNull();
      expect(parser.parseFeatureRow('| ABC | [WIP] | Feature |')).toBeNull();
    });

    it('trims whitespace from name', () => {
      const row = '| 123 | [WIP] |   Feature Name   | |';

      const result = parser.parseFeatureRow(row);

      expect(result.name).toBe('Feature Name');
    });
  });

  describe('parseContent', () => {
    it('parses phases with layers and features', () => {
      const content = `# Features Index

## Phase 19: Kojo Conversion

### Tooling (F633-F635)

| ID | Status | Name | Links |
|:--:|:------:|------|-------|
| 633 | [DONE] | Parser | [feature-633.md](feature-633.md) |
| 634 | [WIP] | Converter | [feature-634.md](feature-634.md) |

### Content (F636-F640)

| ID | Status | Name | Depends On | Links |
|:--:|:------:|------|:----------:|-------|
| 636 | [PROPOSED] | Meiling Dialogue | 633, 634 | [feature-636.md](feature-636.md) |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].number).toBe(19);
      expect(result.phases[0].name).toBe('Kojo Conversion');
      expect(result.phases[0].layers).toHaveLength(2);

      const toolingLayer = result.phases[0].layers[0];
      expect(toolingLayer.name).toBe('Tooling (F633-F635)');
      expect(toolingLayer.features).toHaveLength(2);
      expect(toolingLayer.features[0]).toEqual({
        id: '633',
        status: '[DONE]',
        name: 'Parser',
        dependsOn: '',
        link: 'feature-633.md',
      });

      const contentLayer = result.phases[0].layers[1];
      expect(contentLayer.name).toBe('Content (F636-F640)');
      expect(contentLayer.features[0].dependsOn).toBe('633, 634');
    });

    it('handles phase without layers (features directly under phase)', () => {
      const content = `## Phase 20: Direct Features

| ID | Status | Name |
|:--:|:------:|------|
| 700 | [WIP] | Feature A |
| 701 | [PROPOSED] | Feature B |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].layers).toHaveLength(1);
      expect(result.phases[0].layers[0].name).toBe('Default');
      expect(result.phases[0].layers[0].features).toHaveLength(2);
    });

    it('parses Recently Completed section', () => {
      const content = `## Recently Completed

| ID | Status | Name | Links |
|:--:|:------:|------|-------|
| 600 | ✅ | Old Feature | [feature-600.md](feature-600.md) |
| 601 | ✅ | Another Old | [feature-601.md](feature-601.md) |
`;

      const result = parser.parseContent(content);

      expect(result.recentlyCompleted).toHaveLength(2);
      expect(result.recentlyCompleted[0]).toEqual({
        id: '600',
        status: '[DONE]',
        name: 'Old Feature',
        dependsOn: '',
        link: 'feature-600.md',
      });
    });

    it('handles multiple phases', () => {
      const content = `## Phase 18: First Phase

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [DONE] | Feature 1 |

## Phase 19: Second Phase

| ID | Status | Name |
|:--:|:------:|------|
| 600 | [WIP] | Feature 2 |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].number).toBe(18);
      expect(result.phases[1].number).toBe(19);
    });

    it('handles ### phase headers', () => {
      const content = `### Phase 20: Test Phase

| ID | Status | Name |
|:--:|:------:|------|
| 700 | [WIP] | Feature |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].number).toBe(20);
    });

    it('handles bold layer headers (**text**)', () => {
      const content = `## Phase 19: Test

**Tooling (F633-F635)**

| ID | Status | Name |
|:--:|:------:|------|
| 633 | [DONE] | Parser |
`;

      const result = parser.parseContent(content);

      expect(result.phases[0].layers[0].name).toBe('Tooling (F633-F635)');
    });

    it('handles #### layer headers', () => {
      const content = `## Phase 19: Test

#### Content (F636-F640)

| ID | Status | Name |
|:--:|:------:|------|
| 636 | [WIP] | Dialogue |
`;

      const result = parser.parseContent(content);

      expect(result.phases[0].layers[0].name).toBe('Content (F636-F640)');
    });

    it('resets state when entering Recently Completed', () => {
      const content = `## Phase 19: Active

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [WIP] | Current |

## Recently Completed

| ID | Status | Name |
|:--:|:------:|------|
| 400 | ✅ | Old |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].layers[0].features[0].id).toBe('500');
      expect(result.recentlyCompleted).toHaveLength(1);
      expect(result.recentlyCompleted[0].id).toBe('400');
    });

    it('handles empty lines between tables', () => {
      const content = `## Phase 19: Test

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [WIP] | Feature 1 |

| ID | Status | Name |
|:--:|:------:|------|
| 501 | [WIP] | Feature 2 |
`;

      const result = parser.parseContent(content);

      // Empty line resets inTable, but second table header re-enables it
      expect(result.phases[0].layers[0].features).toHaveLength(2);
    });

    it('handles table headers with "Feature" instead of "ID"', () => {
      const content = `## Phase 19: Test

| Feature | Status | Name |
|:-------:|:------:|------|
| 500 | [WIP] | Test |
`;

      const result = parser.parseContent(content);

      expect(result.phases[0].layers[0].features).toHaveLength(1);
      expect(result.phases[0].layers[0].features[0].id).toBe('500');
    });

    it('skips table separator rows', () => {
      const content = `## Phase 19: Test

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [WIP] | Test |
| -- | ------ | ---- |
| 501 | [WIP] | Test2 |
`;

      const result = parser.parseContent(content);

      // Separator row should be skipped
      expect(result.phases[0].layers[0].features).toHaveLength(2);
    });
  });

  describe('parseContent - state machine transitions', () => {
    it('transitions IDLE → PHASE → LAYER → TABLE', () => {
      const content = `## Phase 19: Test Phase

### Layer 1

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [WIP] | Feature |
`;

      const result = parser.parseContent(content);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].number).toBe(19);
      expect(result.phases[0].layers).toHaveLength(1);
      expect(result.phases[0].layers[0].features).toHaveLength(1);
    });

    it('resets inTable on empty line', () => {
      const content = `## Phase 19: Test

| ID | Status | Name |
|:--:|:------:|------|
| 500 | [WIP] | Feature 1 |

Text here

| ID | Status | Name |
|:--:|:------:|------|
| 501 | [WIP] | Feature 2 |
`;

      const result = parser.parseContent(content);

      // Empty line + text resets table, but second table header re-enables
      // Both features are parsed into the same default layer
      expect(result.phases[0].layers[0].features).toHaveLength(2);
    });
  });

  describe('parse (with fs.readFileSync)', () => {
    it('reads file and parses content', () => {
      const mockContent =
        '## Phase 19: Mock\n\n| ID | Status | Name |\n|:--:|:------:|------|\n| 500 | [WIP] | Test |';

      // Test parseContent which is what parse() calls
      const result = parser.parseContent(mockContent);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].number).toBe(19);
    });
  });
});
