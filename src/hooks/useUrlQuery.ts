import { useEffect } from 'react';
import { useScrimbaUrlLoader } from './useScrimbaUrlLoader';

export const useUrlQuery = () => {
  const { fetchScrimbaFile, isLoading } = useScrimbaUrlLoader();

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const scrimUrl = urlParams.get('scrimUrl');

    if (scrimUrl) {
      // Decode URL in case it was URL encoded
      const decodedUrl = decodeURIComponent(scrimUrl);
      fetchScrimbaFile(decodedUrl).catch(error => {
        console.error('Failed to load scrim from URL query:', error);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  return { isLoading };
};