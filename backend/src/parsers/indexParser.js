import fs from 'fs';

/**
 * Parse index-features.md into structured JSON.
 * Uses a state machine approach: IDLE → PHASE → LAYER → TABLE
 */
export class IndexParser {
  parse(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseContent(content);
  }

  parseContent(content) {
    const lines = content.split('\n');
    const phases = [];
    const recentlyCompleted = [];
    let currentPhase = null;
    let currentLayer = null;
    let inTable = false;
    let inRecentlyCompleted = false;
    let seenPhase = false; // True after first "Phase N:" header (inside Active Features)

    for (const line of lines) {
      const trimmed = line.trim();

      // Phase header: ## Phase 19: Kojo Conversion or ### Phase 19:
      const phaseMatch = trimmed.match(/^#{2,3}\s+Phase\s+(\d+)[:\s]+(.*)/i);
      if (phaseMatch) {
        currentPhase = {
          number: parseInt(phaseMatch[1]),
          name: phaseMatch[2].trim(),
          layers: [],
        };
        phases.push(currentPhase);
        currentLayer = null;
        inTable = false;
        inRecentlyCompleted = false;
        seenPhase = true;
        continue;
      }

      // Recently Completed section
      if (/^#{2,3}\s+Recently Completed/i.test(trimmed)) {
        inRecentlyCompleted = true;
        currentPhase = null;
        currentLayer = null;
        inTable = false;
        continue;
      }

      // Non-phase section header: ### Other, ### Infrastructure, etc.
      // Only active after first Phase header (avoids matching doc structure headings)
      // Matches short alphabetic-only headings (no digits, parens, or colons)
      // to distinguish from layer headers like "### Tooling (F633-F635)" or "### Layer 1"
      const sectionMatch =
        seenPhase &&
        !inRecentlyCompleted &&
        trimmed.match(/^#{2,3}\s+(?!Phase\b|Recently\b)([A-Za-z]+(?: [A-Za-z]+)*)$/i);
      if (sectionMatch) {
        currentPhase = {
          number: null,
          name: sectionMatch[1].trim(),
          layers: [],
        };
        phases.push(currentPhase);
        currentLayer = null;
        inTable = false;
        inRecentlyCompleted = false;
        continue;
      }

      // Layer header: ### Tooling (F633-F635) or bold text **Tooling (F633-F635)**
      const layerMatch = trimmed.match(/^(?:#{3,4}\s+|\*\*)(.*?)(?:\*\*)?$/);
      if (layerMatch && !trimmed.startsWith('| ') && currentPhase && !inRecentlyCompleted) {
        const layerName = layerMatch[1].replace(/\*\*/g, '').trim();
        if (layerName && !layerName.startsWith('Phase') && !layerName.startsWith('|')) {
          currentLayer = { name: layerName, features: [] };
          currentPhase.layers.push(currentLayer);
          inTable = false;
          continue;
        }
      }

      // Table header detection
      if (trimmed.startsWith('| ID') || trimmed.startsWith('| Feature')) {
        inTable = true;
        continue;
      }

      // Table separator
      if (trimmed.startsWith('|:') || trimmed.startsWith('|--') || trimmed.startsWith('| --')) {
        continue;
      }

      // Table row
      if (inTable && trimmed.startsWith('|')) {
        const feature = this.parseFeatureRow(trimmed);
        if (feature) {
          if (inRecentlyCompleted) {
            recentlyCompleted.push(feature);
          } else if (currentLayer) {
            currentLayer.features.push(feature);
          } else if (currentPhase) {
            // No layer, add directly to phase with default layer
            if (currentPhase.layers.length === 0) {
              currentPhase.layers.push({ name: 'Default', features: [] });
            }
            currentPhase.layers[currentPhase.layers.length - 1].features.push(feature);
          }
        }
        continue;
      }

      // Empty line resets table state
      if (trimmed === '') {
        inTable = false;
      }
    }

    return { phases, recentlyCompleted };
  }

  parseFeatureRow(line) {
    const cols = line
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (cols.length < 3) return null;

    const id = cols[0].replace(/\D/g, '');
    if (!id) return null;

    // Status: [WIP], [DONE], ✅, ❌, etc.
    const statusRaw = cols[1];
    let status;
    if (statusRaw.includes('✅') || statusRaw.includes('DONE')) {
      status = '[DONE]';
    } else if (statusRaw.includes('❌')) {
      status = '[CANCELLED]';
    } else {
      const statusMatch = statusRaw.match(/\[(\w+)\]/);
      status = statusMatch ? `[${statusMatch[1]}]` : statusRaw;
    }

    const name = cols[2] || '';

    // Link (last column)
    const linkCol = cols[cols.length - 1];
    const linkMatch = linkCol.match(/\[.*?\]\((.*?)\)/);
    const link = linkMatch ? linkMatch[1] : '';

    // Dependencies (column 3 if it exists and is NOT the link column)
    let dependsOn = '';
    if (cols.length > 4) {
      // 5+ cols: ID | Status | Name | Depends On | Links
      dependsOn = cols[3] || '';
    } else if (cols.length === 4) {
      // 4 cols: could be with or without Depends On
      // If col[3] contains a markdown link, it's the Links column, not dependsOn
      if (!cols[3].match(/\[.*?\]\(.*?\)/)) {
        dependsOn = cols[3] || '';
      }
    }

    return {
      id,
      status,
      name: name.trim(),
      dependsOn: dependsOn.trim(),
      link,
    };
  }
}
