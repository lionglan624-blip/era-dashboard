import { Router } from 'express';

export function createFeaturesRouter(featureService) {
  const router = Router();

  // GET /api/features - List all features with progress
  router.get('/', (req, res) => {
    try {
      const { features, index } = featureService.getAllFeatures();
      res.json({ features, phases: index.phases });
    } catch (err) {
      console.error('Error fetching features:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/features/:id - Feature detail
  router.get('/:id', (req, res) => {
    try {
      const feature = featureService.getFeature(req.params.id);
      if (!feature) {
        return res.status(404).json({ error: 'Feature not found' });
      }
      res.json(feature);
    } catch (err) {
      console.error(`Error fetching feature ${req.params.id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
