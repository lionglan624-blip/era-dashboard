import { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api';

export function useFeatures() {
  const [features, setFeatures] = useState([]);
  const [phases, setPhases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchFeatures = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/features`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFeatures(data.features || []);
      setPhases(data.phases || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  return { features, phases, loading, error, refetch: fetchFeatures };
}

export function useFeatureDetail(id) {
  const [feature, setFeature] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) {
      setFeature(null);
      return;
    }
    setLoading(true);
    fetch(`${API_BASE}/features/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setFeature(data);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  return { feature, loading, error };
}
