import React, { useState } from 'react';
import FeatureTile from './FeatureTile.jsx';

export default function PhaseSection({
  phase,
  features,
  runningFeatures,
  queuedFeatures,
  onRunCommand,
  onSelect,
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Group features by layer
  const layers = {};
  for (const f of features) {
    const layer = f.layer || 'Default';
    if (!layers[layer]) layers[layer] = [];
    layers[layer].push(f);
  }

  const totalFeatures = features.length;
  const doneCount = features.filter((f) => f.status === '[DONE]').length;

  return (
    <section className="phase-section">
      <header className="phase-header" onClick={() => setCollapsed(!collapsed)}>
        <h2>
          <span className="collapse-icon">{collapsed ? '▶' : '▼'}</span>
          Phase {phase.number}: {phase.name}
        </h2>
        <span className="phase-count">
          {doneCount}/{totalFeatures}
        </span>
      </header>

      {!collapsed && (
        <div className="phase-body">
          {Object.entries(layers).map(([layerName, layerFeatures]) => (
            <div key={layerName} className="layer-group">
              <h3 className="layer-name">{layerName}</h3>
              <div className="tile-grid">
                {layerFeatures.map((f) => (
                  <FeatureTile
                    key={f.id}
                    feature={f}
                    isRunning={runningFeatures.has(f.id)}
                    isQueued={queuedFeatures.has(f.id)}
                    onRunCommand={onRunCommand}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
