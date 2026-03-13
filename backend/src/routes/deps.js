import { Router } from 'express';

export function createDepsRouter(depUpdaterService) {
  const router = Router();

  // POST /api/deps/trigger — manually trigger a tier
  router.post('/trigger', async (req, res) => {
    const { tier } = req.body || {};
    const validTiers = ['daily', 'weekly', 'monthly', 'all'];
    if (!tier || !validTiers.includes(tier)) {
      return res
        .status(400)
        .json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
    }

    if (tier === 'all') {
      // Run all tiers sequentially
      const running = ['daily', 'weekly', 'monthly'].filter(
        (t) => depUpdaterService.getStatus()[t]?.running,
      );
      if (running.length > 0) {
        return res.status(409).json({ error: `Tiers already running: ${running.join(', ')}` });
      }
      // Fire-and-forget
      (async () => {
        for (const t of ['daily', 'weekly', 'monthly']) {
          try {
            await depUpdaterService.triggerTier(t);
          } catch (_err) {
            // logged inside service
          }
        }
      })();
      return res.json({ ok: true, message: 'All tiers triggered' });
    }

    try {
      // Fire-and-forget (don't await — can take hours for idle wait)
      depUpdaterService.triggerTier(tier).catch(() => {});
      res.json({ ok: true, message: `Tier ${tier} triggered` });
    } catch (err) {
      if (err.message.includes('already running')) {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/deps/status — current status of all tiers
  router.get('/status', (req, res) => {
    res.json(depUpdaterService.getStatus());
  });

  return router;
}
